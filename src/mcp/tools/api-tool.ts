/**
 * `apiTool`: wrap a single REST call as an MCP tool in one call — build the request from typed
 * args, run it, and shape the response, with no hand-rolled fetch or error plumbing per tool.
 */

import { DEFAULT_MCP_BODY_LIMIT } from "../../http/body.js";
import { pickDefined } from "../../util/defined.js";
import type { ToolDef, ToolResult } from "../registry.js";
import {
  type ApiRequest,
  boundResponse,
  fetchWithTimeout,
  type RedirectMode,
} from "./api-fetch.js";
import { defineTool, type RawInput, type ToolCore, type ValidatedInput } from "./define-tool.js";

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
  /**
   * What to do when the upstream answers with a redirect. Default
   * `"manual"`: the 3xx is returned as-is and surfaces as an ordinary failed
   * request (status only), so credentials in custom headers (`X-Api-Key`,
   * which `fetch` forwards cross-origin on a redirect), a POST body, and a
   * request into an internal address are never handed to a `Location` the
   * upstream picked. `"error"` makes any redirect throw. `"follow"` restores
   * the platform default — only for an upstream you fully trust, since an
   * open redirect or compromised upstream can then reach any URL the server
   * can, and the response comes back to the model.
   */
  redirect?: RedirectMode;
};

export type ApiToolOptions<TCtx, Input = Record<string, unknown>> =
  | (ToolCore & ValidatedInput<Input> & ApiExtra<TCtx, Input>)
  | (ToolCore & RawInput & ApiExtra<TCtx, Record<string, unknown>>);

const DEFAULT_API_TOOL_TIMEOUT_MS = 30_000;

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
  // A redirect is not followed by default; an opaque one (some runtimes) has
  // status 0. Say so, or a previously working http→https hop just "fails".
  const isRedirect = res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
  const hint = isRedirect ? ' (redirect not followed; set redirect: "follow" to allow it)' : "";
  return {
    content: [{ type: "text", text: `Request failed: ${status}${hint}` }],
    isError: true,
  };
};

const runApi = async <TCtx, Args>(
  options: ApiExtra<TCtx, Args>,
  ctx: TCtx,
  args: Args,
): Promise<ToolResult | string> => {
  const fetchImpl = options.fetch ?? fetch;
  const input = await options.request(ctx, args);
  const timeoutMs = options.timeoutMs ?? DEFAULT_API_TOOL_TIMEOUT_MS;

  const fetched = await fetchWithTimeout({
    fetchImpl,
    input,
    timeoutMs,
    redirect: options.redirect ?? "manual",
  });
  if (!("response" in fetched)) return fetched;

  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MCP_BODY_LIMIT;
  let bounded: Response | ToolResult;
  try {
    bounded = await boundResponse(fetched.response, maxResponseBytes, timeoutMs, fetched);
  } finally {
    fetched.dispose();
  }
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
