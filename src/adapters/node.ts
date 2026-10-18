/**
 * Node HTTP `(req, res)` adapter — Express, Cloud Functions, `http.createServer`, etc.
 * Bridges duck-typed Node request/response objects to Web `Request`/`Response`.
 * Request-side plumbing (origin resolution, `toWebRequest`, body reading)
 * lives in `node-request.ts` and is re-exported below unchanged.
 */

import { BodyTooLargeError } from "../http/body.js";
import { INTERNAL_ERROR } from "../http/http.js";
import { isAllowedOrigin, type OriginAllowlistOptions } from "../http/origins.js";
import { JSONRPC_PAYLOAD_TOO_LARGE, rpcError } from "../mcp/jsonrpc.js";
import {
  bodyLimitForPath,
  InvalidOriginError,
  isOAuthPath,
  type NodeRequestLike,
  readNodeBody,
  requestPath,
  resolveOrigin,
  toWebRequest,
} from "./node-request.js";

export {
  isAllowedOrigin,
  isAllowedRequestOrigin,
  type OriginAllowlistOptions,
} from "../http/origins.js";
export {
  bodyLimitForPath,
  InvalidOriginError,
  type NodeRequestLike,
  type ResolveOriginOptions,
  readNodeBody,
  resolveOrigin,
  type ToWebRequestOptions,
  toWebRequest,
} from "./node-request.js";

export type NodeResponseLike = {
  statusCode: number;
  setHeader: (name: string, value: string | number | readonly string[]) => void;
  end: (chunk?: string | Uint8Array, callback?: () => void) => void;
};

export type AsNodeHandlerOptions = OriginAllowlistOptions & {
  /**
   * Absolute origin. Required unless `trustProxy: true`.
   * When omitted (Host-derived), `allowedOrigins` must be non-empty
   * (`["*"]` to admit any Host).
   */
  origin?: string;
  trustProxy?: boolean;
  /**
   * Exact `Host` header values (`host[:port]`, case-insensitive) this handler
   * answers to. A request whose `Host` is anything else gets a 400 before any
   * route runs.
   *
   * A fixed `origin` otherwise ignores `Host` entirely, so a DNS-rebinding
   * page (`attacker.test` re-pointed at your server) can drive the whole
   * OAuth flow — including reading the consent ticket and approving it —
   * from a victim's browser. When `origin` is a loopback address the check
   * is on by default (`127.0.0.1`, `localhost` and `[::1]` on the origin's
   * port); set `allowedHosts` for anything else, or to widen the loopback
   * default (a LAN IP, a container hostname). `:authority` (HTTP/2) counts as
   * `Host`; a request with neither header is not affected.
   */
  allowedHosts?: string[];
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

/**
 * Always answer — an unhandled rejection on `http.createServer` hangs the
 * client. `onFlushed` also closes the connection once the body is written.
 */
const sendJsonError = (
  res: NodeResponseLike,
  error: { status: number; body: string },
  onFlushed?: () => void,
): void => {
  res.statusCode = error.status;
  res.setHeader("Content-Type", "application/json");
  if (onFlushed) res.setHeader("Connection", "close");
  res.end(error.body, onFlushed);
};

const ORIGIN_NOT_ALLOWED = { status: 400, body: JSON.stringify({ error: "origin not allowed" }) };
const HOST_NOT_ALLOWED = { status: 400, body: JSON.stringify({ error: "host not allowed" }) };

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

const loopbackOriginOf = (value: string): URL | null => {
  try {
    const url = new URL(value);
    return LOOPBACK_HOSTNAMES.has(url.hostname) ? url : null;
  } catch {
    return null;
  }
};

/** Every `Host` value a client of the loopback `origin` can legitimately send. */
const loopbackHosts = (origin: URL): Set<string> => {
  const defaultPort = origin.protocol === "https:" ? "443" : "80";
  const ports = origin.port ? [origin.port] : ["", defaultPort];
  return new Set(
    [...LOOPBACK_HOSTNAMES].flatMap((name) =>
      ports.map((port) => (port ? `${name}:${port}` : name)),
    ),
  );
};

/**
 * True when the request's `Host` header is not one this handler answers to —
 * see `AsNodeHandlerOptions.allowedHosts`. An absent `Host` is never denied:
 * a browser (and so a rebinding page) always sends one.
 */
const hostDenied = (req: NodeRequestLike, options: AsNodeHandlerOptions | undefined): boolean => {
  // HTTP/2 carries the authority as `:authority`; `host` is then usually absent.
  const header = req.headers.host ?? req.headers[":authority"];
  const host = (Array.isArray(header) ? header[0] : header)?.toLowerCase();
  if (host === undefined || host === "") return false;

  if (options?.allowedHosts?.length) {
    return !options.allowedHosts.some((entry) => entry.toLowerCase() === host);
  }
  const origin = options?.origin ? loopbackOriginOf(options.origin) : null;
  return origin !== null && !loopbackHosts(origin).has(host);
};

const payloadTooLargeBody = (path: string): string =>
  isOAuthPath(path)
    ? JSON.stringify({ error: "request body too large" })
    : JSON.stringify(rpcError(null, JSONRPC_PAYLOAD_TOO_LARGE, "Payload too large"));

/**
 * Validates that `options` resolves to an origin `asNodeHandler` can trust —
 * either an explicit `options.origin` already covered by `allowedOrigins`,
 * or (Host-derived) an `allowedOrigins` that isn't empty. A forgettable Host
 * spoof would otherwise leak straight into the AS issuer / PRM /
 * WWW-Authenticate values every request produces.
 */
const assertNodeHandlerOptions = (options: AsNodeHandlerOptions | undefined): void => {
  const hostDerived = !options?.origin;
  if (hostDerived && options?.trustProxy !== true) {
    throw new Error("asNodeHandler requires options.origin or options.trustProxy: true");
  }
  if (hostDerived && !options?.allowedOrigins?.length) {
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
};

/** One-liner: Node `(req, res)` → MCP / OAuth Web handler. */
export const asNodeHandler = (
  mcp: { fetch: (request: Request) => Promise<Response> },
  options?: AsNodeHandlerOptions,
) => {
  assertNodeHandlerOptions(options);

  return async (req: NodeRequestLike, res: NodeResponseLike): Promise<void> => {
    const path = requestPath(req);
    try {
      if (hostDenied(req, options)) {
        sendJsonError(res, HOST_NOT_ALLOWED);
        return;
      }
      const origin = options?.origin ?? resolveOrigin(req, { trustProxy: true });
      if (!isAllowedOrigin(origin, options)) {
        sendJsonError(res, ORIGIN_NOT_ALLOWED);
        return;
      }
      const body = await readNodeBody(req, bodyLimitForPath(path));
      const request = toWebRequest(req, { origin, body });
      await sendWebResponse(res, await mcp.fetch(request));
    } catch (caught) {
      if (caught instanceof BodyTooLargeError) {
        sendJsonError(res, { status: 413, body: payloadTooLargeBody(path) }, () => {
          req.destroy?.();
        });
        return;
      }
      if (caught instanceof InvalidOriginError) {
        // Bad client input (a malformed or missing Host / X-Forwarded-*),
        // not a server fault — 400, not the generic 500 below.
        sendJsonError(res, ORIGIN_NOT_ALLOWED);
        return;
      }
      sendJsonError(res, { status: 500, body: JSON.stringify({ error: INTERNAL_ERROR }) });
    }
  };
};
