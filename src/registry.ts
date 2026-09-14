import type { JsonSchema } from "./validate.js";
import { missingObjectType, unsupportedKeywords, validateAgainstSchema } from "./validate.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean | undefined;
};

export type ToolHandler<TCtx> = (
  ctx: TCtx,
  args: Record<string, unknown>,
) => Promise<ToolResult | string> | ToolResult | string;

export type ToolDef<TCtx> = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /**
   * Required scope, or `undefined`/omitted for "any authenticated
   * principal, whatever its scopes." On a `createMcpApp` server advertising
   * more than one scope, an omitted `scope` is a construction-time error —
   * see `assertToolScopesConfigured` — precisely because "any authenticated
   * principal" silently includes a principal with zero scopes, which is
   * rarely the intent on a multi-scope server. Pass `scope: null` to state
   * that intentionally instead of by omission.
   */
  scope?: string | null | undefined;
  handler: ToolHandler<TCtx>;
};

export type ToolListEntry = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

export type ToolRegistry<TCtx> = {
  /**
   * `allowScope`, when passed, is consulted per tool with that tool's
   * `scope` — omit a tool by returning `false`. Lets a caller (see
   * `McpHandlerOptions.hideToolsOutsideScope`) filter `tools/list` by a
   * principal's granted scopes without the registry itself knowing what a
   * "principal" or "scope check" is — it only ever sees the raw `scope`
   * value already on each `ToolDef`.
   */
  list: (allowScope?: (scope: string | null | undefined) => boolean) => ToolListEntry[];
  get: (name: string) => ToolDef<TCtx> | undefined;
  call: (name: string, ctx: TCtx, args: Record<string, unknown>) => Promise<ToolResult>;
};

export type RegistryOptions = {
  /** Validate tools/call args against inputSchema. Default false. */
  validateArgs?: boolean | undefined;
  /**
   * Map tool exceptions to client-visible text.
   * Default: `"Tool execution failed"` (no exception leakage).
   */
  onToolError?: ((exc: unknown) => string) | undefined;
};

const DEFAULT_TOOL_ERROR = "Tool execution failed";

/**
 * Map a tool exception to client-visible text.
 * A throwing or non-string `onToolError` falls back to the redacted default —
 * a mapper must never turn a tool failure into a transport failure.
 */
const resolveToolError = (exc: unknown, onToolError: RegistryOptions["onToolError"]): string => {
  if (!onToolError) return DEFAULT_TOOL_ERROR;
  try {
    const mapped = onToolError(exc);
    return typeof mapped === "string" && mapped.length > 0 ? mapped : DEFAULT_TOOL_ERROR;
  } catch {
    return DEFAULT_TOOL_ERROR;
  }
};

const asToolResult = (out: ToolResult | string): ToolResult => {
  if (typeof out === "string") {
    return { content: [{ type: "text", text: out }], isError: false };
  }
  return out;
};

const errorResult = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

export const createToolRegistry = <TCtx>(
  tools: ToolDef<TCtx>[],
  options: RegistryOptions = {},
): ToolRegistry<TCtx> => {
  const byName = new Map(tools.map((t) => [t.name, t]));
  if (byName.size !== tools.length) {
    throw new Error("duplicate tool names in registry");
  }

  if (options.validateArgs) {
    const keywordViolations = tools.flatMap((tool) =>
      unsupportedKeywords(tool.inputSchema).map(
        (path) => `${tool.name}: unsupported JSON Schema keyword at ${path}`,
      ),
    );
    if (keywordViolations.length > 0) {
      throw new Error(
        `validateArgs: true but inputSchema uses unsupported keywords:\n` +
          keywordViolations.join("\n") +
          "\nRemove the keyword, enforce it in the handler, or set validateArgs: false",
      );
    }

    // A schema using `properties`/`required` without declaring `type:
    // "object"` (or a union including it) validates nothing at those
    // nodes — every "supported" keyword is individually fine, so the
    // check above can't catch it. See `missingObjectType`'s docstring.
    const typeViolations = tools.flatMap((tool) =>
      missingObjectType(tool.inputSchema).map(
        (path) => `${tool.name}: ${path} uses properties/required without type: "object"`,
      ),
    );
    if (typeViolations.length > 0) {
      throw new Error(
        `validateArgs: true but inputSchema implies an object shape without declaring it:\n` +
          typeViolations.join("\n") +
          '\nAdd type: "object" (or include it in a union), or set validateArgs: false',
      );
    }
  }

  return {
    list: (allowScope) =>
      tools
        .filter((tool) => !allowScope || allowScope(tool.scope))
        .map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),

    get: (name) => byName.get(name),

    call: async (name, ctx, args) => {
      const tool = byName.get(name);
      if (!tool) return errorResult(`Unknown tool: ${name}`);

      if (options.validateArgs) {
        const errors = validateAgainstSchema(args, tool.inputSchema);
        if (errors.length > 0) return errorResult(errors.join("; "));
      }

      try {
        return asToolResult(await tool.handler(ctx, args));
      } catch (exc) {
        return errorResult(resolveToolError(exc, options.onToolError));
      }
    },
  };
};
