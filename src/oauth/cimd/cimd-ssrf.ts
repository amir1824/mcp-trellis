/**
 * SSRF guards for CIMD URL fetch: hostname normalization, private/NAT64
 * IP blocks, and DNS lookup before connect.
 */

/** Strip WHATWG brackets from IPv6 hostnames (`[::1]` → `::1`). */
const normalizeHostname = (hostname: string): string => {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
};

const DOTTED_QUAD = /^\d{1,3}(?:\.\d{1,3}){3}$/;

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

/** Expand a sparse IPv6 string into 8 hextets for prefix checks. */
const expandIpv6Hextets = (ip: string): string[] | null => {
  const lower = ip.toLowerCase();
  if (!lower.includes(":")) return null;
  const [head, tail] = lower.split("::");
  const headParts = head && head.length > 0 ? head.split(":") : [];
  const tailParts = tail && tail.length > 0 ? tail.split(":") : [];
  if (headParts.length + tailParts.length > 8) return null;
  const missing = 8 - headParts.length - tailParts.length;
  return [...headParts, ...Array.from({ length: missing }, () => "0"), ...tailParts];
};

/** Digits-and-dots only — covers shorthand (`127.1`) and decimal (`2130706433`). */
const IPV4_CANDIDATE = /^\d+(?:\.\d+)*$/;

const isBlockedIp = (ip: string): boolean => {
  const normalized = normalizeHostname(ip);
  const v4 = expandIpv4Mapped(normalized) ?? normalized;
  // Non-canonical IPv4 from a sloppy `cimdLookup` (`127.1`, `10.1`, bare
  // decimal) — fail closed rather than treat as a public hostname. A DNS
  // name like `10.cdn.example` has letters and is not a candidate.
  if (IPV4_CANDIDATE.test(v4) && !DOTTED_QUAD.test(v4)) return true;
  if (DOTTED_QUAD.test(v4) && IPV4_PRIVATE.some((re) => re.test(v4))) return true;
  if (!normalized.includes(":")) return false;

  const lower = normalized.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80:")) return true;
  // ULA fc00::/7
  if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true;
  if (lower.startsWith("::ffff:")) return true;
  // Multicast ff00::/8
  if (/^ff[0-9a-f]{0,2}:/.test(lower)) return true;
  // NAT64 64:ff9b::/96 — compare hextets numerically (leading zeros ok)
  const hextets = expandIpv6Hextets(lower);
  if (!hextets) return false;
  const first = Number.parseInt(hextets[0] ?? "", 16);
  // 6to4 2002::/16 embeds an IPv4 address a relay would route to
  if (first === 0x2002) return true;
  return first === 0x64 && Number.parseInt(hextets[1] ?? "", 16) === 0xff9b;
};

const isBlockedHostname = (hostname: string): boolean => {
  const host = normalizeHostname(hostname);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }
  return isBlockedIp(host);
};

export const isLoopbackHostname = (hostname: string): boolean => {
  const host = normalizeHostname(hostname);
  // `localhost` deliberately excluded — RFC 8252 §8.3, same as policy/redirect.ts.
  return host === "127.0.0.1" || host === "::1";
};

export const defaultLookup = async (hostname: string): Promise<string[]> => {
  try {
    const dns = await import("node:dns/promises");
    const results = await dns.lookup(hostname, { all: true, verbatim: true });
    return results.map((r) => r.address);
  } catch {
    throw new Error("CIMD DNS lookup unavailable");
  }
};

export const assertSafeUrl = async (
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
