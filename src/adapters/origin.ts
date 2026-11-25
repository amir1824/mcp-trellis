/** Origin resolution for the Node adapter: `Host` and `X-Forwarded-*` become one trusted origin, or an `InvalidOriginError`. */

import type { NodeRequestLike } from "./node-request.js";

export type ResolveOriginOptions = {
  /** Trust last `X-Forwarded-Host` / `X-Forwarded-Proto` hop. */
  trustProxy?: boolean;
};

export const headerValue = (value: string | string[] | undefined): string | undefined =>
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
