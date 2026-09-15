/**
 * Ergonomic tool authoring on top of `ToolDef` — turning "I have an API" into
 * "I have an MCP tool" without hand-rolling validation or fetch plumbing.
 *
 * `inputSchema` (JSON Schema) stays required: it's what `tools/list` actually
 * advertises to clients, and no library-agnostic way exists to derive it from
 * an arbitrary Standard Schema validator. `input`, when supplied, is what
 * actually parses and types `args` at call time — keep the two in sync.
 */

import { BodyTooLargeError, DEFAULT_MCP_BODY_LIMIT, readBoundedBytes } from "../http/body.js";
import { pickDefined } from "../util/defined.js";
import type { ToolDef, ToolResult } from "./registry.js";
import type { JsonSchema } from "./validate.js";

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
  /** See `ToolDef.scope` — pass `null` to explicitly opt out of a scope check. */
  scope?: string | null | undefined;
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
  ...pickDefined(options, ["scope"]),
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
  /**
   * Shape a non-2xx response yourself — you get the raw `Response`, so read
   * `res.text()`/`res.json()` if you want the body. Omit for the default:
   * status only, upstream body never forwarded. A returned bare `string` is
   * **not** automatically marked as an error (same as any other tool
   * handler) — return `{ content: [...], isError: true }` explicitly if
   * that's what you want the model to see.
   */
  onError?: (res: Response) => Promise<ToolResult | string> | ToolResult | string;
  fetch?: typeof fetch;
  /**
   * Abort the upstream request after this many ms. Default 30000. An
   * upstream that never responds otherwise hangs the tool call (and the
   * MCP request behind it) indefinitely. Pass `false` to disable — the
   * request then relies entirely on whatever signal (if any) is already on
   * the `Request` your `request` callback returns; a timeout firing surfaces
   * as `isError: true`, not a thrown exception `onToolError` would redact.
   */
  timeoutMs?: number | false;
  /**
   * Cap the upstream response body at this many bytes before it ever
   * reaches `respond`/`onError`/the default error path — an unbounded
   * `res.text()` on an attacker-influenced or merely oversized upstream
   * response is the same memory-exhaustion shape an unbounded *incoming*
   * request body is (see `body.ts`). Default 1 MiB. Exceeding it surfaces
   * as `isError: true`, not a thrown exception `onToolError` would redact.
   */
  maxResponseBytes?: number;
};

export type ApiToolOptions<TCtx, Input = Record<string, unknown>> =
  | (ToolCore & ValidatedInput<Input> & ApiExtra<TCtx, Input>)
  | (ToolCore & RawInput & ApiExtra<TCtx, Record<string, unknown>>);

const defaultRespond = (res: Response): Promise<string> => res.text();

/**
 * Status only — the upstream body is never forwarded by default. This is a
 * return value, not a thrown exception, so `onToolError` redaction never
 * sees it; an upstream error page can echo internal detail, tokens or SQL
 * into the tool result and audit log. Use `onError` to forward (a redacted
 * version of) the body on purpose.
 */
const defaultErrorResult = (res: Response): ToolResult => {
  const status = [res.status, res.statusText].filter(Boolean).join(" ");
  return {
    content: [{ type: "text", text: `Request failed: ${status}` }],
    isError: true,
  };
};

const DEFAULT_API_TOOL_TIMEOUT_MS = 30_000;

const isTimeoutError = (caught: unknown): boolean =>
  caught instanceof Error && caught.name === "TimeoutError";

const timedOutResult = (timeoutMs: number | false): ToolResult => ({
  content: [{ type: "text", text: `Request timed out after ${timeoutMs}ms` }],
  isError: true,
});

/** A timed-out fetch becomes a `ToolResult`; every other throw still propagates. */
const fetchWithTimeout = async (
  fetchImpl: typeof fetch,
  input: ApiRequest,
  timeoutMs: number | false,
): Promise<Response | ToolResult> => {
  try {
    return timeoutMs === false
      ? await fetchImpl(input)
      : await fetchImpl(input, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (caught) {
    if (isTimeoutError(caught)) return timedOutResult(timeoutMs);
    throw caught;
  }
};

/**
 * Capped before `respond`/`onError` ever see it — an unbounded res.text()
 * on the upstream body is the same memory-exhaustion shape an unbounded
 * *incoming* body is (see body.ts). Rebuilt as a fresh Response from the
 * raw bytes — not decoded text — so `respond`/`onError` can still call
 * res.arrayBuffer()/res.blob() on binary bodies as well as res.text()/
 * res.json(), exactly as if they'd read the original response themselves.
 * An oversized body, or the timeout signal firing mid-body, becomes a
 * `ToolResult`; every other throw still propagates.
 */
const boundResponse = async (
  res: Response,
  maxResponseBytes: number,
  timeoutMs: number | false,
): Promise<Response | ToolResult> => {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = (await readBoundedBytes(res, maxResponseBytes)) as Uint8Array<ArrayBuffer>;
  } catch (caught) {
    if (caught instanceof BodyTooLargeError) {
      return {
        content: [{ type: "text", text: `Response exceeded ${maxResponseBytes} bytes` }],
        isError: true,
      };
    }
    // The fetch signal also governs the body stream, so a slow body times out here.
    if (isTimeoutError(caught)) return timedOutResult(timeoutMs);
    throw caught;
  }
  // The buffered body is already decoded and re-framed — the upstream
  // encoding/length headers no longer describe it.
  const headers = new Headers(res.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(bytes, { status: res.status, statusText: res.statusText, headers });
};

const runApi = async <TCtx, Args>(
  options: ApiExtra<TCtx, Args>,
  ctx: TCtx,
  args: Args,
): Promise<ToolResult | string> => {
  const fetchImpl = options.fetch ?? fetch;
  const input = await options.request(ctx, args);
  const timeoutMs = options.timeoutMs ?? DEFAULT_API_TOOL_TIMEOUT_MS;

  const fetched = await fetchWithTimeout(fetchImpl, input, timeoutMs);
  if (!(fetched instanceof Response)) return fetched;

  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MCP_BODY_LIMIT;
  const bounded = await boundResponse(fetched, maxResponseBytes, timeoutMs);
  if (!(bounded instanceof Response)) return bounded;

  if (!bounded.ok) return options.onError ? options.onError(bounded) : defaultErrorResult(bounded);
  return (options.respond ?? defaultRespond)(bounded);
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
    ...pickDefined(options, ["scope"]),
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
