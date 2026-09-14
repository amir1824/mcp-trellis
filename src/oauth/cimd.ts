/**
 * Client ID Metadata Documents (CIMD) — MCP 2026-07-28 / OAuth client metadata
 * published at an HTTPS URL used as `client_id`.
 *
 * An AS that fetches attacker-supplied URLs is an SSRF engine unless every
 * fetch is constrained. Limits: HTTPS only, public clients only, 5 KB body,
 * 10 s timeout, no private/loopback/link-local targets (including bracketed
 * IPv6), limited redirects, DNS resolution check when a lookup is available,
 * and http(s)-only redirect_uris in the document.
 */

import { bytesToBase64Url } from "./base64url.js";

const CIMD_MAX_BYTES = 5 * 1024;
const CIMD_TIMEOUT_MS = 10_000;
const CIMD_MAX_REDIRECTS = 3;

export type CimdDocument = {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method?: string;
};

export type CimdCache = {
  get: (clientId: string) => Promise<CimdDocument | null> | CimdDocument | null;
  set: (clientId: string, doc: CimdDocument, maxAgeSeconds: number) => Promise<void> | void;
};

export type CimdFetchOptions = {
  /** Override fetch (tests). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  cache?: CimdCache;
  /**
   * DNS lookup for rebinding checks. When omitted, the library tries
   * `node:dns/promises.lookup` if available; if that is also unavailable
   * (e.g. some Workers), resolution is refused rather than fetched blind.
   */
  lookup?: (hostname: string) => Promise<string[]>;
};

/** True when `client_id` is an HTTPS URL eligible for CIMD resolution. */
export const isCimdClientId = (clientId: string): boolean => {
  try {
    const url = new URL(clientId);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      Boolean(url.hostname)
    );
  } catch {
    return false;
  }
};

/** Strip WHATWG brackets from IPv6 hostnames (`[::1]` → `::1`). */
export const normalizeHostname = (hostname: string): string => {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
};

const IPV4_PRIVATE = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./,
];

const expandIpv4Mapped = (ip: string): string | null => {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1] ?? null;
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (!hexMapped) return null;
  const hi = Number.parseInt(hexMapped[1] ?? "", 16);
  const lo = Number.parseInt(hexMapped[2] ?? "", 16);
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
};

export const isBlockedIp = (ip: string): boolean => {
  const normalized = normalizeHostname(ip);
  const v4 = expandIpv4Mapped(normalized) ?? normalized;
  if (IPV4_PRIVATE.some((re) => re.test(v4))) return true;
  if (normalized.includes(":")) {
    const lower = normalized.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:")) return true;
    // ULA fc00::/7
    if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true;
    if (lower.startsWith("::ffff:")) return true;
  }
  return false;
};

const isBlockedHostname = (hostname: string): boolean => {
  const host = normalizeHostname(hostname);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }
  if (isBlockedIp(host)) return true;
  return false;
};

const defaultLookup = async (hostname: string): Promise<string[]> => {
  try {
    const dns = await import("node:dns/promises");
    const results = await dns.lookup(hostname, { all: true, verbatim: true });
    return results.map((r) => r.address);
  } catch {
    throw new Error("CIMD DNS lookup unavailable");
  }
};

const assertSafeUrl = async (
  url: URL,
  lookup: (hostname: string) => Promise<string[]>,
): Promise<void> => {
  if (url.protocol !== "https:") throw new Error("CIMD client_id must be https");
  if (url.username || url.password) throw new Error("CIMD URL must not carry credentials");
  if (isBlockedHostname(url.hostname)) throw new Error("CIMD hostname is not publicly routable");
  const addrs = await lookup(normalizeHostname(url.hostname));
  if (addrs.length === 0 || addrs.some(isBlockedIp)) {
    throw new Error("CIMD resolved to a non-public address");
  }
};

const parseCacheMaxAge = (header: string | null): number => {
  if (!header) return 300;
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(header);
  if (!match) return 300;
  return Math.min(Number(match[1]), 3600);
};

const assertHttpRedirectUri = (uri: string): void => {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("CIMD redirect_uris entries must be absolute URLs");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("CIMD redirect_uris must be http(s)");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error("CIMD redirect_uris must not carry credentials or a fragment");
  }
};

const parseDocument = (clientId: string, text: string): CimdDocument => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("CIMD document is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CIMD document must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.client_id !== clientId) {
    throw new Error("CIMD document client_id must equal the request URL exactly");
  }
  const rawUris = record.redirect_uris;
  if (!Array.isArray(rawUris) || rawUris.length === 0) {
    throw new Error("CIMD document must include a non-empty redirect_uris array");
  }
  if (rawUris.length > 10) {
    throw new Error("CIMD redirect_uris must have at most 10 entries");
  }
  const redirectUris = rawUris.map((u) => {
    if (typeof u !== "string" || !u) throw new Error("CIMD redirect_uris entries must be strings");
    assertHttpRedirectUri(u);
    return u;
  });
  const authMethod = record.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== "none") {
    throw new Error("CIMD clients must be public (token_endpoint_auth_method none)");
  }
  return {
    client_id: clientId,
    redirect_uris: redirectUris,
    ...(typeof record.client_name === "string" ? { client_name: record.client_name } : {}),
    token_endpoint_auth_method: "none",
  };
};

/**
 * Fetch and validate a CIMD document for `clientId` (the HTTPS URL itself).
 * Returns null on any validation / network failure — callers map that to
 * `unauthorized_client` without leaking fetch details to the connector.
 */
export const resolveCimdClient = async (
  clientId: string,
  options: CimdFetchOptions = {},
): Promise<CimdDocument | null> => {
  if (!isCimdClientId(clientId)) return null;

  const cached = options.cache ? await options.cache.get(clientId) : null;
  if (cached) return cached;

  const lookup = options.lookup ?? defaultLookup;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let current = new URL(clientId);
  try {
    await assertSafeUrl(current, lookup);
  } catch {
    return null;
  }

  for (let redirect = 0; redirect <= CIMD_MAX_REDIRECTS; redirect++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CIMD_TIMEOUT_MS);
    try {
      const response = await fetchImpl(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirect === CIMD_MAX_REDIRECTS) return null;
        current = new URL(location, current);
        await assertSafeUrl(current, lookup);
        continue;
      }

      if (!response.ok) return null;

      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > CIMD_MAX_BYTES) return null;
      // Re-check DNS after the body arrives — catches rebinding between
      // connect and read.
      await assertSafeUrl(current, lookup);

      const text = new TextDecoder().decode(buffer);
      const doc = parseDocument(clientId, text);
      if (options.cache) {
        await options.cache.set(
          clientId,
          doc,
          parseCacheMaxAge(response.headers.get("cache-control")),
        );
      }
      return doc;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
};

/** Stable fingerprint for tests / cache keys — not a security boundary. */
export const cimdCacheKey = (clientId: string): string =>
  bytesToBase64Url(new TextEncoder().encode(clientId)).slice(0, 32);
