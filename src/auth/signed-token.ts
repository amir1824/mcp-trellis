/**
 * Convenience auth: one secret seals OAuth codes (via `codeSecret`) and
 * signs short-lived access tokens. Domain separation is HKDF, not luck —
 * access tokens, refresh tokens and sealed codes each use their own label.
 *
 * Tokens are stateless, so an issued access token stays valid until `exp`
 * whatever happens to the login session. Pass `isUserActive` to close that:
 * it runs on every verified token. Refresh is opt-in (`refreshTtlSeconds`);
 * see `signed-refresh.ts` for its limits.
 *
 * ponytail: access tokens cannot be revoked before `exp`; `/revoke` burns
 * refresh tokens only. Upgrade: supply your own `mintAccessToken` /
 * `verifyToken` over a store (see `examples/project-desk/src/tokens.ts`).
 */

import type { McpAppAuth, VerifiedToken } from "../app-options.js";
import { assertCodeSecret } from "../oauth/config.js";
import type { CodeStore } from "../oauth/crypto/codes.js";
import type { MintAccessTokenInput, MintedToken, OAuthUser } from "../oauth/types.js";
import { signPayload, verifyPayload } from "./signed-payload.js";
import { createRefreshTokens, type RefreshTokens } from "./signed-refresh.js";

const DEFAULT_TTL_SECONDS = 3600;
/** Each secret costs a key derivation per token kind, so rotation lists stay short. */
const MAX_SECRETS = 8;

type SecretList = readonly [string, ...string[]];
type UserCheck = (userId: string) => boolean | Promise<boolean>;

export type SignedTokenAuthOptions = {
  /**
   * One secret, or a rotation list: the first signs, every entry verifies.
   * Also used as `codeSecret`, so DCR `client_id`s rotate with it. Drop an
   * old entry once its tokens have expired; until then it can still forge.
   */
  secret: string | string[];
  resolveUser: (request: Request) => Promise<OAuthUser | null>;
  loginUrl: (request: Request, nextPath: string) => string;
  /** Access-token lifetime in seconds. Default 3600. Must be finite and > 0. */
  ttlSeconds?: number;
  /** Passthrough — production still needs a shared store across instances. */
  codeStore?: CodeStore;
  /**
   * Called with the signed `userId` on every token that passed signature,
   * expiry and shape checks, and on every refresh. Return false for a user
   * who was removed, disabled or signed out everywhere. A throw becomes a 500,
   * never an authenticated request; cache the answer if lookups are slow.
   */
  isUserActive?: UserCheck;
  /**
   * Turns on `grant_type=refresh_token`, with rotation. This is the absolute
   * lifetime of one consent: the user approves again after it, however
   * often the connector refreshes (the last access token it issued can
   * still run for up to `ttlSeconds` longer). Requires `codeStore` (the same
   * instance the router uses) and `isUserActive`.
   */
  refreshTtlSeconds?: number;
};

type AccessPayload = {
  userId: string;
  scopes: string[];
  audience: string;
  exp: number;
};

const parseAccessPayload = (raw: unknown): AccessPayload | null => {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.userId !== "string" || typeof record.audience !== "string") return null;
  if (typeof record.exp !== "number" || !Number.isFinite(record.exp)) return null;
  if (record.exp < Date.now()) return null;
  if (!Array.isArray(record.scopes) || !record.scopes.every((s) => typeof s === "string")) {
    return null;
  }
  return {
    userId: record.userId,
    scopes: record.scopes,
    audience: record.audience,
    exp: record.exp,
  };
};

const toVerified = (payload: AccessPayload): VerifiedToken => ({
  userId: payload.userId,
  scopes: payload.scopes,
  audience: payload.audience,
});

const assertPositiveSeconds = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`signedTokenAuth: ${name} must be a finite number > 0 (got ${value})`);
  }
};

const resolveSecretList = (secret: string | string[]): SecretList => {
  const secrets = Array.isArray(secret) ? [...secret] : [secret];
  if (secrets.length === 0 || secrets.length > MAX_SECRETS) {
    throw new Error(
      `signedTokenAuth: secret needs 1 to ${MAX_SECRETS} entries (got ${secrets.length})`,
    );
  }
  secrets.forEach(assertCodeSecret);
  return secrets as [string, ...string[]];
};

type AccessMinter = (input: MintAccessTokenInput) => Promise<MintedToken>;

const accessMinter =
  (secrets: SecretList, ttlSeconds: number): AccessMinter =>
  async (input) => ({
    accessToken: await signPayload(secrets[0], "access", {
      userId: input.userId,
      scopes: input.scope.split(" ").filter(Boolean),
      audience: input.resource,
      exp: Date.now() + ttlSeconds * 1000,
    } satisfies AccessPayload),
    expiresIn: ttlSeconds,
    scope: input.scope,
  });

/** Signature, then expiry and shape, then the user check: a garbage token never reaches the host. */
const accessVerifier =
  (secrets: SecretList, isUserActive: UserCheck | undefined) =>
  async (token: string): Promise<VerifiedToken | null> => {
    const payload = parseAccessPayload(await verifyPayload(secrets, "access", token));
    if (!payload) return null;
    if (isUserActive && (await isUserActive(payload.userId)) !== true) return null;
    return toVerified(payload);
  };

/** The refresh machinery, or undefined when `refreshTtlSeconds` is unset. */
const refreshTokensFor = (
  options: SignedTokenAuthOptions,
  secrets: SecretList,
  mintAccess: AccessMinter,
): RefreshTokens | undefined => {
  const { refreshTtlSeconds, codeStore, isUserActive } = options;
  if (refreshTtlSeconds === undefined) return undefined;
  assertPositiveSeconds("refreshTtlSeconds", refreshTtlSeconds);
  if (!codeStore) {
    throw new Error(
      "signedTokenAuth: refreshTtlSeconds needs an explicit codeStore (single-use refresh tokens " +
        "must share the router's store; allowInMemoryCodeStore's hidden default is not visible here)",
    );
  }
  if (!isUserActive) {
    throw new Error(
      "signedTokenAuth: refreshTtlSeconds needs isUserActive, or a removed user keeps the connector until the refresh token expires",
    );
  }
  return createRefreshTokens({
    secrets,
    lifetimeMs: refreshTtlSeconds * 1000,
    codeStore,
    isUserActive,
    mintAccess,
  });
};

/** Builds a complete `McpAppAuth` from one secret plus your session resolver. */
export const signedTokenAuth = (options: SignedTokenAuthOptions): McpAppAuth => {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  assertPositiveSeconds("ttlSeconds", ttlSeconds);
  const secrets = resolveSecretList(options.secret);
  const mintAccess = accessMinter(secrets, ttlSeconds);
  const refresh = refreshTokensFor(options, secrets, mintAccess);

  return {
    codeSecret: [...secrets],
    resolveUser: options.resolveUser,
    loginUrl: options.loginUrl,
    mintAccessToken: async (input) => {
      const access = await mintAccess(input);
      return refresh ? { ...access, refreshToken: await refresh.issue(input) } : access;
    },
    verifyToken: accessVerifier(secrets, options.isUserActive),
    ...(refresh ? { refreshAccessToken: refresh.refresh, revokeToken: refresh.revoke } : {}),
    ...(options.codeStore !== undefined ? { codeStore: options.codeStore } : {}),
  };
};
