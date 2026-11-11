/** Default DNS resolution for CIMD SSRF checks, across Node and Workers. */

import { CimdError } from "./failure.js";

type NodeDns = typeof import("node:dns/promises");

/** Resolves a hostname to the addresses it points at. */
type Lookup = (hostname: string) => Promise<string[]>;

const importDns = async (): Promise<NodeDns> => {
  try {
    return await import("node:dns/promises");
  } catch {
    throw new CimdError("dns_unavailable", "no node:dns on this platform; pass cimdLookup");
  }
};

/** Resolver error codes only (`ENOTFOUND`, `ETIMEOUT`) — never free text from the error. */
const DNS_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,31}$/;

export const dnsErrorCode = (caught: unknown): string => {
  const code = caught instanceof Error && "code" in caught ? caught.code : undefined;
  return typeof code === "string" && DNS_ERROR_CODE.test(code) ? code : "unknown";
};

/**
 * `resolve4`/`resolve6` (c-ares, async I/O) rather than `lookup` (`getaddrinfo` on Node's
 * 4-thread libuv pool, which WebCrypto shares): a flood of unresolvable `client_id` hosts
 * must not be able to stall HMAC and AES verification on `/mcp` and `/token`.
 * ponytail: A/AAAA only (no hosts file, no search domains) — enough for a public HTTPS
 * client_id host. Upgrade: a host-supplied `cimdLookup` backed by its own resolver.
 */
const resolveAddresses = async (hostname: string): Promise<string[]> => {
  const dns = await importDns();
  const settled = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
  const addresses = settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  if (addresses.length > 0) return addresses;
  const rejected = settled.find((result) => result.status === "rejected");
  throw new CimdError("dns_failed", `DNS resolution failed (${dnsErrorCode(rejected?.reason)})`);
};

const withTimeout = <T>(work: Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new CimdError("dns_failed", "DNS resolution timed out (ETIMEOUT)")),
      timeoutMs,
    );
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });

type LookupLimits = { maxConcurrent: number; timeoutMs: number };

/**
 * Bounds a resolver: at most `maxConcurrent` lookups in flight (the rest fail at once with
 * `dns_failed`), each under `timeoutMs`. Unauthenticated `/authorize` requests reach this
 * before any session check, so an unbounded resolver is a slow-DNS denial of service.
 * ponytail: the count is per process and failures are not cached; behind a load balancer the
 * cap is per instance. Upgrade: a shared negative cache in `cimdCache`.
 */
export const createLimitedLookup = (
  resolve: Lookup,
  { maxConcurrent, timeoutMs }: LookupLimits,
): Lookup => {
  let inFlight = 0;
  return async (hostname) => {
    if (inFlight >= maxConcurrent) {
      throw new CimdError("dns_failed", "DNS resolution busy (EBUSY)");
    }
    inFlight += 1;
    try {
      return await withTimeout(resolve(hostname), timeoutMs);
    } finally {
      inFlight -= 1;
    }
  };
};

const DEFAULT_LOOKUP_LIMITS: LookupLimits = { maxConcurrent: 8, timeoutMs: 5_000 };

export const defaultLookup: Lookup = createLimitedLookup(resolveAddresses, DEFAULT_LOOKUP_LIMITS);
