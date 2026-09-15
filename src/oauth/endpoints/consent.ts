/**
 * The consent step between a resolved user and code issuance (RFC 6749
 * §4.1.1 "the resource owner grants or denies the ... request").
 *
 * `/authorize` seals everything the eventual `/consent` POST needs into an
 * opaque, single-use ticket — the ticket carries `clientId`, `redirectUri`,
 * `codeChallenge`, `resource`, and `scope` from the *validated* request, so
 * `handleConsent` trusts nothing from the POST body except which ticket and
 * whether the user approved it. Nothing else in that body is read.
 */

import { NO_CORS, POST_ONLY, requireHttpMethod } from "../../http/http.js";
import { auditLegacyKeyUsage } from "../audit.js";
import { oauthError, resolveSecrets } from "../config.js";
import { OAUTH_ERRORS } from "../constants.js";
import { issueAuthCode } from "../crypto/codes.js";
import { seal, unsealAny } from "../crypto/sealed.js";
import { readBodyOrError, readOAuthBody } from "../policy/reqbody.js";
import type {
  ConsentRequest,
  OAuthRouterOptions,
  OAuthUser,
  RegisteredClient,
  ResolvedOAuthRouterOptions,
} from "../types.js";
import { codeRedirect, errorRedirect } from "./callback.js";
import { renderBuiltInConsent } from "./consent-page.js";

const CONSENT_TICKET_TTL_MS = 300_000;

type ConsentTicketPayload = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  userId: string;
  resource: string;
  scope: string;
  state: string;
  exp: number;
  jti: string;
};

export const issueConsentTicket = (
  secret: string,
  payload: Omit<ConsentTicketPayload, "exp" | "jti">,
): Promise<string> =>
  seal(secret, "consent", {
    ...payload,
    exp: Date.now() + CONSENT_TICKET_TTL_MS,
    jti: crypto.randomUUID(),
  } satisfies ConsentTicketPayload);

export const renderConsent = async (
  options: OAuthRouterOptions,
  input: ConsentRequest,
): Promise<Response> => (options.consent?.render ?? renderBuiltInConsent)(input);

/** Only honored when `clientStore` actually resolves the id — never a self-invented one. */
export const isPreApproved = (
  options: OAuthRouterOptions,
  clientId: string,
  registered: RegisteredClient | null,
): boolean =>
  Boolean(registered) && (options.consent?.preApprovedClientIds?.includes(clientId) ?? false);

type ValidatedTicket = {
  payload: ConsentTicketPayload;
  secrets: readonly [string, ...string[]];
};

/** Unseals `ticket`, checks its expiry/jti shape, and audits a legacy-key unseal. */
const readValidTicket = async (
  request: Request,
  options: OAuthRouterOptions,
  ticket: string,
): Promise<ValidatedTicket | Response> => {
  const secrets = await resolveSecrets(options.ports, request);
  const unsealed = await unsealAny<ConsentTicketPayload>(secrets, "consent", ticket);
  const payload = unsealed?.value ?? null;
  if (
    !payload ||
    typeof payload.exp !== "number" ||
    payload.exp < Date.now() ||
    typeof payload.jti !== "string" ||
    !payload.jti
  ) {
    return oauthError(OAUTH_ERRORS.invalidGrant, 400, "invalid or expired consent_ticket");
  }
  await auditLegacyKeyUsage(options, {
    clientId: payload.clientId,
    keyIndex: unsealed?.keyIndex,
    source: "consent ticket unsealed",
  });
  return { payload, secrets };
};

/**
 * The resolved user, once the ticket is confirmed as theirs and burned.
 * Consumed only after the user check — a POST from the wrong session must
 * not burn the rightful user's ticket — but before either outcome (code or
 * denial), so single-use holds. Auth codes share this store; the `ct:`
 * prefix keeps a ticket's jti apart from a code's.
 */
const consumeTicketForUser = async (
  request: Request,
  options: ResolvedOAuthRouterOptions,
  payload: ConsentTicketPayload,
): Promise<OAuthUser | Response> => {
  const user = await options.ports.resolveUser(request);
  if (!user || user.id !== payload.userId) {
    return oauthError(
      OAUTH_ERRORS.invalidGrant,
      400,
      "consent_ticket does not match the current user",
    );
  }
  const fresh = await options.ports.codeStore.consume(`ct:${payload.jti}`, payload.exp);
  return fresh ? user : oauthError(OAUTH_ERRORS.invalidGrant, 400, "consent_ticket already used");
};

export const handleConsent = async (
  request: Request,
  options: ResolvedOAuthRouterOptions,
): Promise<Response> => {
  const methodError = requireHttpMethod(request, POST_ONLY, NO_CORS);
  if (methodError) return methodError;

  const body = await readBodyOrError(() => readOAuthBody(request));
  if (body instanceof Response) return body;

  const ticket = body.consent_ticket ?? "";
  if (!ticket) {
    return oauthError(OAUTH_ERRORS.invalidRequest, 400, "consent_ticket required");
  }

  const resolved = await readValidTicket(request, options, ticket);
  if (resolved instanceof Response) return resolved;
  const { payload, secrets } = resolved;

  const user = await consumeTicketForUser(request, options, payload);
  if (user instanceof Response) return user;

  const callback = {
    redirectUri: payload.redirectUri,
    state: payload.state,
    issuer: new URL(request.url).origin,
  };
  if (body.approved !== "true") return errorRedirect(callback, OAUTH_ERRORS.accessDenied);

  const code = await issueAuthCode(secrets[0], {
    clientId: payload.clientId,
    redirectUri: payload.redirectUri,
    codeChallenge: payload.codeChallenge,
    userId: user.id,
    resource: payload.resource,
    scope: payload.scope,
  });
  return codeRedirect(callback, code);
};
