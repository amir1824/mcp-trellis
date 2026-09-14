import type { UnifiedAuditEntry } from "./app-options.js";

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
 * MCP failures (`ok: false`) go to `console.error`; MCP successes and
 * OAuth events go to `console.log`. Entries never carry raw exceptions or
 * stack traces (see `AuditEntry` / `OAuthAuditEntry`).
 */
export const consoleAudit = (entry: UnifiedAuditEntry): void => {
  if (entry.source === "oauth") {
    const line = [
      `[mcp-trellis] oauth`,
      entry.event,
      entry.clientId ? `client=${entry.clientId}` : undefined,
      `reason=${entry.reason}`,
    ]
      .filter(Boolean)
      .join(" ");
    console.log(line);
    return;
  }

  const line = [
    `[mcp-trellis] mcp ${entry.method || "(transport)"}`,
    entry.tool ? `tool=${entry.tool}` : undefined,
    entry.ok ? "ok" : "fail",
    `${entry.durationMs}ms`,
    entry.principalId ? `user=${entry.principalId}` : undefined,
    entry.error ? `error=${entry.error}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  if (!entry.ok) {
    console.error(line);
    return;
  }
  console.log(line);
};
