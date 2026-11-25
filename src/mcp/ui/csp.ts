/** Construction-time check of a UI resource's CSP origins: an exact origin or `https://*.host`, nothing else. */

import { isJsonObject } from "../../util/json.js";
import type { UiCsp } from "./types.js";

const ALLOWED_PROTOCOLS = {
  connectDomains: ["https:", "wss:"],
  resourceDomains: ["https:"],
  frameDomains: ["https:"],
  baseUriDomains: ["https:"],
} as const;

type CspKey = keyof typeof ALLOWED_PROTOCOLS;

/** Lower-case host (optionally with a port) built from DNS-label characters only: no `*`, quote, `;` or space. */
const HOST_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/;
const WILDCARD_PATTERN = /^([a-z]+:\/\/)\*\.(.+)$/;

const originOrUndefined = (entry: string): URL | undefined => {
  try {
    return new URL(entry);
  } catch {
    return undefined;
  }
};

/** True for an exact origin: nothing but scheme, a DNS host and an optional port. */
export const isExactOrigin = (entry: string, protocols: readonly string[]): boolean => {
  const url = originOrUndefined(entry);
  return (
    url !== undefined &&
    protocols.includes(url.protocol) &&
    url.origin === entry &&
    HOST_PATTERN.test(url.host)
  );
};

/** `https://*.example.com`: one leading wildcard label over a host that itself has a dot (so never `*.com`). */
const isWildcardOrigin = (entry: string, protocols: readonly string[]): boolean => {
  const match = WILDCARD_PATTERN.exec(entry);
  if (!match) return false;
  const base = `${match[1]}${match[2]}`;
  return (
    isExactOrigin(base, protocols) && (originOrUndefined(base)?.hostname.includes(".") ?? false)
  );
};

const parseDomains = (key: CspKey, value: unknown): string[] => {
  const protocols = ALLOWED_PROTOCOLS[key];
  if (!Array.isArray(value)) throw new Error(`csp.${key} must be an array of origins`);
  return value.map((entry: unknown) => {
    const valid =
      typeof entry === "string" &&
      (isExactOrigin(entry, protocols) || isWildcardOrigin(entry, protocols));
    if (valid) return entry;
    throw new Error(
      `csp.${key} entry ${JSON.stringify(entry)} must be an exact origin ` +
        `(${protocols.join(" or ")} scheme, host, optional port) or one "*." label over a host`,
    );
  });
};

/** A normalized copy of `csp`, or throws naming the first entry that is not an exact origin. */
export const parseCsp = (csp: unknown): UiCsp => {
  if (!isJsonObject(csp)) throw new Error("csp must be an object");
  const known = Object.keys(ALLOWED_PROTOCOLS);
  const extra = Object.keys(csp).filter((key) => !known.includes(key));
  if (extra.length > 0) throw new Error(`csp has unsupported keys: ${extra.join(", ")}`);
  return Object.fromEntries(
    (Object.keys(ALLOWED_PROTOCOLS) as CspKey[])
      .filter((key) => csp[key] !== undefined)
      .map((key) => [key, parseDomains(key, csp[key])]),
  );
};
