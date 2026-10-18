import type { UnifiedAuditEntry } from "./app-options.js";
import { clipText } from "./util/clip.js";

/** Longest field value a log line carries — `client_id` and tool names are caller-chosen. */
const MAX_LOG_FIELD_LENGTH = 200;

/**
 * Characters JSON leaves raw that still break or spoof a log line: DEL, the C1
 * controls (U+0085 NEL is a line break to some collectors), the Unicode
 * line/paragraph separators, bidi overrides/isolates that reorder how the
 * rest of the line displays, and zero-width / no-break characters that make
 * two different values look identical.
 */
const isLogUnsafe = (code: number): boolean =>
  code === 0x7f ||
  (code >= 0x80 && code <= 0x9f) ||
  code === 0xa0 ||
  code === 0xad ||
  code === 0x061c ||
  code === 0x180e ||
  (code >= 0x200b && code <= 0x200f) ||
  code === 0x2028 ||
  code === 0x2029 ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2060 && code <= 0x2064) ||
  (code >= 0x2066 && code <= 0x2069) ||
  code === 0xfeff;

const escapeLogChar = (ch: string): string => {
  const code = ch.charCodeAt(0);
  return isLogUnsafe(code) ? `\\u${code.toString(16).padStart(4, "0")}` : ch;
};

/** `String(input)`, except that a value with no usable string form still gets a line. */
const printable = (input: unknown): string => {
  if (typeof input === "string") return input;
  try {
    return String(input);
  } catch {
    return "[unprintable]";
  }
};

/**
 * Caller-controlled fields (`client_id`, tool name, error text) must not be
 * able to end the line, start a forged one, or smuggle in a forged
 * `key=value` field. A value is truncated before any work is done on it, then
 * emitted bare when it is plain, and otherwise as a quoted, escaped string —
 * so a space or `=` stays inside the field it arrived in. Escaping can grow a
 * value up to six-fold (`\u0000`), so the output is bounded by that, not by
 * `MAX_LOG_FIELD_LENGTH` alone.
 *
 * Accepts any value: a JS caller (a tool result whose `text` is not a string)
 * can hand over a number or an object, and a log line must not be lost to a
 * `TypeError` for it.
 */
const logField = (input: unknown): string => {
  const truncated = clipText(printable(input), MAX_LOG_FIELD_LENGTH);
  const quoted = Array.from(JSON.stringify(truncated), escapeLogChar).join("");
  const isPlain = quoted === `"${truncated}"` && !/[\s=]/.test(truncated);
  return isPlain ? truncated : quoted;
};

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
      entry.clientId ? `client=${logField(entry.clientId)}` : undefined,
      `reason=${logField(entry.reason)}`,
    ]
      .filter(Boolean)
      .join(" ");
    console.log(line);
    return;
  }

  const line = [
    `[mcp-trellis] mcp ${logField(entry.method) || "(transport)"}`,
    entry.tool ? `tool=${logField(entry.tool)}` : undefined,
    entry.ok ? "ok" : "fail",
    `${entry.durationMs}ms`,
    entry.principalId ? `user=${logField(entry.principalId)}` : undefined,
    entry.error ? `error=${logField(entry.error)}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  if (!entry.ok) {
    console.error(line);
    return;
  }
  console.log(line);
};
