/**
 * Node request-side plumbing for the `(req, res)` adapter: origin
 * resolution, Web `Request` construction, and bounded body reading.
 * Response-side glue (`sendWebResponse`, `asNodeHandler`) lives in `node.ts`.
 */

import {
  BodyTooLargeError,
  DEFAULT_MCP_BODY_LIMIT,
  DEFAULT_OAUTH_BODY_LIMIT,
  isNodeReadable,
  readBoundedNodeBody,
} from "../http/body.js";
import { isJsonObject } from "../util/json.js";

export type NodeRequestLike = {
  method?: string | undefined;
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  /** Destroy the underlying socket — called only after a 413 has flushed. */
  destroy?: (() => void) | undefined;
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>;
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

const ALLOWED_ORIGIN_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Derive origin from Host, or from forwarded headers when `trustProxy`.
 * Always parsed through `URL` and rejected unless it is a bare `host[:port]`
 * over http(s): a Host carrying a path (`evil.test/../trusted.test`) or
 * credentials (`user:pass@evil.test`) must not become an origin-shaped string.
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
  if (!ALLOWED_ORIGIN_PROTOCOLS.has(parsed.protocol)) {
    throw new InvalidOriginError(
      `Cannot resolve origin: unsupported protocol "${parsed.protocol}"`,
    );
  }
  return parsed.origin;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  isJsonObject(value) && !(value instanceof Uint8Array);

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
 * `Content-Type` header says what shape it round-trips back to. A form body
 * must be re-encoded as a form, or `/token` and `/consent` behind
 * `express.urlencoded()` receive one unparseable JSON-shaped key.
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

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

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
  if (BODYLESS_METHODS.has(method)) {
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

export const requestPath = (req: NodeRequestLike): string => (req.url ?? "/").split("?")[0] ?? "/";

/** True for a path under an `…/oauth` segment — the default OAuth mount. */
export const isOAuthPath = (path: string): boolean => /\/oauth(?:\/|$)/.test(path);

/** OAuth routes under `…/oauth/…` get the 64 KiB cap; everything else gets 1 MiB. */
export const bodyLimitForPath = (path: string): number =>
  isOAuthPath(path) ? DEFAULT_OAUTH_BODY_LIMIT : DEFAULT_MCP_BODY_LIMIT;

const enforcePresetBodySize = (body: unknown, maxBytes: number): void => {
  if (typeof body === "string" && new TextEncoder().encode(body).byteLength > maxBytes) {
    throw new BodyTooLargeError(maxBytes);
  }
  if (body instanceof Uint8Array && body.byteLength > maxBytes) {
    throw new BodyTooLargeError(maxBytes);
  }
};

const emptyToUndefined = (bytes: Uint8Array): Uint8Array | undefined =>
  bytes.byteLength > 0 ? bytes : undefined;

const asBodyStream = (req: NodeRequestLike): AsyncIterable<Uint8Array | string> | undefined => {
  if (isNodeReadable(req) || isAsyncIterable(req)) {
    return req as AsyncIterable<Uint8Array | string>;
  }
  return undefined;
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

  const stream = asBodyStream(req);
  if (!stream) return undefined;

  return emptyToUndefined(
    await readBoundedNodeBody(stream, maxBytes, {
      contentLength: headerValue(req.headers["content-length"]),
    }),
  );
};
