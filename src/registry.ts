import type { JsonSchema } from "./validate.js";
import { validateAgainstSchema } from "./validate.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export type ToolHandler<TCtx> = (
  ctx: TCtx,
  args: Record<string, unknown>,
) => Promise<ToolResult | string> | ToolResult | string;

export type ToolDef<TCtx> = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  scope?: string;
  handler: ToolHandler<TCtx>;
};

export type ToolListEntry = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

export type ToolRegistry<TCtx> = {
  list: () => ToolListEntry[];
  get: (name: string) => ToolDef<TCtx> | undefined;
  call: (
    name: string,
    ctx: TCtx,
    args: Record<string, unknown>,
  ) => Promise<ToolResult>;
};

export type RegistryOptions = {
  /** Validate tools/call args against inputSchema. Default false. */
  validateArgs?: boolean;
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

  return {
    list: () =>
      tools.map(({ name, description, inputSchema }) => ({
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
        const message = exc instanceof Error ? exc.message : String(exc);
        return errorResult(message);
      }
    },
  };
};
