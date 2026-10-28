/**
 * SSRF guards for CIMD URL fetch: hostname normalization, private/NAT64
 * IP blocks, and DNS lookup before connect.
 */

import { CimdError, type CimdFailureCode } from "./failure.js";

/** Strip WHATWG brackets from IPv6 hostnames (`[::1]` → `::1`). */
const normalizeHostname = (hostname: string): string => {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
};

const DOTTED_QUAD = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Digits-and-dots only — covers shorthand (`127.1`) and decimal (`2130706433`). */
const IPV4_CANDIDATE = /^\d+(?:\.\d+)*$/;

const IPV4_PRIVATE = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./,
  // IETF protocol assignments 192.0.0/24, benchmarking 198.18/15
  /^192\.0\.0\./,
  /^198\.1[89]\./,
  // Multicast 224/4, reserved 240/4 (incl. 255.255.255.255)
  /^(22[4-9]|23\d|24\d|25[0-5])\./,
];

const isPrivateV4 = (v4: string): boolean => IPV4_PRIVATE.some((re) => re.test(v4));

/** IPv4-mapped (`::ffff:a.b.c.d`) and deprecated IPv4-compatible (`::a.b.c.d`) forms. */
const expandIpv4Mapped = (ip: string): string | null => {
  const mapped = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1] ?? null;

  const hexMapped = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (!hexMapped) return null;

  const hi = Number.parseInt(hexMapped[1] ?? "", 16);
  const lo = Number.parseInt(hexMapped[2] ?? "", 16);
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
};

const HEXTET = /^[0-9a-f]{1,4}$/i;

const parseHextet = (part: string): number | null =>
  HEXTET.test(part) ? Number.parseInt(part, 16) : null;

const hextetPairToIpv4 = (hi: string, lo: string): string | null => {
  const high = parseHextet(hi);
  const low = parseHextet(lo);
  if (high === null || low === null) return null;
  return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
};

const splitHextetParts = (segment: string): string[] =>
  segment.length > 0 ? segment.split(":") : [];

const dottedQuadToHextetPair = (quad: string): [string, string] | null => {
  const octets = quad.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
    return null;
  }
  const [a, b, c, d] = octets as [number, number, number, number];
  return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
};

const isValidHextetList = (
  hextets: string[],
): hextets is [string, string, string, string, string, string, string, string] =>
  hextets.length === 8 && hextets.every((h) => parseHextet(h) !== null);

/**
 * Expand an IPv6 literal into 8 hextets. Trailing dotted-quad (mapped /
 * compatible forms) consumes the last two slots. Returns null when the
 * string is not a well-formed IPv6 address — callers fail closed.
 */
const expandIpv6Hextets = (ip: string): string[] | null => {
  if (!ip.includes(":")) return null;

  let ipv4Tail: [string, string] | null = null;
  let core = ip;
  const lastColon = ip.lastIndexOf(":");
  const after = ip.slice(lastColon + 1);
  if (DOTTED_QUAD.test(after)) {
    ipv4Tail = dottedQuadToHextetPair(after);
    if (!ipv4Tail) return null;
    core = ip.slice(0, lastColon);
  }

  const slots = 8 - (ipv4Tail ? 2 : 0);

  if (core.includes("::")) {
    const pieces = core.split("::");
    if (pieces.length !== 2) return null;
    const headParts = splitHextetParts(pieces[0] ?? "");
    const tailParts = splitHextetParts(pieces[1] ?? "");
    if (headParts.length + tailParts.length > slots) return null;
    const missing = slots - headParts.length - tailParts.length;
    const hextets = [
      ...headParts,
      ...Array.from({ length: missing }, () => "0"),
      ...tailParts,
      ...(ipv4Tail ?? []),
    ];
    return isValidHextetList(hextets) ? hextets : null;
  }

  const parts = splitHextetParts(core);
  if (parts.length !== slots) return null;
  const hextets = [...parts, ...(ipv4Tail ?? [])];
  return isValidHextetList(hextets) ? hextets : null;
};

// --- block rules (ordered; first match blocks) ---

/** Non-canonical IPv4 from a sloppy `cimdLookup` — fail closed, not a public hostname. */
const isNonCanonicalIpv4 = (v4: string): boolean =>
  IPV4_CANDIDATE.test(v4) && !DOTTED_QUAD.test(v4);

const isPrivateDottedQuad = (v4: string): boolean => DOTTED_QUAD.test(v4) && isPrivateV4(v4);

const IPV6_BLOCKED_EXACT = new Set(["::1", "::"]);
const IPV6_BLOCKED_PREFIXES = ["::ffff:"];
/** ULA fc00::/7 and multicast ff00::/8. */
const IPV6_BLOCKED_PREFIX_RES = [/^f[cd][0-9a-f]{2}:/i, /^ff[0-9a-f]{0,2}:/];

const isBlockedIpv6Literal = (ip: string): boolean =>
  IPV6_BLOCKED_EXACT.has(ip) ||
  IPV6_BLOCKED_PREFIXES.some((prefix) => ip.startsWith(prefix)) ||
  IPV6_BLOCKED_PREFIX_RES.some((re) => re.test(ip));

const leadingFiveZero = (n: number[]): boolean =>
  n[0] === 0 && n[1] === 0 && n[2] === 0 && n[3] === 0 && n[4] === 0;

