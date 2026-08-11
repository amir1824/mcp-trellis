import { randomBase64Url } from "./pkce.js";
import { bytesToBase64Url, fromBase64Url, textToBase64Url } from "./base64url.js";
import { timingSafeEqual } from "../auth/bearer.js";

const CODE_TTL_MS = 600_000;

/**
 * Process-local jti → expMs map when no shared codeStore is provided.
 * ponytail: single-process only; multi-instance → pass ports.codeStore (KV/Redis SET NX EX).
 */
const memoryUsed = new Map<string, number>();

export type AuthCodeRecord = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  /** Consenting user id — required so minted tokens are bound. */
  userId: string;
  /** RFC 8707 resource indicator — audience for the eventual access token. */
  resource: string;
  /** Space-delimited scope granted at authorize time. */
  scope: string;
  exp: number;
};

export type CodeStore = {
  /**
   * Mark a code jti as consumed; return false if already used.
   * `expMs` is the code expiry (ms since epoch) for TTL-backed stores.
   */
  consume: (jti: string, expMs: number) => Promise<boolean> | boolean;
};

const pruneMemory = (nowMs: number): void => {
  [...memoryUsed].forEach(([jti, exp]) => {
    if (exp < nowMs) memoryUsed.delete(jti);
  });
};

const memoryCodeStore: CodeStore = {
  consume: (jti, expMs) => {
    const nowMs = Date.now();
    pruneMemory(nowMs);
    if (memoryUsed.has(jti)) return false;
    memoryUsed.set(jti, expMs);
    return true;
  },
};

const hmacSign = async (secret: string, payload: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return bytesToBase64Url(sig);
};

/**
 * Issue an HMAC-signed auth code.
 * Single-use via codeStore, or pruning in-memory Map when omitted.
 */
export const issueAuthCode = async (
  secret: string,
  record: Omit<AuthCodeRecord, "exp">,
  nowMs = Date.now(),
): Promise<string> => {
  const body: AuthCodeRecord & { jti: string } = {
    ...record,
    exp: nowMs + CODE_TTL_MS,
    jti: randomBase64Url(12),
  };
  const payload = textToBase64Url(JSON.stringify(body));
  const sig = await hmacSign(secret, payload);
  return `${payload}.${sig}`;
};

export const consumeAuthCode = async (
  secret: string,
  code: string,
  options: { codeStore?: CodeStore; nowMs?: number } = {},
): Promise<AuthCodeRecord | null> => {
  if (!code || !secret) return null;
  const parts = code.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!payload || !sig) return null;

  const expected = await hmacSign(secret, payload);
  if (!timingSafeEqual(sig, expected)) return null;

  try {
    const raw = new TextDecoder().decode(fromBase64Url(payload));
    const data = JSON.parse(raw) as Partial<AuthCodeRecord> & { jti?: string };
    const nowMs = options.nowMs ?? Date.now();
    if (
      typeof data.clientId !== "string" ||
      typeof data.redirectUri !== "string" ||
      typeof data.codeChallenge !== "string" ||
      typeof data.userId !== "string" ||
      typeof data.resource !== "string" ||
      data.resource.length === 0 ||
      typeof data.scope !== "string" ||
      typeof data.exp !== "number" ||
      data.exp < nowMs
    ) {
      return null;
    }

    if (typeof data.jti !== "string" || data.jti.length === 0) return null;

    const store = options.codeStore ?? memoryCodeStore;
    const fresh = await store.consume(data.jti, data.exp);
    if (!fresh) return null;

    return {
      clientId: data.clientId,
      redirectUri: data.redirectUri,
      codeChallenge: data.codeChallenge,
      userId: data.userId,
      resource: data.resource,
      scope: data.scope,
      exp: data.exp,
    };
  } catch {
    return null;
  }
};

export const newClientId = (): string => randomBase64Url(16);
