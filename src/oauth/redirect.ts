export const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

export type RedirectAllowlistOptions = {
  /** Extra exact-match redirect URIs. */
  extra?: string[];
  /** Allow http(s)://127.0.0.1 and localhost (any port). Default true. */
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

const isLoopbackHttp: RedirectPredicate = (uri, options) => {
  if (options.allowLoopback === false) return false;
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return (
      parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost"
    );
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
