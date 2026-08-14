import type { AuditEntry } from "./methods.js";

/**
 * Convenience `audit` sink that logs each entry to the console.
 *
 * The real metrics hook is any function you pass as `audit` — the library
 * never writes to stdout or a store on its own. Use this for local / small
 * deploys; swap in your own function for DB, APM, or an admin feed
 * (see `examples/audit-store.ts`):
 *
 *   createMcpApp({ ..., audit: consoleAudit })
 *   createMcpApp({ ..., audit: (entry) => { void insert(entry) } })
 *
 * Failures (`ok: false`, including transport-level denials and tool
 * exceptions) go to `console.error`; everything else to `console.log`.
 * Entries never carry raw exceptions or stack traces (see `AuditEntry`).
 */
export const consoleAudit = (entry: AuditEntry): void => {
  const line = [
    `[mcp-trellis] ${entry.method || "(transport)"}`,
    entry.tool ? `tool=${entry.tool}` : undefined,
    entry.ok ? "ok" : "fail",
    `${entry.durationMs}ms`,
    entry.principalId ? `user=${entry.principalId}` : undefined,
    entry.error ? `error=${entry.error}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  if (entry.ok) {
    console.log(line);
  } else {
    console.error(line);
  }
};
