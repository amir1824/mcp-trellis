/**
 * Invoke `ports.audit`, swallowing any failure and racing it against
 * `auditTimeoutMs` — the OAuth-side twin of `methods.ts`'s `safeAudit`.
 * A hanging sink must not stall `/token` or `/authorize` error responses.
 */

import type { OAuthAuditEntry, OAuthRouterOptions } from "./types.js";

const DEFAULT_OAUTH_AUDIT_TIMEOUT_MS = 1000;

export const safeOAuthAudit = async (
  options: OAuthRouterOptions,
  entry: OAuthAuditEntry,
): Promise<void> => {
  const audit = options.ports.audit;
  if (!audit) return;

  const settled = (async () => {
    try {
      await audit(entry);
    } catch {
      // Intentionally ignored.
    }
  })();

  const timeoutMs = options.auditTimeoutMs ?? DEFAULT_OAUTH_AUDIT_TIMEOUT_MS;
  await Promise.race([settled, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
};
