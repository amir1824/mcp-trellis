/**
 * Client ID Metadata Documents (CIMD) — HTTPS URL `client_id` metadata.
 * Off by default (`cimd: true`). SSRF guards live in `cimd-ssrf.ts`.
 *
 * ponytail: DNS checked before/after fetch; TCP connect is not pinned (Web
 * fetch). Upgrade: custom dispatcher dialing the resolved IP + Host header.
 */

import { readBoundedText } from "../../http/body.js";
import { parseCacheMaxAge, parseDocument } from "./cimd-parse.js";
import { assertSafeUrl, defaultLookup } from "./cimd-ssrf.js";
import type { CimdCache, CimdDocument } from "./types.js";

export type { CimdCache, CimdDocument } from "./types.js";

const CIMD_MAX_BYTES = 5 * 1024;
const CIMD_TIMEOUT_MS = 10_000;
const CIMD_MAX_REDIRECTS = 3;

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
  /** Per-hop timeout covering connect **and** body read. Tests only — default 10 s. */
  timeoutMs?: number;
};

/** Build fetch options from router/app CIMD ports. */
export const cimdFetchOpts = (ports: {
  cimdCache?: CimdCache;
  cimdLookup?: (hostname: string) => Promise<string[]>;
}): Pick<CimdFetchOptions, "cache" | "lookup"> => ({
  ...(ports.cimdCache !== undefined ? { cache: ports.cimdCache } : {}),
  ...(ports.cimdLookup !== undefined ? { lookup: ports.cimdLookup } : {}),
});

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

type FetchedDocument = { doc: CimdDocument; maxAge: number };

type FetchCtx = {
  clientId: string;
  lookup: (hostname: string) => Promise<string[]>;
  redirect: number;
  signal: AbortSignal;
};

const readCimdBody = async (
  ctx: FetchCtx,
  response: Response,
  current: URL,
): Promise<FetchedDocument | null> => {
  if (!response.ok) return null;
  // Stream-capped at CIMD_MAX_BYTES; signal cancels the locked reader on hop
  // timeout (body.cancel() is a no-op while getReader() holds the lock).
  try {
    const text = await readBoundedText(response, CIMD_MAX_BYTES, ctx.signal);
    // Re-check DNS after the body — see file-level ponytail on connect pinning.
    await assertSafeUrl(current, ctx.lookup);
    return {
      doc: parseDocument(ctx.clientId, text),
      maxAge: parseCacheMaxAge(response.headers.get("cache-control")),
    };
  } catch {
    return null;
  }
};

const followRedirect = async (
  ctx: FetchCtx,
  response: Response,
  current: URL,
): Promise<URL | null> => {
  const location = response.headers.get("location");
  if (!location || ctx.redirect === CIMD_MAX_REDIRECTS) return null;
  const next = new URL(location, current);
  // Same-origin only: a cross-origin hop would let an open redirect on a
  // reputable host vouch for a document the attacker actually serves.
  if (next.origin !== new URL(ctx.clientId).origin) return null;
  await assertSafeUrl(next, ctx.lookup);
  return next;
};

const getCimdResponse = (fetchImpl: typeof fetch, url: string, signal: AbortSignal) =>
  fetchImpl(url, {
    method: "GET",
    redirect: "manual",
    signal,
    headers: { Accept: "application/json" },
  });

type FetchSettings = {
  clientId: string;
  fetch: typeof fetch;
  lookup: (hostname: string) => Promise<string[]>;
  timeoutMs: number;
};

/** A hop either ends resolution (with a document or null) or names the redirect target. */
type HopResult = { done: FetchedDocument | null } | { next: URL };

/** One request under its own timeout. */
const fetchHop = async (
  settings: FetchSettings,
  current: URL,
  redirect: number,
): Promise<HopResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  const ctx: FetchCtx = {
    clientId: settings.clientId,
    lookup: settings.lookup,
    redirect,
    signal: controller.signal,
  };
  try {
    const response = await getCimdResponse(settings.fetch, current.toString(), controller.signal);
    if (response.status >= 300 && response.status < 400) {
      const next = await followRedirect(ctx, response, current);
      return next ? { next } : { done: null };
    }
    // `await` keeps the body read inside this try — without it `finally`
    // clears the timer as soon as headers arrive.
    return { done: await readCimdBody(ctx, response, current) };
  } finally {
    clearTimeout(timer);
  }
};

const fetchCimdDocument = async (settings: FetchSettings): Promise<FetchedDocument | null> => {
  let current = new URL(settings.clientId);
  await assertSafeUrl(current, settings.lookup);
  for (let redirect = 0; redirect <= CIMD_MAX_REDIRECTS; redirect++) {
    const hop = await fetchHop(settings, current, redirect);
    if ("done" in hop) return hop.done;
    current = hop.next;
  }
  return null;
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

  try {
    const result = await fetchCimdDocument({
      clientId,
      fetch: options.fetch ?? globalThis.fetch,
      lookup: options.lookup ?? defaultLookup,
      timeoutMs: options.timeoutMs ?? CIMD_TIMEOUT_MS,
    });
    if (!result) return null;
    if (options.cache) await options.cache.set(clientId, result.doc, result.maxAge);
    return result.doc;
  } catch {
    return null;
  }
};
