/**
 * Invoke `ports.audit`, swallowing any failure and racing it against
 * `auditTimeoutMs` — the OAuth-side twin of `methods.ts`'s `safeAudit`.
 * A hanging sink must not stall `/token` or `/authorize` error responses.
 */

import { DEFAULT_AUDIT_TIMEOUT_MS, runAuditBounded } from "../http/http.js";
import type { OAuthAuditEntry, OAuthRouterOptions } from "./types.js";

export const safeOAuthAudit = async (
  options: OAuthRouterOptions,
  entry: OAuthAuditEntry,
): Promise<void> => {
  const audit = options.ports.audit;
  if (!audit) return;

  await runAuditBounded(() => audit(entry), options.auditTimeoutMs ?? DEFAULT_AUDIT_TIMEOUT_MS);
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
