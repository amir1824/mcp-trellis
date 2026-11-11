/**
 * What the built-in consent screen may say about who is asking.
 *
 * The server controls two facts: the redirect URI, and (for CIMD) the host the
 * client's metadata document was fetched from. A client-supplied name is not
 * verified, so it is cleaned, and hidden when it could pass for a known vendor.
 */

import type { CimdDocument } from "../../cimd/types.js";
import {
  CHATGPT_CALLBACK,
  isAllowedRedirectUri,
  LOOPBACK_HOSTS,
  type RedirectAllowlistOptions,
} from "../../policy/redirect.js";

const MAX_NAME_CODE_POINTS = 64;
/** Pointed Hebrew and Arabic stack up to four marks on one letter; more than that is abuse. */
const MAX_COMBINING_MARKS = 4;

const NO_REDIRECTS = { allowLoopback: false, allowClaude: false, allowChatgptConnector: false };

/** What a vendor owns: the redirect URIs its connector uses and the domains it serves documents from. */
type Vendor = { redirects: RedirectAllowlistOptions; hosts: string[] };

const CLAUDE: Vendor = {
  redirects: { ...NO_REDIRECTS, allowClaude: true },
  hosts: ["claude.ai"],
};
const ANTHROPIC: Vendor = { redirects: CLAUDE.redirects, hosts: ["claude.ai", "anthropic.com"] };
const OPENAI: Vendor = {
  redirects: { ...NO_REDIRECTS, allowChatgptConnector: true, extra: [CHATGPT_CALLBACK] },
  hosts: ["chatgpt.com", "openai.com"],
};
/** Gemini's client is pre-registered, so a CIMD name claiming it is never shown. */
const GEMINI: Vendor = { redirects: { ...NO_REDIRECTS, extra: [] }, hosts: [] };

/**
 * A folded name containing one of these tokens claims to be that vendor. It is shown only
 * when the redirect URI and the document's host both belong to that vendor.
 * ponytail: only the common look-alikes are folded (I/l/1, rn/m, accents, digit swaps). A name
 * spelled entirely in Cyrillic or Greek look-alikes, with no Latin letter, is not caught (a
 * name that mixes them with Latin, or has a Latin letter with no ASCII form, is hidden); it
 * stays labelled unverified.
 */
const VENDORS: Record<string, Vendor> = {
  claude: CLAUDE,
  anthropic: ANTHROPIC,
  chatgpt: OPENAI,
  codex: OPENAI,
  openai: OPENAI,
  gemini: GEMINI,
};

const LEET_LETTERS: Record<string, string> = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s" };

/** Accents, case, punctuation, spacing and common digit-for-letter swaps do not change the name. */
const fold = (name: string): string =>
  name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[01345]/g, (digit) => LEET_LETTERS[digit] ?? digit)
    .replace(/[^\p{L}\p{N}]/gu, "");

/** Shapes that read alike: capital I, l and 1 are one letter, and "rn" reads as "m". */
const skeleton = (name: string): string => fold(name).replace(/rn/g, "m").replace(/[il]/g, "l");

const VENDOR_TOKENS = Object.entries(VENDORS).map(([token, vendor]) => ({
  token: skeleton(token),
  vendor,
}));

/** Control, format (zero-width, bidi) and blank-filler characters: they render as nothing. */
const INVISIBLE = /[\p{C}\u115F\u1160\u2800\u3164\uFFA0]/gu;
const COMBINING_RUN = new RegExp(`(\\p{M}{${MAX_COMBINING_MARKS}})\\p{M}+`, "gu");
const VISIBLE = /[\p{L}\p{N}]/u;
const LATIN = /\p{Script=Latin}/u;
const LOOKALIKE_SCRIPTS = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;
/** A lowercase Latin-script letter outside a-z, such as the look-alikes of a, g or small caps. */
const NON_ASCII_LATIN = /(?![a-z])\p{Script=Latin}/u;

/** Strips invisible characters, collapses whitespace and stacked marks, caps the length. */
export const sanitizeClientName = (raw: string): string | undefined => {
  const cleaned = raw
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .replace(INVISIBLE, "")
    .replace(/\s+/gu, " ")
    .replace(COMBINING_RUN, "$1")
    .trim();
  const clipped = Array.from(cleaned).slice(0, MAX_NAME_CODE_POINTS).join("").trim();
  return VISIBLE.test(clipped) ? clipped : undefined;
};

/** Exact host match: a vendor's subdomain may serve content the vendor does not control. */
const hostBelongsTo = (hostname: string | undefined, domains: string[]): boolean =>
  hostname !== undefined && domains.includes(hostname);

/** Latin mixed with Cyrillic or Greek, or a Latin letter with no ASCII form: fail closed. */
const hasLookalikeLetters = (name: string): boolean =>
  (LATIN.test(name) && LOOKALIKE_SCRIPTS.test(name)) || NON_ASCII_LATIN.test(fold(name));

const claimsUnownedVendor = (
  name: string,
  redirectUri: string,
  documentHost: string | undefined,
): boolean => {
  const folded = skeleton(name);
  return VENDOR_TOKENS.some(
    ({ token, vendor }) =>
      folded.includes(token) &&
      !(
        isAllowedRedirectUri(redirectUri, vendor.redirects) &&
        hostBelongsTo(documentHost, vendor.hosts)
      ),
  );
};

/** The name worth showing under "name not verified", or undefined when it should not be shown. */
const showableName = (
  raw: unknown,
  redirectUri: string,
  documentHost: string | undefined,
): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const name = sanitizeClientName(raw);
  if (name === undefined) return undefined;
  if (hasLookalikeLetters(name)) return undefined;
  return claimsUnownedVendor(name, redirectUri, documentHost) ? undefined : name;
};

/** The host a person can recognise: ASCII or punycode, never client-chosen text. */
const hostLabel = (url: URL | undefined): string | undefined => {
  if (url === undefined) return undefined;
  const { protocol, hostname, host, port } = url;
  if (protocol !== "http:" && protocol !== "https:") return `An app using ${protocol}`;
  if (LOOPBACK_HOSTS.has(hostname)) {
    return port === "" ? "An app on this device" : `An app on this device (port ${port})`;
  }
  return host;
};

const parseUrl = (uri: string): URL | undefined => {
  try {
    return new URL(uri);
  } catch {
    return undefined;
  }
};

type ClientIdentityInput = {
  /** The `client_id` of the request; for a CIMD client it is the URL the document was fetched from. */
  clientId: string;
  redirectUri: string;
  /** Present only for a CIMD client. */
  cimdDoc?: CimdDocument | undefined;
};

export type ClientIdentity = {
  clientHost?: string;
  clientName?: string;
};

/** Only a CIMD client has a name to show; its host is where the document was served. */
export const describeClient = ({
  clientId,
  redirectUri,
  cimdDoc,
}: ClientIdentityInput): ClientIdentity => {
  const subject = parseUrl(cimdDoc ? clientId : redirectUri);
  const clientHost = hostLabel(subject);
  const clientName = cimdDoc
    ? showableName(cimdDoc.client_name, redirectUri, subject?.hostname)
    : undefined;
  return {
    ...(clientHost !== undefined ? { clientHost } : {}),
    ...(clientName !== undefined ? { clientName } : {}),
  };
};
