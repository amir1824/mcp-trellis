/** What a host passes to CIMD resolution, and which `client_id`s are eligible for it. */

import type { CimdFetchOptions, CimdPorts } from "./types.js";

/** The `client_id` is a cache key and an outbound URL; no real document URL needs more. */
const CIMD_MAX_CLIENT_ID_LENGTH = 2048;

/** Build fetch options from router/app CIMD ports. */
export const cimdFetchOpts = (
  ports: CimdPorts,
): Pick<
  CimdFetchOptions,
  "cache" | "lookup" | "fetch" | "allowedPorts" | "requireJsonContentType"
> => ({
  ...(ports.cimdCache !== undefined ? { cache: ports.cimdCache } : {}),
  ...(ports.cimdLookup !== undefined ? { lookup: ports.cimdLookup } : {}),
  ...(ports.cimdFetch !== undefined ? { fetch: ports.cimdFetch } : {}),
  ...(ports.cimdAllowedPorts !== undefined ? { allowedPorts: ports.cimdAllowedPorts } : {}),
  ...(ports.cimdRequireJsonContentType !== undefined
    ? { requireJsonContentType: ports.cimdRequireJsonContentType }
    : {}),
});

/** True when `client_id` is an HTTPS URL eligible for CIMD resolution. */
export const isCimdClientId = (clientId: string): boolean => {
  if (clientId.length > CIMD_MAX_CLIENT_ID_LENGTH) return false;
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

/** The `CimdPorts` keys a host's options carry into the OAuth router. */
export const CIMD_PORT_KEYS = [
  "cimdCache",
  "cimdLookup",
  "cimdFetch",
  "cimdAllowedPorts",
  "cimdRequireJsonContentType",
] as const satisfies readonly (keyof CimdPorts)[];
