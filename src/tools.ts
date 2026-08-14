/**
 * Ergonomic tool authoring on top of `ToolDef` — turning "I have an API" into
 * "I have an MCP tool" without hand-rolling validation or fetch plumbing.
 *
 * `inputSchema` (JSON Schema) stays required: it's what `tools/list` actually
 * advertises to clients, and no library-agnostic way exists to derive it from
 * an arbitrary Standard Schema validator. `input`, when supplied, is what
 * actually parses and types `args` at call time — keep the two in sync.
 */

import type { JsonSchema } from "./validate.js";
import type { ToolDef, ToolResult } from "./registry.js";

/**
 * Minimal Standard Schema v1 surface (https://standardschema.dev).
 * Any compliant validator works here with zero adapter code. This is a
 * structural type, not a dependency: nothing is imported at runtime.
 */
export type StandardSchemaV1<Input = unknown, Output = Input> = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | { value: Output; issues?: undefined }
      | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<unknown> }> }
      | Promise<
          | { value: Output; issues?: undefined }
          | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<unknown> }> }
        >;
  };
};

type ParseResult<Output> = { value: Output } | { issues: string[] };

const pathToString = (path: ReadonlyArray<unknown> | undefined): string =>
  (path ?? [])
    .map((segment) =>
      segment && typeof segment === "object" && "key" in segment
        ? String((segment as { key: unknown }).key)
        : String(segment),
    )
    .join(".");

const parseWithSchema = async <Output>(
  schema: StandardSchemaV1<unknown, Output>,
  raw: unknown,
): Promise<ParseResult<Output>> => {
  const result = await schema["~standard"].validate(raw);
  const issues = result.issues;
  if (issues?.length) {
    return {
      issues: issues.map((issue) => {
        const path = pathToString(issue.path);
        return path ? `${path}: ${issue.message}` : issue.message;
      }),
    };
  }
  return { value: (result as { value: Output }).value };
};

const issuesResult = (issues: string[]): ToolResult => ({
  content: [{ type: "text", text: issues.join("; ") }],
  isError: true,
});

type ToolCore = {
  name: string;
  description: string;
  /** Advertised via tools/list. Required — see module doc for why. */
  inputSchema: JsonSchema;
  scope?: string;
};

type ToolHandler<TCtx, Args> = (
  ctx: TCtx,
  args: Args,
) => Promise<ToolResult | string> | ToolResult | string;

type ValidatedInput<Input> = {
  /** Standard Schema v1 validator. Parsed and typed before `handler` runs. */
  input: StandardSchemaV1<unknown, Input>;
};

type RawInput = { input?: undefined };

export type DefineToolOptions<TCtx, Input = Record<string, unknown>> =
  | (ToolCore & ValidatedInput<Input> & { handler: ToolHandler<TCtx, Input> })
  | (ToolCore & RawInput & { handler: ToolHandler<TCtx, Record<string, unknown>> });

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
  scope: options.scope,
  handler: async (ctx, rawArgs) => {
    if (!options.input) return options.handler(ctx, rawArgs);
    const parsed = await parseWithSchema(options.input, rawArgs);
    if ("issues" in parsed) return issuesResult(parsed.issues);
    return options.handler(ctx, parsed.value);
  },
});

export type ApiRequest = string | URL | Request;

type ApiExtra<TCtx, Args> = {
  request: (ctx: TCtx, args: Args) => ApiRequest | Promise<ApiRequest>;
  respond?: (res: Response) => Promise<ToolResult | string> | ToolResult | string;
  fetch?: typeof fetch;
};

export type ApiToolOptions<TCtx, Input = Record<string, unknown>> =
  | (ToolCore & ValidatedInput<Input> & ApiExtra<TCtx, Input>)
  | (ToolCore & RawInput & ApiExtra<TCtx, Record<string, unknown>>);

const defaultRespond = (res: Response): Promise<string> => res.text();

const requestFailedResult = async (res: Response): Promise<ToolResult> => {
  const body = (await res.text()).trim();
  const status = [res.status, res.statusText].filter(Boolean).join(" ");
  return {
    content: [
      {
        type: "text",
        text: body
          ? `Request failed: ${status}: ${body}`
          : `Request failed: ${status}`,
      },
    ],
    isError: true,
  };
};

const runApi = async <TCtx, Args>(
  options: ApiExtra<TCtx, Args>,
  ctx: TCtx,
  args: Args,
): Promise<ToolResult | string> => {
  const res = await (options.fetch ?? fetch)(await options.request(ctx, args));
  if (!res.ok) return requestFailedResult(res);
  return (options.respond ?? defaultRespond)(res);
};

/**
 * Wrap a single REST call as an MCP tool in one call: build the request from
 * typed args, run it, and shape the response — no hand-rolled fetch/error
 * plumbing per tool. Built on `defineTool`, so `input` gets the same
 * validation-before-call treatment.
 */
export const apiTool = <TCtx, Input = Record<string, unknown>>(
  options: ApiToolOptions<TCtx, Input>,
): ToolDef<TCtx> => {
  const core = {
    name: options.name,
    description: options.description,
    inputSchema: options.inputSchema,
    scope: options.scope,
  };
  if (options.input) {
    return defineTool<TCtx, Input>({
      ...core,
      input: options.input,
      handler: (ctx, args) => runApi(options, ctx, args),
    });
  }
  return defineTool<TCtx>({
    ...core,
    handler: (ctx, args) => runApi(options, ctx, args),
  });
};
