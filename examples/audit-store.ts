/**
 * Wire `audit` to a host sink — typechecked sketch, not an e2e fixture.
 *
 * Pass any `(entry) => …` as `audit` to get per-request metrics (tool
 * results + denials). The library stays silent until you do. In production
 * replace the ring push with your DB insert / APM client, then expose the
 * rows from your own admin UI.
 *
 * In an app, import from `mcp-trellis`.
 */

import type { AuditEntry } from "../src/methods.js";

/** Process-local ring for demos and tests — newest last. */
export const createAuditRing = (options?: { limit?: number }) => {
  const limit = options?.limit ?? 100;
  const entries: AuditEntry[] = [];
  return {
    audit: (entry: AuditEntry): void => {
      entries.push(entry);
      if (entries.length > limit) entries.shift();
    },
    list: (): readonly AuditEntry[] => entries,
  };
};

/*
 * Production sketch — same port, your store:
 *
 *   const audit = async (entry: AuditEntry) => {
 *     await db.insert("mcp_audit_events", {
 *       method: entry.method,
 *       tool: entry.tool ?? null,
 *       principal_id: entry.principalId ?? null,
 *       ok: entry.ok,
 *       error: entry.error ?? null,
 *       duration_ms: entry.durationMs,
 *     });
 *   };
 *
 *   createMcpApp({ …, audit });
 *
 * Or keep a ring for an in-process admin page:
 *
 *   const ring = createAuditRing({ limit: 500 });
 *   createMcpApp({ …, audit: ring.audit });
 *   // later: ring.list()
 */
