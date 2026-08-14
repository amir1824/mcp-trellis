/**
 * Node HTTP `(req, res)` adapter — Express, Cloud Functions, `http.createServer`, etc.
 * Bridges duck-typed Node request/response objects to Web `Request`/`Response`.
 */

import { INTERNAL_ERROR } from "../http.js";
import {
  isAllowedOrigin,
  type OriginAllowlistOptions,
} from "./origins.js";

export { isAllowedOrigin, type OriginAllowlistOptions };

export type NodeRequestLike = {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
};

export type NodeResponseLike = {
  statusCode: number;
  setHeader: (name: string, value: string | number | readonly string[]) => void;
  end: (chunk?: string | Uint8Array) => void;
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

const headerValue = (
  value: string | string[] | undefined,
): string | undefined => (Array.isArray(value) ? value[0] : value);

const lastForwarded = (value: string | undefined): string | undefined =>
  value?.split(",").pop()?.trim();

/** Derive origin from Host, or from forwarded headers when trustProxy. */
export const resolveOrigin = (
  req: NodeRequestLike,
  options: ResolveOriginOptions = {},
): string => {
  const trustProxy = options.trustProxy === true;
  const proto = trustProxy
    ? lastForwarded(headerValue(req.headers["x-forwarded-proto"])) || "https"
    : "https";
  const host = trustProxy
    ? lastForwarded(headerValue(req.headers["x-forwarded-host"])) ||
      headerValue(req.headers.host)
    : headerValue(req.headers.host);
  if (!host) {
    throw new Error(
      "Cannot resolve origin: pass options.origin or set Host" +
        (trustProxy ? " / X-Forwarded-Host" : ""),
    );
  }
  return `${proto}://${host}`;
};

const toBodyInit = (body: unknown): BodyInit | undefined => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) {
    return body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    ) as ArrayBuffer;
  }
  return JSON.stringify(body);
};

export const toWebRequest = (
  req: NodeRequestLike,
  options: ToWebRequestOptions,
): Request => {
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
  return new Request(url, {
    method,
    headers,
    body: toBodyInit(body),
  });
};

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof (value as { [Symbol.asyncIterator]?: unknown } | null)?.[
    Symbol.asyncIterator
  ] === "function";

const concatChunks = (chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  chunks.reduce((offset, chunk) => {
    out.set(chunk, offset);
    return offset + chunk.byteLength;
  }, 0);
  return out;
};

/** Prefer `req.body`; else drain the stream (raw `http.createServer`). */
export const readNodeBody = async (
  req: NodeRequestLike,
): Promise<unknown> => {
  if (req.body !== undefined && req.body !== null) return req.body;
  if (!isAsyncIterable(req)) return undefined;

  const chunks: Uint8Array[] = [];
  for await (const chunk of req as AsyncIterable<Uint8Array | string>) {
    chunks.push(
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
    );
  }
  return chunks.length > 0 ? concatChunks(chunks) : undefined;
};

export const sendWebResponse = async (
  res: NodeResponseLike,
  response: Response,
): Promise<void> => {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(new Uint8Array(await response.arrayBuffer()));
};

/** Always answer — an unhandled rejection on `http.createServer` hangs the client. */
const sendJsonError = (
  res: NodeResponseLike,
  status: number,
  error: string,
): void => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error }));
};

/** One-liner: Node `(req, res)` → MCP / OAuth Web handler. */
export const asNodeHandler = (
  mcp: { fetch: (request: Request) => Promise<Response> },
  options?: AsNodeHandlerOptions,
) => {
  const hostDerived = !options?.origin;
  if (hostDerived && options?.trustProxy !== true) {
    throw new Error(
      "asNodeHandler requires options.origin or options.trustProxy: true",
    );
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
    throw new Error(
      "asNodeHandler: options.origin is not in options.allowedOrigins",
    );
  }

  return async (req: NodeRequestLike, res: NodeResponseLike): Promise<void> => {
    try {
      const origin =
        options?.origin ?? resolveOrigin(req, { trustProxy: true });
      if (!isAllowedOrigin(origin, options)) {
        sendJsonError(res, 400, "origin not allowed");
        return;
      }
      const body = await readNodeBody(req);
      const request = toWebRequest(req, { origin, body });
      await sendWebResponse(res, await mcp.fetch(request));
    } catch {
      sendJsonError(res, 500, INTERNAL_ERROR);
    }
  };
};
