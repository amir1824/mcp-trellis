/** Default DNS resolution for CIMD SSRF checks, across Node and Workers. */

import { CimdError } from "./failure.js";

type NodeDns = typeof import("node:dns/promises");

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

/** Workers (nodejs_compat) ships `node:dns` with `lookup` stubbed out to throw. */
const isLookupNotImplemented = (caught: unknown): boolean =>
  caught instanceof Error && /not implemented/i.test(caught.message);

/**
 * ponytail: `resolve4`/`resolve6` return A/AAAA only (no hosts file, no
 * search domains) — enough for a public HTTPS client_id host. Upgrade: a
 * host-supplied `cimdLookup` backed by its own resolver.
 */
const resolveAddresses = async (dns: NodeDns, hostname: string): Promise<string[]> => {
  const settled = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
  const addresses = settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  if (addresses.length > 0) return addresses;
  const rejected = settled.find((result) => result.status === "rejected");
  throw new CimdError("dns_failed", `DNS resolution failed (${dnsErrorCode(rejected?.reason)})`);
};

export const defaultLookup = async (hostname: string): Promise<string[]> => {
  const dns = await importDns();
  try {
    const results = await dns.lookup(hostname, { all: true, verbatim: true });
    return results.map((r) => r.address);
  } catch (caught) {
    if (isLookupNotImplemented(caught)) return resolveAddresses(dns, hostname);
    // url-guard.ts turns any lookup failure into `dns_failed` with its code.
    throw caught;
  }
};
