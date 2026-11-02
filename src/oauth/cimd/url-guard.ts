/** Applies the SSRF address policy to a CIMD URL before (and after) it is fetched. */

import { isBlockedHostname, isBlockedIp, isIpLiteral, normalizeHostname } from "./cimd-ssrf.js";
import { dnsErrorCode } from "./dns.js";
import { CimdError, type CimdFailureCode } from "./failure.js";

type Lookup = (hostname: string) => Promise<string[]>;

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

/**
 * The addresses `hostname` resolves to. An IP literal is its own answer, and
 * any lookup failure — the default's or a host-supplied `cimdLookup`'s — is a
 * `dns_failed`, never mistaken for a fetch error or a blocked address.
 */
const resolveHost = async (hostname: string, lookup: Lookup): Promise<string[]> => {
  if (isIpLiteral(hostname)) return [hostname];
  let addrs: string[];
  try {
    addrs = await lookup(hostname);
  } catch (caught) {
    if (caught instanceof CimdError) throw caught;
    throw new CimdError("dns_failed", `DNS lookup failed (${dnsErrorCode(caught)})`);
  }
  if (addrs.length === 0) throw new CimdError("dns_failed", "DNS lookup returned no addresses");
  return addrs;
};

export const assertSafeUrl = async (url: URL, lookup: Lookup): Promise<void> => {
  for (const rule of Object.values(URL_SAFETY)) {
    if (!rule.ok(url)) throw new CimdError(rule.code, rule.error);
  }

  const addrs = await resolveHost(normalizeHostname(url.hostname), lookup);
  if (addrs.some(isBlockedIp)) {
    throw new CimdError("blocked_address", "CIMD resolved to a non-public address");
  }
};
