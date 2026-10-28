/**
 * Invoke `ports.audit`, swallowing any failure and racing it against
 * `auditTimeoutMs` — the OAuth-side twin of `methods.ts`'s `safeAudit`.
 * A hanging sink must not stall `/token` or `/authorize` error responses.
 */

import { DEFAULT_AUDIT_TIMEOUT_MS, runAuditBounded } from "../http/http.js";
import { clipText } from "../util/clip.js";
import { type CimdFailure, formatCimdFailure } from "./cimd/failure.js";
import type { OAuthAuditEntry, OAuthRouterOptions } from "./types.js";

/**
 * Longest `clientId` / `reason` an audit sink is handed. Both can carry
 * caller-chosen text (`client_id` is read straight off an unauthenticated
 * request, up to the 64 KiB body cap), and a sink writing to a database or log
 * pipeline should not have to defend itself against that.
 */
const MAX_AUDIT_FIELD_LENGTH = 512;

const clip = (value: string): string => clipText(value, MAX_AUDIT_FIELD_LENGTH, "…");

export const safeOAuthAudit = async (
  options: OAuthRouterOptions,
  entry: OAuthAuditEntry,
): Promise<void> => {
  const audit = options.ports.audit;
  if (!audit) return;

  const bounded: OAuthAuditEntry = {
    ...entry,
    ...(entry.clientId !== undefined ? { clientId: clip(entry.clientId) } : {}),
    reason: clip(entry.reason),
  };
  await runAuditBounded(() => audit(bounded), options.auditTimeoutMs ?? DEFAULT_AUDIT_TIMEOUT_MS);
};

/**
 * Fires `legacy_code_secret_used` when a value was recovered with a
 * rotation-array entry other than the primary (`keyIndex > 0`) — the signal
 * every codeSecret rotation site (`/authorize`, `/consent`, `/token`,
 * `firstClientAuthError`) uses to tell an operator which old keys are still
 * live. A no-op for the common case (`keyIndex === 0`, or none at all).
 */
export const auditLegacyKeyUsage = async (
  options: OAuthRouterOptions,
  usage: { clientId: string; keyIndex: number | null | undefined; source: string },
): Promise<void> => {
  if (!usage.keyIndex) return;
  await safeOAuthAudit(options, {
    event: "legacy_code_secret_used",
    clientId: usage.clientId,
    reason: `${usage.source} with codeSecret[${usage.keyIndex}]`,
  });
};

/**
 * Operator-only record of why a CIMD `client_id` did not resolve; the connector
 * is always answered with the same generic `unauthorized_client`.
 */
export const auditCimdFailure = (
  options: OAuthRouterOptions,
  input: { clientId: string; endpoint: "authorize" | "token/revoke"; failure: CimdFailure },
): Promise<void> =>
  safeOAuthAudit(options, {
    event: "cimd_resolve_failed",
    clientId: input.clientId,
    reason: `${formatCimdFailure(input.failure)} (${input.endpoint})`,
  });
