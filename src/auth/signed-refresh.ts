/**
 * Stateless refresh tokens for `signedTokenAuth`. Internal: not exported
 * from the package.
 *
 * Signed, not stored. The only state is the single-use `jti` mark in the
 * shared `codeStore`, which is what makes rotation work: a refresh token is
 * accepted once and its successor is a different token.
 *
 * ponytail: a replayed, already-rotated token is refused, but there is no
 * token family to revoke when that happens, so the thief's successor stays
 * valid until `exp` or until `isUserActive` turns false. Upgrade: an opaque
 * server-side refresh store (see `examples/project-desk/src/tokens.ts`).
 */

import type { CodeStore } from "../oauth/crypto/codes.js";
import { randomBase64Url } from "../oauth/crypto/pkce.js";
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

type RefreshPayload = {
  userId: string;
  scopes: string[];
  audience: string;
  clientId: string;
  /** Fixed when the grant is consented; rotation never extends it. */
  exp: number;
  jti: string;
};

export type RefreshTokenConfig = {
  secrets: readonly [string, ...string[]];
  lifetimeMs: number;
  codeStore: CodeStore;
  isUserActive: (userId: string) => boolean | Promise<boolean>;
  mintAccess: (input: MintAccessTokenInput) => Promise<MintedToken>;
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const hasText = (value: unknown, maxLength: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maxLength;

const parseRefreshPayload = (raw: unknown): RefreshPayload | null => {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (!hasText(record.userId, 1024) || !hasText(record.clientId, 2048)) return null;
  if (!hasText(record.audience, 2048) || !hasText(record.jti, MAX_JTI_LENGTH)) return null;
  if (!isStringArray(record.scopes) || record.scopes.length === 0) return null;
  if (typeof record.exp !== "number" || !Number.isFinite(record.exp)) return null;
  if (record.exp <= Date.now()) return null;
  return {
    userId: record.userId,
    clientId: record.clientId,
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

export const createRefreshTokens = (config: RefreshTokenConfig) => {
  const sign = (payload: RefreshPayload): Promise<string> =>
    signPayload(config.secrets[0], "refresh", payload);

  const read = async (token: string): Promise<RefreshPayload | null> =>
    parseRefreshPayload(await verifyPayload(config.secrets, "refresh", token));

  // `=== true`: only a store that says so burns the token; a throw propagates
  // as a 500 instead of letting a replay through.
  const burn = async (payload: RefreshPayload): Promise<boolean> =>
    (await config.codeStore.consume(`${JTI_KEY_PREFIX}${payload.jti}`, payload.exp)) === true;

  return {
    issue: (grant: MintAccessTokenInput): Promise<string> =>
      sign({
        userId: grant.userId,
        scopes: grant.scope.split(" ").filter(Boolean),
        audience: grant.resource,
        clientId: grant.clientId,
        exp: Date.now() + config.lifetimeMs,
        jti: randomBase64Url(JTI_BYTES),
      }),

    /**
     * Order matters: every check that can fail on the caller's input runs
     * before `burn`, so a wrong-client or wrong-resource attempt cannot
     * spend the rightful holder's token.
     */
    refresh: async (input: RefreshAccessTokenInput): Promise<MintedToken | null> => {
      const payload = await read(input.refreshToken);
      if (!payload || payload.clientId !== input.clientId) return null;
      if (!resourcesEqual(payload.audience, input.resource)) return null;
      const scopes = narrowedScopes(payload.scopes, input.scope);
      if (!scopes) return null;
      if ((await config.isUserActive(payload.userId)) !== true) return null;
      if (!(await burn(payload))) return null;

      const access = await config.mintAccess({
        userId: payload.userId,
        clientId: payload.clientId,
        scope: scopes.join(" "),
        resource: payload.audience,
      });
      const successor = await sign({ ...payload, jti: randomBase64Url(JTI_BYTES) });
      return { ...access, refreshToken: successor };
    },

    /** RFC 7009: an unusable or foreign token is a silent no-op; a store failure is not. */
    revoke: async (input: RevokeTokenInput): Promise<void> => {
      const payload = await read(input.token);
      if (payload?.clientId === input.clientId) await burn(payload);
    },
  };
};
