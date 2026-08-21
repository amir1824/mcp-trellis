/**
 * OAuth flow helpers shared by every OAuth test file and the e2e suite.
 *
 * Two rules make previously-unreachable branches reachable:
 *  - Nothing here silently "fixes" a bad value: `redeem(t, session, { codeVerifier: "wrong" })`
 *    puts `code_verifier=wrong` on the wire, verbatim.
 *  - `null` on an override omits that key from the request entirely;
 *    `undefined` (i.e. not passing the key) keeps the correct default.
 *    "Missing verifier" and "empty verifier" (`codeVerifier: ""`) are
 *    different request bodies and exercise different branches.
 */

import type { AuthCodeRecord } from "../../src/oauth/codes.js";
import { issueAuthCode } from "../../src/oauth/codes.js";
import { randomBase64Url, sha256Base64Url } from "../../src/oauth/pkce.js";
import { asFetch, originOf, type Target } from "./target.js";

export const DEFAULT_CLIENT_ID = "harness-client";
export const DEFAULT_REDIRECT_URI = "http://127.0.0.1:4321/cb";

/** `null` → omit the key; `undefined` → keep the correct default; anything else → literal. */
type Nullable<T> = { [K in keyof T]?: T[K] | null };

const applyOverrides = (
  defaults: Record<string, string>,
  overrides: Record<string, string | null | undefined>,
): Record<string, string> => {
  const result = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete result[key];
    else if (value !== undefined) result[key] = value;
  }
  return result;
};

export const newPkce = async (): Promise<{
  verifier: string;
  challenge: string;
}> => {
  const verifier = randomBase64Url(32);
  return { verifier, challenge: await sha256Base64Url(verifier) };
};

export type AuthorizeOverrides = Nullable<{
  responseType: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  challengeMethod: string;
  resource: string;
  scope: string;
  state: string;
}>;

/** Raw GET to `/authorize`. Defaults describe a well-formed request; overrides deviate from it. */
export const authorize = async (
  target: Target,
  challenge: string,
  overrides: AuthorizeOverrides = {},
  oauthPath = "/mcp/oauth",
): Promise<Response> => {
  const origin = originOf(target);
  const defaults: Record<string, string> = {
    response_type: "code",
    client_id: DEFAULT_CLIENT_ID,
    redirect_uri: DEFAULT_REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
  };
  const params = applyOverrides(defaults, {
    response_type: overrides.responseType,
    client_id: overrides.clientId,
    redirect_uri: overrides.redirectUri,
    code_challenge: overrides.codeChallenge,
    code_challenge_method: overrides.challengeMethod,
    resource: overrides.resource,
    scope: overrides.scope,
    state: overrides.state,
  });
  const url = new URL(`${origin}${oauthPath}/authorize`);
  url.search = new URLSearchParams(params).toString();
  return asFetch(target)(new Request(url, { method: "GET", redirect: "manual" }));
};

const CONSENT_TICKET_HTML_RE = /name="consent_ticket"\s+value="([^"]+)"/;

const extractTicket = (body: string, contentType: string): string => {
  if (contentType.includes("application/json")) {
    const parsed = JSON.parse(body) as { consent_ticket?: string };
    if (!parsed.consent_ticket) {
      throw new Error("consent JSON body missing consent_ticket");
    }
    return parsed.consent_ticket;
  }
  const match = body.match(CONSENT_TICKET_HTML_RE);
  if (!match?.[1]) {
    throw new Error('consent HTML missing a well-formed name="consent_ticket" value="..." field');
  }
  return match[1];
};

/**
 * Extracts the consent ticket from either rendering (a JSON body from
 * `consent.render`, or the built-in HTML interstitial — the regex on
 * `name="consent_ticket"` also doubles as a well-formedness check on that
 * form) and posts the user's decision to `/consent`.
 */
