/**
 * Node HTTP `(req, res)` adapter — Express, Cloud Functions, `http.createServer`, etc.
 * Bridges duck-typed Node request/response objects to Web `Request`/`Response`.
 */

import {
  BodyTooLargeError,
  DEFAULT_MCP_BODY_LIMIT,
  DEFAULT_OAUTH_BODY_LIMIT,
  isNodeReadable,
  readBoundedNodeBody,
} from "../body.js";
import { INTERNAL_ERROR } from "../http.js";
import { JSONRPC_PAYLOAD_TOO_LARGE, rpcError } from "../jsonrpc.js";
import { isAllowedOrigin, type OriginAllowlistOptions } from "./origins.js";

export { isAllowedOrigin, type OriginAllowlistOptions };

export type NodeRequestLike = {
  method?: string | undefined;
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  /** Destroy the underlying socket — called only after a 413 has flushed. */
  destroy?: (() => void) | undefined;
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>;
};

export type NodeResponseLike = {
  statusCode: number;
  setHeader: (name: string, value: string | number | readonly string[]) => void;
  end: (chunk?: string | Uint8Array, callback?: () => void) => void;
};

export type ToWebRequestOptions = {
  /** Absolute origin, e.g. https://app.example.com. */
  origin: string;
  /** Pre-read body. Overrides `req.body` when supplied. */
  body?: unknown;
};

export type ResolveOriginOptions = {
  /** Trust last `X-Forwarded-Host` / `X-Forwarded-Proto` hop. */
  trustProxy?: boolean;
};

export type AsNodeHandlerOptions = OriginAllowlistOptions & {
  /**
   * Absolute origin. Required unless `trustProxy: true`.
   * When omitted (Host-derived), `allowedOrigins` must be non-empty
   * (`["*"]` to admit any Host).
   */
  origin?: string;
  trustProxy?: boolean;
};

const headerValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const lastForwarded = (value: string | undefined): string | undefined =>
  value?.split(",").pop()?.trim();

/**
 * A Host (or `X-Forwarded-*`) header that can't safely become an origin —
 * missing, carrying a path/query/fragment/credentials, malformed, or a
 * non-`http(s)` scheme. Distinct from a generic `Error` so `asNodeHandler`
 * can answer this with a client-facing 400 instead of the same 500 it gives
 * an actual unexpected failure.
 */
export class InvalidOriginError extends Error {}

/** A bare `host[:port]` must not carry any of these — they'd mean a path, query, fragment, or credentials smuggled into what should be just the authority. */
const HOST_HEADER_STRUCTURAL_CHARS = /[/?#@\\]/;

/**
 * Derive origin from Host, or from forwarded headers when `trustProxy`.
 * Always normalized and validated through `URL` — the previous
 * `${proto}://${host}` template trusted the header verbatim, so a Host
 * carrying a path (`evil.test/../trusted.test`) or credentials
 * (`user:pass@evil.test`) built a string that merely *looked* like an
 * origin, and a non-`http(s)` `X-Forwarded-Proto` was never rejected.
 */
export const resolveOrigin = (req: NodeRequestLike, options: ResolveOriginOptions = {}): string => {
  const trustProxy = options.trustProxy === true;
  const proto = trustProxy
    ? lastForwarded(headerValue(req.headers["x-forwarded-proto"])) || "https"
    : "https";
  const host = trustProxy
    ? lastForwarded(headerValue(req.headers["x-forwarded-host"])) || headerValue(req.headers.host)
    : headerValue(req.headers.host);
  if (!host) {
    throw new InvalidOriginError(
      "Cannot resolve origin: pass options.origin or set Host" +
        (trustProxy ? " / X-Forwarded-Host" : ""),
    );
  }
  if (HOST_HEADER_STRUCTURAL_CHARS.test(host)) {
    throw new InvalidOriginError(
      `Cannot resolve origin: Host header "${host}" must be a bare host[:port], not a full URL`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(`${proto}://${host}`);
  } catch {
    throw new InvalidOriginError(`Cannot resolve origin: Host header "${host}" is not valid`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidOriginError(
      `Cannot resolve origin: unsupported protocol "${parsed.protocol}"`,
    );
  }
  return parsed.origin;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Uint8Array);

const isFormContentType = (contentType: string | undefined): boolean =>
  (contentType ?? "").toLowerCase().includes("application/x-www-form-urlencoded");

const appendFormValue = (params: URLSearchParams, key: string, value: unknown): void => {
  if (Array.isArray(value)) {
    for (const entry of value) appendFormValue(params, key, entry);
    return;
  }
  if (value === undefined || value === null) return;
  params.append(key, typeof value === "string" ? value : String(value));
};

/** Re-serialize a pre-parsed `express.urlencoded()`-shaped body back to `a=1&b=2`. */
const objectToUrlEncoded = (body: Record<string, unknown>): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) appendFormValue(params, key, value);
  return params.toString();
};

/**
 * `req.body` from a body-parsing middleware (Express `json()`/`urlencoded()`,
 * multer, …) arrives as an already-parsed object, not raw bytes — the
 * `Content-Type` header says what shape it should round-trip back to.
 * Always `JSON.stringify`-ing it (the pre-1.1.1 behavior) sent
 * `application/x-www-form-urlencoded` bodies to `/token` and `/consent` as a
 * single bogus JSON-shaped form key nothing downstream could parse, silently
 * breaking every OAuth exchange behind `express.urlencoded()`.
 */
const toBodyInit = (body: unknown, contentType?: string): BodyInit | undefined => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  }
  if (isPlainRecord(body) && isFormContentType(contentType)) {
    return objectToUrlEncoded(body);
  }
  return JSON.stringify(body);
};

