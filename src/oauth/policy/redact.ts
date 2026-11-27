/** Caller-chosen redirect URIs on their way to an audit entry, with nothing secret or misleading. */

import { clipText } from "../../util/clip.js";
import { MAX_CLIENT_REDIRECT_URIS } from "../constants.js";
import { hasHiddenCharacter } from "./redirect.js";

/**
 * Userinfo needs an "@", a query a "?" and a fragment a "#". Anything outside printable ASCII can
 * spell a host that reads as another one; parsed, it shows as punycode or percent-encoded.
 */
const NEEDS_PARSING = /[?#@]|[^\x20-\x7e]/u;
const SCHEME_AND_SLASHES = /^(?:[a-z][a-z0-9+.-]*:)?[/\\]*/iu;
const AUTHORITY_END = /[/\\?#]/u;
const UNREADABLE_URI = "[unreadable URI]";
/** Past ChatGPT's longest callback, and short enough that one entry cannot hide the next. */
const MAX_LISTED_URI_LENGTH = 200;

/**
 * An "@" past the first delimiter may close a userinfo read as host, port and path. Checked on the
 * raw text, because parsing drops a `..` segment together with the "@" inside it.
 */
const hasLateAt = (uri: string): boolean => {
  const rest = uri.replace(SCHEME_AND_SLASHES, "");
  const end = rest.search(AUTHORITY_END);
  return end >= 0 && rest.includes("@", end);
};

/** The URI without userinfo, query and fragment, or a placeholder when it cannot be shown safely. */
const redacted = (uri: string): string => {
  if (hasHiddenCharacter(uri)) return UNREADABLE_URI;
  // Entries are joined by spaces, so one holding a space must not read as two.
  const shown = uri.replaceAll(" ", "%20");
  // Left as asked: an operator may need the exact string for an allowlist.
  if (!NEEDS_PARSING.test(shown)) return shown;
  if (hasLateAt(shown)) return UNREADABLE_URI;
  try {
    const url = new URL(shown);
    // An opaque URI (`myapp:user:pw@host`) keeps what looks like userinfo in its path.
    if (url.pathname.includes("@")) return UNREADABLE_URI;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return UNREADABLE_URI;
  }
};

/**
 * The string entries among the first ones a registration may hold, each shortened. Anything else is
 * skipped: a refused body is unvalidated, and converting an object to text can throw.
 */
export const redirectUrisForAudit = (requested: unknown): string[] => {
  const entries = Array.isArray(requested) ? requested.slice(0, MAX_CLIENT_REDIRECT_URIS) : [];
  return entries
    .filter((uri): uri is string => typeof uri === "string")
    .map((uri) => clipText(redacted(uri), MAX_LISTED_URI_LENGTH, "…"));
};
