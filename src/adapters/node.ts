/**
 * Node HTTP `(req, res)` adapter — Express, Cloud Functions, `http.createServer`, etc.
 * Bridges duck-typed Node request/response objects to Web `Request`/`Response`.
 */

import { INTERNAL_ERROR } from "../http.js";

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
  /**
   * Trust `X-Forwarded-Host` / `X-Forwarded-Proto`.
   * Uses the **last** forwarded value (rightmost = closest proxy).
   */
  trustProxy?: boolean;
};

export type AsNodeHandlerOptions = {
  /**
   * Absolute origin. Required unless `trustProxy: true`
   * (then derived from X-Forwarded-* / Host).
   */
  origin?: string;
  trustProxy?: boolean;
};

const headerValue = (
  value: string | string[] | undefined,
): string | undefined => (Array.isArray(value) ? value[0] : value);

/** Last comma-separated hop (closest trusted proxy). */
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

const BODY_BUILDERS: Array<{
  match: (body: unknown) => boolean;
  build: (body: unknown) => BodyInit | undefined;
}> = [
  {
    match: (body) => body === undefined || body === null,
    build: () => undefined,
  },
  {
    match: (body) => typeof body === "string",
    build: (body) => body as string,
  },
  {
    match: (body) => body instanceof Uint8Array,
    build: (body) => {
      const bytes = body as Uint8Array;
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
    },
  },
];

const toBodyInit = (body: unknown): BodyInit | undefined => {
  const builder = BODY_BUILDERS.find((entry) => entry.match(body));
  return builder ? builder.build(body) : JSON.stringify(body);
};

export const toWebRequest = (
  req: NodeRequestLike,
  options: ToWebRequestOptions,
): Request => {
  const path = req.url ?? "/";
  const url = path.startsWith("http") ? path : `${options.origin}${path}`;
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
const sendInternalError = (res: NodeResponseLike): void => {
  res.statusCode = 500;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: INTERNAL_ERROR }));
};

/** One-liner: Node `(req, res)` → MCP / OAuth Web handler. */
export const asNodeHandler = (
  mcp: { fetch: (request: Request) => Promise<Response> },
  options?: AsNodeHandlerOptions,
) => {
  if (!options?.origin && options?.trustProxy !== true) {
    throw new Error("asNodeHandler requires options.origin or options.trustProxy: true");
  }

  return async (req: NodeRequestLike, res: NodeResponseLike): Promise<void> => {
    try {
      const origin =
        options.origin ?? resolveOrigin(req, { trustProxy: true });
      const body = await readNodeBody(req);
      const request = toWebRequest(req, { origin, body });
      await sendWebResponse(res, await mcp.fetch(request));
    } catch {
      sendInternalError(res);
    }
  };
};
