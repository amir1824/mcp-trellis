/** Bearer auth helpers for MCP (RFC 9728 WWW-Authenticate). */

export const BEARER_PREFIX = "Bearer ";

/** Above any real JWT / HMAC sig; prevents allocation DoS on attacker input. */
export const MAX_COMPARE_LENGTH = 4096;

export const parseBearer = (authorization: string | null): string | null => {
  if (!authorization?.startsWith(BEARER_PREFIX)) return null;
  const token = authorization.slice(BEARER_PREFIX.length).trim();
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
};

export const wwwAuthenticateHeader = (options: WwwAuthenticateOptions): string =>
  `${BEARER_PREFIX}realm="${options.realm}", resource_metadata="${options.resourceMetadataUrl}"`;

/** RFC 6750 §2.3 uses `access_token`; also reject legacy `token`. */
export const rejectQueryToken = (url: URL): boolean =>
  url.searchParams.has("token") || url.searchParams.has("access_token");