export const toWebRequest = (req: NodeRequestLike, options: ToWebRequestOptions): Request => {
  // Never trust an absolute-form request target — rebase onto the validated origin.
  const target = new URL(req.url ?? "/", options.origin);
  const url = `${options.origin}${target.pathname}${target.search}`;
  const headers = new Headers(
    Object.entries(req.headers)
      .map(([key, value]): [string, string] | null => {
        const resolved = headerValue(value);
        return resolved === undefined ? null : [key, resolved];
      })
      .filter((entry): entry is [string, string] => entry !== null),
  );

  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }

  const body = options.body !== undefined ? options.body : req.body;
  const bodyInit = toBodyInit(body, headers.get("content-type") ?? undefined);
  if (isPlainRecord(body)) {
    // The re-serialized body's byte length no longer matches whatever
    // Content-Length the original (already-parsed) request declared — a
    // stale header here can make the body-size precheck reject a body well
    // within the cap, or let an oversized one slip past it (still caught by
    // the streaming fallback either way).
    headers.delete("content-length");
    headers.delete("transfer-encoding");
  }
  return new Request(url, {
    method,
    headers,
    ...(bodyInit !== undefined ? { body: bodyInit } : {}),
  });
};

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof (value as { [Symbol.asyncIterator]?: unknown } | null)?.[Symbol.asyncIterator] ===
  "function";

const requestPath = (req: NodeRequestLike): string => (req.url ?? "/").split("?")[0] ?? "/";

/** OAuth routes under `…/oauth/…` get the 64 KiB cap; everything else gets 1 MiB. */
export const bodyLimitForPath = (path: string): number =>
  /\/oauth(?:\/|$)/.test(path) ? DEFAULT_OAUTH_BODY_LIMIT : DEFAULT_MCP_BODY_LIMIT;

const enforcePresetBodySize = (body: unknown, maxBytes: number): void => {
  if (typeof body === "string" && new TextEncoder().encode(body).byteLength > maxBytes) {
    throw new BodyTooLargeError(maxBytes);
  }
  if (body instanceof Uint8Array && body.byteLength > maxBytes) {
    throw new BodyTooLargeError(maxBytes);
  }
};

/**
 * Prefer `req.body`; else drain the stream (raw `http.createServer`), capped
 * at `maxBytes`. Throws `BodyTooLargeError` past the cap without destroying
 * the socket — `asNodeHandler` writes 413 first, then destroys after flush.
 */
