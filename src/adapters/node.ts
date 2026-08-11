/**
 * Node HTTP `(req, res)` adapter — Express, Cloud Functions, `http.createServer`, etc.
 * Bridges duck-typed Node request/response objects to Web `Request`/`Response`.
 */

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
): string | undefined => {
  if (Array.isArray(value)) return value[0];
  return value;
};

/** Last comma-separated hop (closest trusted proxy). */
const lastForwarded = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const parts = value.split(",");
  return parts[parts.length - 1]?.trim();
};

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

  return new Request(url, {
    method,
    headers,
    body: toBodyInit(req.body),
  });
};

export const sendWebResponse = async (
  res: NodeResponseLike,
  response: Response,
): Promise<void> => {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.end(new Uint8Array(await response.arrayBuffer()));
};

/** One-liner: Node `(req, res)` → MCP / OAuth Web handler. */
export const asNodeHandler = (
  mcp: { fetch: (request: Request) => Promise<Response> },
  options?: AsNodeHandlerOptions,
) => {
  if (!options?.origin && options?.trustProxy !== true) {
    throw new Error(
      "asNodeHandler requires options.origin, or options.trustProxy: true behind a trusted proxy",
    );
  }

  return async (req: NodeRequestLike, res: NodeResponseLike): Promise<void> => {
    const origin =
      options.origin ?? resolveOrigin(req, { trustProxy: true });
    const request = toWebRequest(req, { origin });
    await sendWebResponse(res, await mcp.fetch(request));
  };
};
