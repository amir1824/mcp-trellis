/**
 * Convenience auth: one secret seals OAuth codes (via `codeSecret`) and
 * signs short-lived access tokens. Domain separation is HKDF, not luck —
 * access-token HMAC uses `mcp-trellis:signed-access-token:v1`, distinct from
 * the sealed-code and client-secret-hash labels.
 *
 * ponytail: stateless tokens cannot be revoked before `exp`. No
 * `refreshAccessToken` / `revokeToken` — `/revoke` stays unmounted and
 * refresh unadvertised. Upgrade: supply those ports plus a store (see
 * `examples/project-desk/src/tokens.ts`).
 */

import type { McpAppAuth, VerifiedToken } from "../app-options.js";
import { bytesToBase64Url, fromBase64Url } from "../oauth/crypto/base64url.js";
import type { CodeStore } from "../oauth/crypto/codes.js";
import { hkdfKey } from "../oauth/crypto/hkdf.js";
import type { MintAccessTokenInput, MintedToken, OAuthUser } from "../oauth/types.js";

const HKDF_INFO = "mcp-trellis:signed-access-token:v1";
const HMAC_SHA256: HmacKeyGenParams = { name: "HMAC", hash: "SHA-256", length: 256 };
const DEFAULT_TTL_SECONDS = 3600;

export type SignedTokenAuthOptions = {
  secret: string;
  resolveUser: (request: Request) => Promise<OAuthUser | null>;
  loginUrl: (request: Request, nextPath: string) => string;
  /** Access-token lifetime in seconds. Default 3600. Must be finite and > 0. */
  ttlSeconds?: number;
  /** Passthrough — production still needs a shared store across instances. */
  codeStore?: CodeStore;
};

type SignedTokenPayload = {
  userId: string;
  scopes: string[];
  audience: string;
  exp: number;
};

const accessKey = (secret: string, usage: "sign" | "verify"): Promise<CryptoKey> =>
  hkdfKey(secret, { info: HKDF_INFO, algorithm: HMAC_SHA256, usage });

const signPayload = async (secret: string, payload: SignedTokenPayload): Promise<string> => {
  const key = await accessKey(secret, "sign");
  const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${bytesToBase64Url(signature)}`;
};

const parsePayload = (raw: unknown): SignedTokenPayload | null => {
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

const verifyPayload = async (secret: string, token: string): Promise<SignedTokenPayload | null> => {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature) return null;

  try {
    const key = await accessKey(secret, "verify");
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(signature),
      new TextEncoder().encode(body),
    );
    if (!ok) return null;
    return parsePayload(JSON.parse(new TextDecoder().decode(fromBase64Url(body))));
  } catch {
    return null;
  }
};

const mint = async (
  secret: string,
  ttlSeconds: number,
  input: MintAccessTokenInput,
): Promise<MintedToken> => {
  const scopes = input.scope.split(" ").filter(Boolean);
  const accessToken = await signPayload(secret, {
    userId: input.userId,
    scopes,
    audience: input.resource,
    exp: Date.now() + ttlSeconds * 1000,
  });
  return { accessToken, expiresIn: ttlSeconds, scope: input.scope };
};

const toVerified = (payload: SignedTokenPayload): VerifiedToken => ({
  userId: payload.userId,
  scopes: payload.scopes,
  audience: payload.audience,
});

/** Builds a complete `McpAppAuth` from one secret plus your session resolver. */
export const signedTokenAuth = (options: SignedTokenAuthOptions): McpAppAuth => {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`signedTokenAuth: ttlSeconds must be a finite number > 0 (got ${ttlSeconds})`);
  }
  const { secret } = options;
  return {
    codeSecret: secret,
    resolveUser: options.resolveUser,
    loginUrl: options.loginUrl,
    mintAccessToken: (input) => mint(secret, ttlSeconds, input),
    verifyToken: async (token) => {
      const payload = await verifyPayload(secret, token);
      return payload ? toVerified(payload) : null;
    },
    ...(options.codeStore !== undefined ? { codeStore: options.codeStore } : {}),
  };
};
