export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

export type RedirectAllowlistOptions = {
  /** Extra exact-match redirect URIs. */
  extra?: string[];
  /** Allow http(s) loopback hosts — 127.0.0.1, [::1], localhost (any port). Default true. */
  allowLoopback?: boolean;
  /** Allow the Claude.ai Custom Connector callback. Default true. */
  allowClaude?: boolean;
};

type RedirectPredicate = (
  uri: string,
  options: RedirectAllowlistOptions,
) => boolean;

const isClaudeCallback: RedirectPredicate = (uri, options) =>
  options.allowClaude !== false && uri === CLAUDE_CALLBACK;

const isExtraAllowed: RedirectPredicate = (uri, options) =>
  Boolean(options.extra?.includes(uri));

/** WHATWG URL keeps IPv6 hosts bracketed, so `[::1]` is the parsed hostname. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

const isLoopbackHttp: RedirectPredicate = (uri, options) => {
  if (options.allowLoopback === false) return false;
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
};

const REDIRECT_PREDICATES: RedirectPredicate[] = [
  isClaudeCallback,
  isExtraAllowed,
  isLoopbackHttp,
];

export const isAllowedRedirectUri = (
  uri: string,
  options: RedirectAllowlistOptions = {},
): boolean => REDIRECT_PREDICATES.some((predicate) => predicate(uri, options));
