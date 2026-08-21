import { randomBase64Url } from "./pkce.js";
import { seal, unseal } from "./sealed.js";

const CODE_TTL_MS = 600_000;
/** AES-GCM sealed auth codes — authenticated and encrypted (see `sealed.ts`). */
const SEALED_PREFIX = "v2.";

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

/**
 * Issue an AES-GCM sealed auth code (v2). Single-use via codeStore, or
 * pruning in-memory Map when omitted.
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
  return `${SEALED_PREFIX}${await seal(secret, "code", body)}`;
};

type RawAuthCode = Partial<AuthCodeRecord> & { jti?: string };

const shapeCheckedRecord = (
  data: RawAuthCode,
  nowMs: number,
): (AuthCodeRecord & { jti: string }) | null => {
  if (
    typeof data.clientId !== "string" ||
    typeof data.redirectUri !== "string" ||
    typeof data.codeChallenge !== "string" ||
    typeof data.userId !== "string" ||
    typeof data.resource !== "string" ||
    data.resource.length === 0 ||
    typeof data.scope !== "string" ||
    typeof data.exp !== "number" ||
    data.exp < nowMs ||
    typeof data.jti !== "string" ||
    data.jti.length === 0
  ) {
    return null;
  }
  return {
    clientId: data.clientId,
    redirectUri: data.redirectUri,
    codeChallenge: data.codeChallenge,
    userId: data.userId,
    resource: data.resource,
    scope: data.scope,
    exp: data.exp,
    jti: data.jti,
  };
};

export const consumeAuthCode = async (
  secret: string,
  code: string,
  options: { codeStore?: CodeStore | undefined; nowMs?: number | undefined } = {},
): Promise<AuthCodeRecord | null> => {
  if (!code || !secret) return null;
  // 1.0 dropped v1 (HMAC-only) reading — only `v2.` sealed codes redeem.
  if (!code.startsWith(SEALED_PREFIX)) return null;

  const nowMs = options.nowMs ?? Date.now();
  const raw = await unseal<RawAuthCode>(secret, "code", code.slice(SEALED_PREFIX.length));
  if (!raw) return null;

  const record = shapeCheckedRecord(raw, nowMs);
  if (!record) return null;

  const store = options.codeStore ?? memoryCodeStore;
  const fresh = await store.consume(record.jti, record.exp);
  if (!fresh) return null;

  const { jti: _jti, ...rest } = record;
  return rest;
};

export const newClientId = (): string => randomBase64Url(16);
