export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

export type RedirectAllowlistOptions = {
  /** Extra exact-match redirect URIs. */
  extra?: string[];
  /**
   * Allow `http:` loopback hosts — `127.0.0.1`, `[::1]` (any port). Default
   * true. `localhost` is deliberately not included: RFC 8252 §8.3 — it's
   * DNS-resolvable, so it isn't a loopback guarantee. `https:` is likewise
   * excluded — RFC 8252 native-app loopback redirects are `http:` only.
   */
  allowLoopback?: boolean;
  /** Allow the Claude.ai Custom Connector callback. Default true. */
  allowClaude?: boolean;
};

type RedirectPredicate = (uri: string, options: RedirectAllowlistOptions) => boolean;

const isClaudeCallback: RedirectPredicate = (uri, options) =>
  options.allowClaude !== false && uri === CLAUDE_CALLBACK;

const isExtraAllowed: RedirectPredicate = (uri, options) => Boolean(options.extra?.includes(uri));

/**
 * WHATWG URL keeps IPv6 hosts bracketed, so `[::1]` is the parsed hostname.
 * `http://127.1/cb` and `http://2130706433/cb` normalize to `127.0.0.1` here
 * and are genuinely loopback; `0.0.0.0` is not, and is deliberately absent.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

const isLoopbackHttp: RedirectPredicate = (uri, options) => {
  if (options.allowLoopback === false) return false;
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "http:") return false;
    return LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
};

const REDIRECT_PREDICATES: RedirectPredicate[] = [isClaudeCallback, isExtraAllowed, isLoopbackHttp];

/** RFC 6749 forbids a fragment in redirect_uri; embedded credentials are never legitimate. */
const carriesFragmentOrCredentials = (uri: string): boolean => {
  try {
    const parsed = new URL(uri);
    return parsed.hash !== "" || parsed.username !== "" || parsed.password !== "";
  } catch {
    return false;
  }
};

export const isAllowedRedirectUri = (
  uri: string,
  options: RedirectAllowlistOptions = {},
): boolean => {
  if (carriesFragmentOrCredentials(uri)) return false;
  return REDIRECT_PREDICATES.some((predicate) => predicate(uri, options));
};
