import { pickDefined } from "../util/defined.js";
import { argsRejection } from "./schema/custom/run.js";
import type { JsonSchema, SchemaValidator } from "./schema/types.js";
import type { ToolResult } from "./tools/content.js";
import { annotationViolations, type ToolAnnotations } from "./tools/wire/annotations.js";
import { assertToolSchemasValid } from "./tools/wire/args-schema.js";
import { asToolResult, errorResult, resolveToolError } from "./tools/wire/outcome.js";
import { checkedOutput, outputSchemaViolations } from "./tools/wire/output.js";
import { paramHeaderViolations } from "./tools/wire/param-schema.js";
import { toolListMeta, toolUiViolations } from "./ui/registry.js";
import type { ToolUi } from "./ui/types.js";

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
  /**
   * JSON Schema (2020-12) of the tool's `structuredContent`, listed in `tools/list`. The root may
   * be any type, not only `"object"`; a client on a protocol version before 2026-07-28 is only
   * shown an `"object"` root. While `validateOutput` is on, a result that is not `isError` must
   * carry a `structuredContent` that conforms, or the client gets "Tool returned an invalid result".
   */
  outputSchema?: JsonSchema | undefined;
  /**
   * Hints listed in `tools/list`. Untrusted by clients, and never used by this library to
   * authorize a call or pick a scope: see `ToolAnnotations`.
   */
  annotations?: ToolAnnotations | undefined;
  /**
   * MCP Apps: the UI a host renders for this tool's result. The resource
   * must be registered in `uiResources`. A host without MCP Apps ignores it
   * and shows the result's `content` text.
   */
  ui?: ToolUi | undefined;
  handler: ToolHandler<TCtx>;
};

export type ToolListEntry = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
  _meta?: { ui: ToolUi };
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
  /** `withUi: false` omits `_meta.ui` (a client that did not declare MCP Apps); default `true`. */
  list: (
    allowScope?: (scope: string | null | undefined) => boolean,
    withUi?: boolean,
  ) => ToolListEntry[];
  get: (name: string) => ToolDef<TCtx> | undefined;
  call: (name: string, ctx: TCtx, args: Record<string, unknown>) => Promise<ToolResult>;
};

export type RegistryOptions = {
  /**
   * Validate tools/call args against inputSchema. Default **true** since 2.0 —
   * forgetting this was a silent injection path into handlers. Set `false`
   * only when you intentionally skip schema checks.
   */
  validateArgs?: boolean | undefined;
  /**
   * Map tool exceptions to client-visible text.
   * Default: `"Tool execution failed"` (no exception leakage).
   */
  onToolError?: ((error: unknown) => string) | undefined;
  /**
   * Check a successful result against the tool's `outputSchema`. Default: the value of
   * `validateArgs` (**true**). A result without a conforming `structuredContent` is replaced by
   * the generic error "Tool returned an invalid result": neither the violations nor the data
   * reach the client, since they may hold another tenant's data. An `isError` result is not checked.
   */
  validateOutput?: boolean | undefined;
  /**
   * Called with the tool name and why its result was rejected, so the developer can log it.
   * The violations can contain the result's data: keep them out of client-visible output.
   * A hook that throws, or returns a promise that rejects, never fails the call.
   */
  onOutputViolation?: ((tool: string, violations: string[]) => void) | undefined;
  /**
   * Replaces the built-in JSON Schema evaluator for every `inputSchema` and `outputSchema`, for
   * a schema it does not cover (`unevaluatedProperties`, `format`, a risky `pattern`): wrap Ajv
   * or similar. The construction-time keyword, `pattern` and object-type checks are skipped, so
   * the schemas are yours to vet. It runs only while `validateArgs` / `validateOutput` are on.
   * One that throws, or returns anything but an array of strings, fails closed: the client gets
   * "Invalid arguments" or "Tool returned an invalid result", never the thrown message.
   */
  schemaValidator?: SchemaValidator | undefined;
};

/** The `RegistryOptions` that `createMcpApp` takes under the same name. */
export const REGISTRY_OPTION_KEYS = [
  "validateArgs",
  "validateOutput",
  "onToolError",
  "onOutputViolation",
  "schemaValidator",
] as const satisfies readonly (keyof RegistryOptions)[];

const throwIfAny = (violations: string[], heading: string, fix: string): void => {
  if (violations.length > 0) throw new Error(`${heading}\n${violations.join("\n")}\n${fix}`);
};

export const createToolRegistry = <TCtx>(
  tools: ToolDef<TCtx>[],
  options: RegistryOptions = {},
): ToolRegistry<TCtx> => {
  const byName = new Map(tools.map((t) => [t.name, t]));
  if (byName.size !== tools.length) {
    throw new Error("duplicate tool names in registry");
  }

  const uiViolations = toolUiViolations(tools);
  if (uiViolations.length > 0) throw new Error(`invalid tool ui:\n${uiViolations.join("\n")}`);
  throwIfAny(annotationViolations(tools), "invalid tool annotations:", "Fix the annotation.");
  throwIfAny(paramHeaderViolations(tools), "invalid x-mcp-header:", "Fix the annotation.");

  const validateArgs = options.validateArgs !== false;
  if (validateArgs && !options.schemaValidator) assertToolSchemasValid(tools);
  const validateOutput = options.validateOutput ?? validateArgs;
  if (validateOutput) {
    throwIfAny(
      outputSchemaViolations(tools, options.schemaValidator === undefined),
      "validateOutput: true but outputSchema is not usable:",
      "Fix the outputSchema, or set validateOutput: false",
    );
  }

  return {
    list: (allowScope, withUi = true) =>
      tools
        .filter((tool) => !allowScope || allowScope(tool.scope))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...pickDefined(tool, ["outputSchema", "annotations"]),
          ...(withUi && tool.ui !== undefined ? { _meta: toolListMeta(tool.ui) } : {}),
        })),

    get: (name) => byName.get(name),

    call: async (name, ctx, args) => {
      const tool = byName.get(name);
      if (!tool) return errorResult(`Unknown tool: ${name}`);

      if (validateArgs) {
        const rejection = argsRejection(args, tool.inputSchema, options.schemaValidator);
        if (rejection !== undefined) return errorResult(rejection);
      }

      try {
        const result = asToolResult(await tool.handler(ctx, args));
        return validateOutput
          ? checkedOutput(tool, result, options.onOutputViolation, options.schemaValidator)
          : result;
      } catch (caught) {
        return errorResult(resolveToolError(caught, options.onToolError));
      }
    },
  };
};
