/**
 * Ergonomic tool authoring on top of `ToolDef` — turning "I have an API" into
 * "I have an MCP tool" without hand-rolling validation or fetch plumbing.
 *
 * `inputSchema` (JSON Schema) stays required: it's what `tools/list` actually
 * advertises to clients, and no library-agnostic way exists to derive it from
 * an arbitrary Standard Schema validator. `input`, when supplied, is what
 * actually parses and types `args` at call time — keep the two in sync.
 */

import { pickDefined } from "../../util/defined.js";
import type { ToolDef, ToolResult } from "../registry.js";
import type { JsonSchema } from "../validate.js";
import { issuesResult, parseWithSchema, type StandardSchemaV1 } from "./standard-schema.js";

export type ToolCore = {
  name: string;
  description: string;
  /** Advertised via tools/list. Required — see module doc for why. */
  inputSchema: JsonSchema;
  /** See `ToolDef.scope` — pass `null` to explicitly opt out of a scope check. */
  scope?: string | null | undefined;
};

type TypedToolHandler<TCtx, Args> = (
  ctx: TCtx,
  args: Args,
) => Promise<ToolResult | string> | ToolResult | string;

export type ValidatedInput<Input> = {
  /** Standard Schema v1 validator. Parsed and typed before `handler` runs. */
  input: StandardSchemaV1<unknown, Input>;
};

export type RawInput = { input?: undefined };

export type DefineToolOptions<TCtx, Input = Record<string, unknown>> =
  | (ToolCore & ValidatedInput<Input> & { handler: TypedToolHandler<TCtx, Input> })
  | (ToolCore & RawInput & { handler: TypedToolHandler<TCtx, Record<string, unknown>> });

/**
 * A `ToolDef` with typed, validated `args` — drop straight into
 * `createToolRegistry` / `createMcpApp`'s `tools` array like any other tool.
 */
export const defineTool = <TCtx, Input = Record<string, unknown>>(
  options: DefineToolOptions<TCtx, Input>,
): ToolDef<TCtx> => ({
  name: options.name,
  description: options.description,
  inputSchema: options.inputSchema,
  ...pickDefined(options, ["scope"]),
  handler: async (ctx, rawArgs) => {
    if (!options.input) return options.handler(ctx, rawArgs);
    const parsed = await parseWithSchema(options.input, rawArgs);
    if ("issues" in parsed) return issuesResult(parsed.issues);
    return options.handler(ctx, parsed.value);
  },
});
