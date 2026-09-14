import { randomBase64Url } from "./pkce.js";
import { seal, unsealAny } from "./sealed.js";

const CODE_TTL_MS = 600_000;
/** AES-GCM sealed auth codes — authenticated and encrypted (see `sealed.ts`). */
const SEALED_PREFIX = "v2.";

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

/**
 * Prune the in-memory store at most this often, not on every `consume` call
 * — a full-`Map`-scan-per-call became a real cost once `consent.ts` started
 * sharing this same store (every code *and* every consent ticket now scans
 * it on redemption).
 */
const PRUNE_INTERVAL_MS = 60_000;

/**
 * Process-local jti → expMs map when no shared codeStore is provided.
 * ponytail: single-process only; multi-instance → pass ports.codeStore (KV/Redis SET NX EX).
 */
export const createMemoryCodeStore = (): CodeStore => {
  const used = new Map<string, number>();
  let lastPrunedAtMs = 0;
  return {
    consume: (jti, expMs) => {
      const nowMs = Date.now();
      if (nowMs - lastPrunedAtMs >= PRUNE_INTERVAL_MS) {
        lastPrunedAtMs = nowMs;
        for (const [key, exp] of used) {
          if (exp < nowMs) used.delete(key);
        }
      }
      if (used.has(jti)) return false;
      used.set(jti, expMs);
      return true;
    },
  };
};

/**
 * The default single-process store when no `ports.codeStore` is
 * configured — shared with `consent.ts` (its `ct:`-prefixed jtis live in
 * the same map, disambiguated by that prefix) so there's exactly one Map
 * and one prune throttle for both auth codes and consent tickets, not two
 * independent, unthrottled ones.
 */
export const memoryCodeStore: CodeStore = createMemoryCodeStore();

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

/**
 * Rotation-aware `consumeAuthCode`, also reporting which `secret` entry
 * actually unsealed the code — used only by `token.ts` to audit
 * `"legacy_code_secret_used"` without a second decrypt pass. Not part of
 * the public API; `consumeAuthCode` below is the stable, exported surface.
 */
export const consumeAuthCodeDetailed = async (
  secret: string | readonly string[],
  code: string,
  options: { codeStore?: CodeStore | undefined; nowMs?: number | undefined } = {},
): Promise<{ record: AuthCodeRecord; keyIndex: number } | null> => {
  const secrets = (Array.isArray(secret) ? secret : [secret]).filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  if (!code || secrets.length === 0) return null;
  // 1.0 dropped v1 (HMAC-only) reading — only `v2.` sealed codes redeem.
  if (!code.startsWith(SEALED_PREFIX)) return null;

  const nowMs = options.nowMs ?? Date.now();
  const unsealed = await unsealAny<RawAuthCode>(secrets, "code", code.slice(SEALED_PREFIX.length));
  if (!unsealed) return null;

  const record = shapeCheckedRecord(unsealed.value, nowMs);
  if (!record) return null;

  const store = options.codeStore ?? memoryCodeStore;
  const fresh = await store.consume(record.jti, record.exp);
  if (!fresh) return null;

  const { jti: _jti, ...rest } = record;
  return { record: rest, keyIndex: unsealed.keyIndex };
};

/**
 * `secret` may be a single key (unchanged behavior) or a list — every entry
 * is tried, so a code sealed under an older `codeSecret` keeps redeeming
 * during rotation. See `resolveSecrets`/`OAuthPorts.codeSecret` for the
 * rotation contract; use `consumeAuthCodeDetailed` if you also need to know
 * which key matched.
 */
export const consumeAuthCode = async (
  secret: string | readonly string[],
  code: string,
  options: { codeStore?: CodeStore | undefined; nowMs?: number | undefined } = {},
): Promise<AuthCodeRecord | null> => {
  const result = await consumeAuthCodeDetailed(secret, code, options);
  return result?.record ?? null;
};

export const newClientId = (): string => randomBase64Url(16);
