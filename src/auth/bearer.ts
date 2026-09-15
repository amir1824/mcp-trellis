/** Bearer auth helpers for MCP (RFC 9728 WWW-Authenticate). */

const BEARER_PREFIX = "Bearer ";

/** Above any real JWT / HMAC sig; prevents allocation DoS on attacker input. */
export const MAX_COMPARE_LENGTH = 4096;

/** RFC 7235 §2.1 — the auth-scheme token is case-insensitive ("bearer", "BEARER", "Bearer" all valid). */
const BEARER_SCHEME_RE = /^bearer\s+/i;

export const parseBearer = (authorization: string | null): string | null => {
  if (!authorization) return null;
  const match = BEARER_SCHEME_RE.exec(authorization);
  if (!match) return null;
  const token = authorization.slice(match[0].length).trim();
  return token.length > 0 ? token : null;
};

/**
 * Constant-time string compare.
 * Pads to max length and folds length mismatch into the accumulator
 * so unequal lengths do not short-circuit. Rejects over-long inputs.
 */
export const timingSafeEqual = (a: string, b: string): boolean => {
  // Both empty: the reduce below never runs and the seed 0 ^ 0 is 0 — "equal"
  // by the accumulator's math, but never the right semantics for a secret
  // comparison. An empty presented value must never authenticate.
  if (a.length === 0 || b.length === 0) return false;
  if (a.length > MAX_COMPARE_LENGTH || b.length > MAX_COMPARE_LENGTH) {
    return false;
  }
  const len = Math.max(a.length, b.length);
  const diff = Array.from({ length: len }, (_, i) => i).reduce((acc, i) => {
    const ac = i < a.length ? a.charCodeAt(i) : 0;
    const bc = i < b.length ? b.charCodeAt(i) : 0;
    return acc | (ac ^ bc);
  }, a.length ^ b.length);
  return diff === 0;
};

export const matchesAny = (presented: string, accepted: string[]): boolean =>
  accepted.some((token) => timingSafeEqual(presented, token));

export type WwwAuthenticateOptions = {
  realm: string;
  /** Absolute URL to RFC 9728 protected resource metadata. */
  resourceMetadataUrl: string;
  /** RFC 6750 §3.1 error code, e.g. `"insufficient_scope"`. Omitted on a plain 401. */
  error?: string | undefined;
  /** RFC 6750 §3.1 — the scope(s) that would satisfy the request. Paired with `error`. */
  scope?: string | undefined;
};

/** RFC 6750 / RFC 7235 quoted-string — escape `\` and `"` so host-controlled values cannot break or inject header params. */
const escapeWwwAuthenticateValue = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export const wwwAuthenticateHeader = (options: WwwAuthenticateOptions): string => {
  const parts = [
    `realm="${escapeWwwAuthenticateValue(options.realm)}"`,
    `resource_metadata="${escapeWwwAuthenticateValue(options.resourceMetadataUrl)}"`,
    ...(options.error ? [`error="${escapeWwwAuthenticateValue(options.error)}"`] : []),
    ...(options.scope ? [`scope="${escapeWwwAuthenticateValue(options.scope)}"`] : []),
  ];
  return `${BEARER_PREFIX}${parts.join(", ")}`;
};

/** RFC 6750 §2.3 uses `access_token`; also reject legacy `token`. */
export const rejectQueryToken = (url: URL): boolean =>
  url.searchParams.has("token") || url.searchParams.has("access_token");