/** Full-form IPv4-mapped (`0:0:0:0:0:ffff:…`) — same block as `::ffff:` prefix. */
const isIpv4MappedHextets = (n: number[]): boolean => leadingFiveZero(n) && n[5] === 0xffff;

/** Deprecated IPv4-compatible — private/reserved embeds only (public stays). */
const isBlockedIpv4Compatible = (n: number[], raw: string[]): boolean => {
  if (!leadingFiveZero(n) || n[5] !== 0) return false;
  if (n[6] === 0 && (n[7] === 0 || n[7] === 1)) return true;
  const embedded = hextetPairToIpv4(raw[6] ?? "", raw[7] ?? "");
  return !embedded || isPrivateV4(embedded);
};

const HEXTET_BLOCK_RULES: Array<(n: number[], raw: string[]) => boolean> = [
  isIpv4MappedHextets,
  isBlockedIpv4Compatible,
  (n) => ((n[0] ?? 0) & 0xffc0) === 0xfe80, // link-local fe80::/10 (fe80–febf)
  (n) => ((n[0] ?? 0) & 0xffc0) === 0xfec0, // deprecated site-local fec0::/10
  (n) => n[0] === 0x2001 && n[1] === 0, // Teredo 2001::/32
  (n) => n[0] === 0x2002, // 6to4 2002::/16
  (n) => n[0] === 0x64 && n[1] === 0xff9b, // NAT64 64:ff9b::/96
];

const isBlockedIp = (ip: string): boolean => {
  const normalized = normalizeHostname(ip);
  const v4 = expandIpv4Mapped(normalized) ?? normalized;

  if (isNonCanonicalIpv4(v4) || isPrivateDottedQuad(v4)) return true;
  if (!normalized.includes(":")) return false;
  if (isBlockedIpv6Literal(normalized)) return true;

  const raw = expandIpv6Hextets(normalized);
  if (!raw) return true; // fail closed on unparseable IPv6

  const n = raw.map((h) => Number.parseInt(h, 16));
  return HEXTET_BLOCK_RULES.some((rule) => rule(n, raw));
};

const BLOCKED_HOST_EXACT = new Set(["localhost"]);
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local"];

const isBlockedHostname = (hostname: string): boolean => {
  const host = normalizeHostname(hostname);
  if (BLOCKED_HOST_EXACT.has(host)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return isBlockedIp(host);
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

export const isLoopbackHostname = (hostname: string): boolean =>
  // `localhost` deliberately excluded — RFC 8252 §8.3, same as policy/redirect.ts.
  LOOPBACK_HOSTS.has(normalizeHostname(hostname));

const importDns = async (): Promise<typeof import("node:dns/promises")> => {
  try {
    return await import("node:dns/promises");
  } catch {
    throw new CimdError("dns_unavailable", "no node:dns on this platform; pass cimdLookup");
  }
};

const errorCode = (caught: unknown): string =>
  caught instanceof Error && "code" in caught ? String(caught.code) : "unknown";

/** Workers (nodejs_compat) ships `node:dns` with `lookup` stubbed out to throw. */
const isLookupNotImplemented = (caught: unknown): boolean =>
  caught instanceof Error && /not implemented/i.test(caught.message);

/**
 * ponytail: `resolve4`/`resolve6` return A/AAAA only (no hosts file, no
 * search domains) — enough for a public HTTPS client_id host. Upgrade: a
 * host-supplied `cimdLookup` backed by its own resolver.
 */
const resolveAddresses = async (
  dns: typeof import("node:dns/promises"),
  hostname: string,
): Promise<string[]> => {
  const settled = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
  const addresses = settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  if (addresses.length === 0) {
    throw new CimdError("dns_failed", "DNS resolution returned no A/AAAA records");
  }
  return addresses;
};

export const defaultLookup = async (hostname: string): Promise<string[]> => {
  const dns = await importDns();
  try {
    const results = await dns.lookup(hostname, { all: true, verbatim: true });
    return results.map((r) => r.address);
  } catch (caught) {
    if (isLookupNotImplemented(caught)) return resolveAddresses(dns, hostname);
    throw new CimdError("dns_failed", `DNS lookup failed (${errorCode(caught)})`);
  }
};

const URL_SAFETY: Record<
  string,
  { ok: (url: URL) => boolean; code: CimdFailureCode; error: string }
> = {
  https: {
    ok: (url) => url.protocol === "https:",
    code: "blocked_url",
    error: "CIMD client_id must be https",
  },
  noCredentials: {
    ok: (url) => !url.username && !url.password,
    code: "blocked_url",
    error: "CIMD URL must not carry credentials",
  },
  publicHostname: {
    ok: (url) => !isBlockedHostname(url.hostname),
    code: "blocked_address",
    error: "CIMD hostname is not publicly routable",
  },
};

export const assertSafeUrl = async (
  url: URL,
  lookup: (hostname: string) => Promise<string[]>,
): Promise<void> => {
  for (const rule of Object.values(URL_SAFETY)) {
    if (!rule.ok(url)) throw new CimdError(rule.code, rule.error);
  }

  const addrs = await lookup(normalizeHostname(url.hostname));
  if (addrs.length === 0 || addrs.some(isBlockedIp)) {
    throw new CimdError("blocked_address", "CIMD resolved to a non-public address");
  }
};