export const readNodeBody = async (
  req: NodeRequestLike,
  maxBytes: number = DEFAULT_MCP_BODY_LIMIT,
): Promise<unknown> => {
  if (req.body !== undefined && req.body !== null) {
    enforcePresetBodySize(req.body, maxBytes);
    return req.body;
  }

  const opts = { contentLength: headerValue(req.headers["content-length"]) };
  if (isNodeReadable(req)) {
    const bytes = await readBoundedNodeBody(req, maxBytes, opts);
    return bytes.byteLength > 0 ? bytes : undefined;
  }
  if (!isAsyncIterable(req)) return undefined;

  const bytes = await readBoundedNodeBody(
    req as AsyncIterable<Uint8Array | string>,
    maxBytes,
    opts,
  );
  return bytes.byteLength > 0 ? bytes : undefined;
};

/**
 * Unlike every other header, `Set-Cookie` cannot be folded into one
 * comma-joined value — a cookie's own `Expires` attribute contains a comma.
 * The Fetch `Headers` object accordingly keeps duplicates apart internally
 * and exposes them via `getSetCookie()`, but `forEach`/`entries()` still
 * yields one `"set-cookie"` pair per cookie — calling `res.setHeader` once
 * per pair (as for any other header) makes each call overwrite the last,
 * silently dropping every cookie but the final one.
 */
export const sendWebResponse = async (res: NodeResponseLike, response: Response): Promise<void> => {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    res.setHeader(key, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  res.end(new Uint8Array(await response.arrayBuffer()));
};

/** Always answer — an unhandled rejection on `http.createServer` hangs the client. */
const sendJsonError = (
  res: NodeResponseLike,
  status: number,
  body: string,
  after?: () => void,
): void => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  if (after) res.setHeader("Connection", "close");
  res.end(body, after);
};

const payloadTooLargeBody = (path: string): string =>
  /\/oauth(?:\/|$)/.test(path)
    ? JSON.stringify({ error: "request body too large" })
    : JSON.stringify(rpcError(null, JSONRPC_PAYLOAD_TOO_LARGE, "Payload too large"));

/** One-liner: Node `(req, res)` → MCP / OAuth Web handler. */
export const asNodeHandler = (
  mcp: { fetch: (request: Request) => Promise<Response> },
  options?: AsNodeHandlerOptions,
) => {
  const hostDerived = !options?.origin;
  if (hostDerived && options?.trustProxy !== true) {
    throw new Error("asNodeHandler requires options.origin or options.trustProxy: true");
  }
  // Forgettable Host spoof → AS issuer / PRM / WWW-Authenticate. Require an
  // explicit allowlist whenever origin comes from the request.
  if (hostDerived && !options.allowedOrigins?.length) {
    throw new Error(
      'asNodeHandler with Host-derived origin requires options.allowedOrigins (use ["*"] to admit any Host)',
    );
  }
  if (
    options?.origin &&
    options.allowedOrigins?.length &&
    !isAllowedOrigin(options.origin, options)
  ) {
    throw new Error("asNodeHandler: options.origin is not in options.allowedOrigins");
  }

  return async (req: NodeRequestLike, res: NodeResponseLike): Promise<void> => {
    const path = requestPath(req);
    try {
      const origin = options?.origin ?? resolveOrigin(req, { trustProxy: true });
      if (!isAllowedOrigin(origin, options)) {
        sendJsonError(res, 400, JSON.stringify({ error: "origin not allowed" }));
        return;
      }
      const body = await readNodeBody(req, bodyLimitForPath(path));
      const request = toWebRequest(req, { origin, body });
      await sendWebResponse(res, await mcp.fetch(request));
    } catch (exc) {
      if (exc instanceof BodyTooLargeError) {
        sendJsonError(res, 413, payloadTooLargeBody(path), () => {
          req.destroy?.();
        });
        return;
      }
      if (exc instanceof InvalidOriginError) {
        // Bad client input (a malformed or missing Host / X-Forwarded-*),
        // not a server fault — 400, not the generic 500 below.
        sendJsonError(res, 400, JSON.stringify({ error: "origin not allowed" }));
        return;
      }
      sendJsonError(res, 500, JSON.stringify({ error: INTERNAL_ERROR }));
    }
  };
};
