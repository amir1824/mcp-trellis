/**
 * Stateless refresh tokens for `signedTokenAuth`. Internal: not exported
 * from the package.
 *
 * Signed, not stored. The only state is the single-use `jti` mark in the
 * shared `codeStore`, which is what makes rotation work: a refresh token is
 * accepted once and its successor is a different token. The mark lives until
 * the grant's `exp`, one per refresh.
 *
 * ponytail: a replayed, already-rotated token is refused, but there is no
 * token family to revoke when that happens, so the thief's successor stays
 * valid until `exp` or until `isUserActive` turns false. Upgrade: an opaque
 * server-side refresh store (see `examples/project-desk/src/tokens.ts`).
 */

import type { CodeStore } from "../oauth/crypto/codes.js";
import { randomBase64Url, sha256Base64Url } from "../oauth/crypto/pkce.js";
import { resourcesEqual } from "../oauth/policy/resource.js";
import type {
  MintAccessTokenInput,
  MintedToken,
  RefreshAccessTokenInput,
  RevokeTokenInput,
} from "../oauth/types.js";
import { signPayload, verifyPayload } from "./signed-payload.js";

const JTI_BYTES = 16;
const MAX_JTI_LENGTH = 64;
/** Keeps a refresh `jti` apart from auth-code jtis (bare) and consent tickets (`ct:`). */
const JTI_KEY_PREFIX = "rt:";

/**
 * The client is bound by hash, not by value: a DCR `client_id` is a sealed
 * assertion that grows with its redirect URIs, and the token must not.
 */
type RefreshPayload = {
  userId: string;
  scopes: string[];
  audience: string;
  clientHash: string;
  /** Fixed when the grant is consented; rotation never extends it. */
  exp: number;
  jti: string;
};

type RefreshTokenConfig = {
  secrets: readonly [string, ...string[]];
  lifetimeMs: number;
  codeStore: CodeStore;
  isUserActive: (userId: string) => boolean | Promise<boolean>;
  mintAccess: (input: MintAccessTokenInput) => Promise<MintedToken>;
};

export type RefreshTokens = {
  issue: (grant: MintAccessTokenInput) => Promise<string>;
  refresh: (input: RefreshAccessTokenInput) => Promise<MintedToken | null>;
  revoke: (input: RevokeTokenInput) => Promise<void>;
};

const hasText = (value: unknown): value is string => typeof value === "string" && value !== "";

const parseRefreshPayload = (raw: unknown): RefreshPayload | null => {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (!hasText(record.userId) || !hasText(record.clientHash) || !hasText(record.audience)) {
    return null;
  }
  if (!hasText(record.jti) || record.jti.length > MAX_JTI_LENGTH) return null;
  // An empty scope list is a valid grant (`defaultScopes: []`).
  if (!Array.isArray(record.scopes) || !record.scopes.every((s) => typeof s === "string")) {
    return null;
  }
  if (typeof record.exp !== "number" || !Number.isFinite(record.exp)) return null;
  if (record.exp < Date.now()) return null;
  return {
    userId: record.userId,
    clientHash: record.clientHash,
    audience: record.audience,
    scopes: record.scopes,
    exp: record.exp,
    jti: record.jti,
  };
};

/** The requested scope narrowed to what the grant holds, or null if it asks for more. */
const narrowedScopes = (granted: string[], requested: string | undefined): string[] | null => {
  if (requested === undefined) return granted;
  const wanted = requested.split(" ").filter(Boolean);
  return wanted.length > 0 && wanted.every((scope) => granted.includes(scope)) ? wanted : null;
};

const signRefresh = (config: RefreshTokenConfig, payload: RefreshPayload): Promise<string> =>
  signPayload(config.secrets[0], "refresh", payload);

const readRefresh = async (
  config: RefreshTokenConfig,
  token: string,
): Promise<RefreshPayload | null> =>
  parseRefreshPayload(await verifyPayload(config.secrets, "refresh", token));

// `=== true`: only a store that says so burns the token; a throw propagates
// as a 500 instead of letting a replay through.
const burnRefresh = async (config: RefreshTokenConfig, payload: RefreshPayload) =>
  (await config.codeStore.consume(`${JTI_KEY_PREFIX}${payload.jti}`, payload.exp)) === true;

const issueRefresh = async (
  config: RefreshTokenConfig,
  grant: MintAccessTokenInput,
): Promise<string> =>
  signRefresh(config, {
    userId: grant.userId,
    scopes: grant.scope.split(" ").filter(Boolean),
    audience: grant.resource,
    clientHash: await sha256Base64Url(grant.clientId),
    exp: Date.now() + config.lifetimeMs,
    jti: randomBase64Url(JTI_BYTES),
  });

/**
 * Order matters: every check that can fail on the caller's input runs before
 * the burn, so a wrong-client or wrong-resource attempt cannot spend the
 * rightful holder's token.
 */
const rotateRefresh = async (
  config: RefreshTokenConfig,
  input: RefreshAccessTokenInput,
): Promise<MintedToken | null> => {
  const payload = await readRefresh(config, input.refreshToken);
  if (!payload || payload.clientHash !== (await sha256Base64Url(input.clientId))) return null;
  if (!resourcesEqual(payload.audience, input.resource)) return null;
  const scopes = narrowedScopes(payload.scopes, input.scope);
  if (!scopes) return null;
  if ((await config.isUserActive(payload.userId)) !== true) return null;
  if (!(await burnRefresh(config, payload))) return null;

  const access = await config.mintAccess({
    userId: payload.userId,
    clientId: input.clientId,
    scope: scopes.join(" "),
    resource: payload.audience,
  });
  const successor = await signRefresh(config, { ...payload, jti: randomBase64Url(JTI_BYTES) });
  return { ...access, refreshToken: successor };
};

/** RFC 7009: an unusable or foreign token is a silent no-op; a store failure is not. */
const revokeRefresh = async (
  config: RefreshTokenConfig,
  input: RevokeTokenInput,
): Promise<void> => {
  const payload = await readRefresh(config, input.token);
  if (payload && payload.clientHash === (await sha256Base64Url(input.clientId))) {
    await burnRefresh(config, payload);
  }
};

export const createRefreshTokens = (config: RefreshTokenConfig): RefreshTokens => ({
  issue: (grant) => issueRefresh(config, grant),
  refresh: (input) => rotateRefresh(config, input),
  revoke: (input) => revokeRefresh(config, input),
});
