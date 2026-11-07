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
import { parseScope } from "../oauth/policy/scope.js";
import type { OAuthUser } from "../oauth/types.js";
import {
  type GrantClaims,
  parseGrantClaims,
  signPayload,
  verifyPayload,
} from "./signed-payload.js";
import {
  type AccessMinter,
  createRefreshTokens,
  type RefreshTokens,
  type SecretList,
  type UserCheck,
} from "./signed-refresh.js";

const DEFAULT_TTL_SECONDS = 3600;
/** Each secret costs a key derivation per token kind, so rotation lists stay short. */
const MAX_SECRETS = 8;

export type SignedTokenAuthOptions = {
  /** One secret, or a rotation list: the first signs, every entry verifies (and seals codes). */
  secret: string | string[];
  resolveUser: (request: Request) => Promise<OAuthUser | null>;
  loginUrl: (request: Request, nextPath: string) => string;
  /** Access-token lifetime in seconds. Default 3600. Must be finite and > 0. */
  ttlSeconds?: number;
  /** Passthrough — production still needs a shared store across instances. */
  codeStore?: CodeStore;
  /**
   * Checked on every verified token and every refresh; only `true` passes and a
   * throw is a 500. See docs/security.md#sessions-and-expiry.
   */
  isUserActive?: UserCheck;
  /**
   * Enables rotating refresh tokens; also the absolute lifetime of one consent.
   * Needs `codeStore` and `isUserActive`. See docs/security.md#sessions-and-expiry.
   */
  refreshTtlSeconds?: number;
};

const toVerified = ({ userId, scopes, audience }: GrantClaims): VerifiedToken => ({
  userId,
  scopes,
  audience,
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

const accessMinter =
  (secrets: SecretList, ttlSeconds: number): AccessMinter =>
  async (input) => ({
    accessToken: await signPayload(secrets[0], "access", {
      userId: input.userId,
      scopes: parseScope(input.scope),
      audience: input.resource,
      exp: Date.now() + ttlSeconds * 1000,
    } satisfies GrantClaims),
    expiresIn: ttlSeconds,
    scope: input.scope,
  });

/** Signature, then expiry and shape, then the user check: a garbage token never reaches the host. */
const accessVerifier =
  (secrets: SecretList, isUserActive: UserCheck | undefined) =>
  async (token: string): Promise<VerifiedToken | null> => {
    const payload = parseGrantClaims(await verifyPayload(secrets, "access", token));
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
