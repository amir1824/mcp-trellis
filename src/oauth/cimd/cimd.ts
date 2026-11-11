/**
 * Client ID Metadata Documents (CIMD) — HTTPS URL `client_id` metadata.
 * Off by default (`cimd: true`). SSRF guards live in `url-guard.ts`.
 *
 * ponytail: DNS checked before/after fetch; TCP connect is not pinned (Web
 * fetch). Upgrade: custom dispatcher dialing the resolved IP + Host header.
 */

import { readBoundedText } from "../../http/body.js";
import { parseCacheMaxAge, parseDocument } from "./cimd-parse.js";
import { defaultLookup } from "./dns.js";
import { CimdError, type CimdFailure, classifyCimdFailure } from "./failure.js";
import type { CimdCache, CimdDocument, CimdFetchOptions } from "./types.js";
import { assertSafeUrl } from "./url-guard.js";

export type { CimdCache, CimdDocument, CimdFetchOptions } from "./types.js";

const CIMD_MAX_BYTES = 5 * 1024;
const CIMD_TIMEOUT_MS = 10_000;
const CIMD_MAX_REDIRECTS = 3;
/** The `client_id` is a cache key and an outbound URL; no real document URL needs more. */
const CIMD_MAX_CLIENT_ID_LENGTH = 2048;

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
): Promise<FetchedDocument> => {
  if (!response.ok) throw new CimdError("http_status", `status ${response.status}`);
  // Stream-capped at CIMD_MAX_BYTES; signal cancels the locked reader on hop
  // timeout (body.cancel() is a no-op while getReader() holds the lock).
  const text = await readBoundedText(response, CIMD_MAX_BYTES, ctx.signal);
  // Re-check DNS after the body — see file-level ponytail on connect pinning.
  await assertSafeUrl(current, ctx.lookup);
  return {
    doc: parseDocument(ctx.clientId, text),
    maxAge: parseCacheMaxAge(response.headers.get("cache-control")),
  };
};

const followRedirect = async (ctx: FetchCtx, response: Response, current: URL): Promise<URL> => {
  const location = response.headers.get("location");
  if (!location) throw new CimdError("redirect_refused", "redirect without Location");
  // Refused before the target is even looked up.
  if (ctx.redirect === CIMD_MAX_REDIRECTS) {
    throw new CimdError("redirect_refused", "too many redirects");
  }
  const next = new URL(location, current);
  // Same-origin only: a cross-origin hop would let an open redirect on a
  // reputable host vouch for a document the attacker actually serves.
  if (next.origin !== new URL(ctx.clientId).origin) {
    throw new CimdError("redirect_refused", "cross-origin redirect");
  }
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

/** A hop either ends resolution with a document or names the redirect target. */
type HopResult = { done: FetchedDocument } | { next: URL };

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
      return { next: await followRedirect(ctx, response, current) };
    }
    // `await` keeps the body read inside this try — without it `finally`
    // clears the timer as soon as headers arrive.
    return { done: await readCimdBody(ctx, response, current) };
  } finally {
    clearTimeout(timer);
  }
};

const fetchCimdDocument = async (settings: FetchSettings): Promise<FetchedDocument> => {
  let current = new URL(settings.clientId);
  await assertSafeUrl(current, settings.lookup);
  // Ends: followRedirect refuses any redirect past CIMD_MAX_REDIRECTS.
  for (let redirect = 0; ; redirect += 1) {
    const hop = await fetchHop(settings, current, redirect);
    if ("done" in hop) return hop.done;
    current = hop.next;
  }
};

/** A failed read is a miss: the document is fetched again instead of the request failing. */
const readCacheBestEffort = async (
  cache: CimdCache | undefined,
  clientId: string,
): Promise<CimdDocument | null> => {
  if (!cache) return null;
  try {
    return await cache.get(clientId);
  } catch {
    return null;
  }
};

/**
 * The document is already valid; a failed write only means the next call re-fetches.
 * A `max-age=0` document is not stored: a cache that reads 0 as "no expiry" would pin it.
 */
const cacheBestEffort = async (
  cache: CimdCache,
  clientId: string,
  fetched: FetchedDocument,
): Promise<void> => {
  if (fetched.maxAge <= 0) return;
  try {
    await cache.set(clientId, fetched.doc, fetched.maxAge);
  } catch {
    // Best-effort by design — see above.
  }
};

export type CimdOutcome = { doc: CimdDocument } | { failure: CimdFailure };

/**
 * Fetch and validate a CIMD document for `clientId` (the HTTPS URL itself).
 * Never throws for a fetch / validation problem: the failure comes back as a
 * code for the operator's audit sink, and callers still answer the connector
 * with one generic `unauthorized_client` — no fetch details leak to it.
 */
export const resolveCimdOutcome = async (
  clientId: string,
  options: CimdFetchOptions = {},
): Promise<CimdOutcome> => {
  if (!isCimdClientId(clientId)) {
    return { failure: { code: "blocked_url", detail: "client_id is not an https URL" } };
  }
  const cached = await readCacheBestEffort(options.cache, clientId);
  if (cached) return { doc: cached };

  let fetched: FetchedDocument;
  try {
    fetched = await fetchCimdDocument({
      clientId,
      fetch: options.fetch ?? globalThis.fetch,
      lookup: options.lookup ?? defaultLookup,
      timeoutMs: options.timeoutMs ?? CIMD_TIMEOUT_MS,
    });
  } catch (caught) {
    return { failure: classifyCimdFailure(caught) };
  }
  if (options.cache) await cacheBestEffort(options.cache, clientId, fetched);
  return { doc: fetched.doc };
};

/** `null` on any failure — see `resolveCimdOutcome` for the reason. */
export const resolveCimdClient = async (
  clientId: string,
  options: CimdFetchOptions = {},
): Promise<CimdDocument | null> => {
  const outcome = await resolveCimdOutcome(clientId, options);
  return "doc" in outcome ? outcome.doc : null;
};