export const approve = async (
  target: Target,
  consentResponse: Response,
  decision: { approved: boolean } = { approved: true },
  oauthPath = "/mcp/oauth",
): Promise<Response> => {
  const contentType = consentResponse.headers.get("content-type") ?? "";
  const ticket = extractTicket(await consentResponse.text(), contentType);
  const origin = originOf(target);
  return asFetch(target)(
    new Request(`${origin}${oauthPath}/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      redirect: "manual",
      body: new URLSearchParams({
        consent_ticket: ticket,
        approved: String(decision.approved),
      }).toString(),
    }),
  );
};

const codeFromRedirect = (target: Target, res: Response): string => {
  const location = res.headers.get("location");
  if (!location) throw new Error(`expected a redirect, got ${res.status}`);
  const code = new URL(location, originOf(target)).searchParams.get("code");
  if (!code) throw new Error(`redirect carried no code: ${location}`);
  return code;
};

/** A minted, not-yet-redeemed authorization — everything `redeem` needs to build a correct request. */
export type AuthSession = {
  code: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
  resource: string;
};

/**
 * Runs the full authorize step (approving consent automatically if the
 * router requires it) and returns the resulting code plus everything that
 * went into minting it, so `redeem` can default to a correct request.
 */
export const authorizeCode = async (
  target: Target,
  overrides: AuthorizeOverrides = {},
  oauthPath = "/mcp/oauth",
): Promise<AuthSession> => {
  const origin = originOf(target);
  const { verifier, challenge } = await newPkce();
  const clientId = overrides.clientId ?? DEFAULT_CLIENT_ID;
  const redirectUri = overrides.redirectUri ?? DEFAULT_REDIRECT_URI;
  const resource = overrides.resource ?? `${origin}/mcp`;

  let res = await authorize(target, challenge, overrides, oauthPath);
  while (res.status === 200) {
    res = await approve(target, res, { approved: true }, oauthPath);
  }
  if (res.status !== 302 && res.status !== 303) {
    throw new Error(`authorize did not redirect: ${res.status}`);
  }
  return { code: codeFromRedirect(target, res), verifier, clientId, redirectUri, resource };
};

export type RedeemOverrides = Nullable<{
  grantType: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  resource: string;
  clientSecret: string;
}>;

/** POST to `/token` for an authorization_code grant, defaulting to `session`'s correct values. */
export const redeem = async (
  target: Target,
  session: AuthSession,
  overrides: RedeemOverrides = {},
  oauthPath = "/mcp/oauth",
): Promise<Response> => {
  const origin = originOf(target);
  const defaults: Record<string, string> = {
    grant_type: "authorization_code",
    code: session.code,
    code_verifier: session.verifier,
    redirect_uri: session.redirectUri,
    client_id: session.clientId,
    resource: session.resource,
  };
  const params = applyOverrides(defaults, {
    grant_type: overrides.grantType,
    code: overrides.code,
    code_verifier: overrides.codeVerifier,
    redirect_uri: overrides.redirectUri,
    client_id: overrides.clientId,
    resource: overrides.resource,
    client_secret: overrides.clientSecret,
  });
  return asFetch(target)(
    new Request(`${origin}${oauthPath}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    }),
  );
};

/** End-to-end happy path: authorize (+ consent if required) → redeem → the minted access token. */
export const accessToken = async (
  target: Target,
  authorizeOverrides: AuthorizeOverrides = {},
  redeemOverrides: RedeemOverrides = {},
  oauthPath = "/mcp/oauth",
): Promise<{ accessToken: string; scope: string; response: Response }> => {
  const session = await authorizeCode(target, authorizeOverrides, oauthPath);
  const res = await redeem(target, session, redeemOverrides, oauthPath);
  if (res.status !== 200) {
    throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { access_token: string; scope: string };
  return { accessToken: body.access_token, scope: body.scope, response: res };
};

/** Mints an auth code with an already-expired `exp`, bypassing the TTL wait entirely. */
export const forgeCode = (
  secret: string,
  record: Omit<AuthCodeRecord, "exp">,
  nowMs: number = Date.now() - 700_000,
): Promise<string> => issueAuthCode(secret, record, nowMs);
