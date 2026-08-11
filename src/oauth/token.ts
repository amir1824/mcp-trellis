import { requireHttpMethod } from "../http.js";
import { consumeAuthCode, type AuthCodeRecord } from "./codes.js";
import {
  DEFAULT_SCOPE,
  GRANT_TYPES,
  OAUTH_ERRORS,
} from "./constants.js";
import { verifyPkceS256 } from "./pkce.js";
import {
  oauthError,
  resolveSecret,
  tokenResponse,
  type OAuthRouterOptions,
} from "./types.js";

const POST_ONLY = new Set(["POST"]);
const NO_CORS = { cors: false } as const;

type GrantInput = {
  request: Request;
  body: Record<string, string>;
  options: OAuthRouterOptions;
};

type GrantHandler = (input: GrantInput) => Promise<Response>;

const readJsonBody = async (
  request: Request,
): Promise<Record<string, string>> => {
  const body = (await request.json()) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("malformed request body");
  }
  return Object.fromEntries(
    Object.entries(body as Record<string, unknown>)
      .filter(([, value]) => value != null)
      .map(([key, value]) => [key, String(value)]),
  );
};

const readFormBody = async (
  request: Request,
): Promise<Record<string, string>> => {
  const params = new URLSearchParams(await request.text());
  return Object.fromEntries([...params.entries()]);
};

const BODY_READERS: Array<{
  match: (ctype: string) => boolean;
  read: (req: Request) => Promise<Record<string, string>>;
}> = [
  { match: (ctype) => ctype.includes("application/json"), read: readJsonBody },
  { match: () => true, read: readFormBody },
];

const readTokenBody = async (
  request: Request,
): Promise<Record<string, string>> => {
  const ctype = request.headers.get("Content-Type") ?? "";
  const reader =
    BODY_READERS.find((entry) => entry.match(ctype))?.read ?? readFormBody;
  return reader(request);
};

const handleRefresh: GrantHandler = async ({ body, options }) => {
  if (!options.ports.refreshAccessToken) {
    return oauthError(
      OAUTH_ERRORS.unsupportedGrantType,
      400,
      "refresh_token not enabled",
    );
  }
  const refreshToken = body.refresh_token ?? "";
  const clientId = body.client_id ?? "";
  if (!refreshToken || !clientId) {
    return oauthError(
      OAUTH_ERRORS.invalidRequest,
      400,
      "refresh_token and client_id required",
    );
  }
  const minted = await options.ports.refreshAccessToken({
    refreshToken,
    clientId,
  });
  if (!minted) {
    return oauthError(OAUTH_ERRORS.invalidGrant, 400, "invalid refresh_token");
  }
  return tokenResponse(minted);
};

const firstAuthCodeMismatch = (
  record: AuthCodeRecord,
  body: Record<string, string>,
): Response | null => {
  const rule = [
    {
      ok: record.redirectUri === (body.redirect_uri ?? ""),
      description: "redirect_uri mismatch",
    },
    {
      ok: record.clientId === (body.client_id ?? ""),
      description: "client_id mismatch",
    },
  ].find((entry) => !entry.ok);

  return rule
    ? oauthError(OAUTH_ERRORS.invalidGrant, 400, rule.description)
    : null;
};

const handleAuthCode: GrantHandler = async ({ request, body, options }) => {
  const clientId = body.client_id ?? "";
  if (!clientId) {
    return oauthError(OAUTH_ERRORS.invalidRequest, 400, "client_id required");
  }

  const secret = await resolveSecret(options.ports, request);
  const record = await consumeAuthCode(secret, body.code ?? "", {
    codeStore: options.ports.codeStore,
  });
  if (!record) {
    return oauthError(
      OAUTH_ERRORS.invalidGrant,
      400,
      "invalid or expired code",
    );
  }

  const mismatch = firstAuthCodeMismatch(record, body);
  if (mismatch) return mismatch;

  if (!(await verifyPkceS256(body.code_verifier ?? "", record.codeChallenge))) {
    return oauthError(
      OAUTH_ERRORS.invalidGrant,
      400,
      "pkce verification failed",
    );
  }

  const minted = await options.ports.mintAccessToken({
    userId: record.userId,
    clientId,
    scope: DEFAULT_SCOPE,
  });
  return tokenResponse(minted);
};

const GRANT_HANDLERS: Record<string, GrantHandler> = {
  [GRANT_TYPES.authorizationCode]: handleAuthCode,
  [GRANT_TYPES.refreshToken]: handleRefresh,
};

export const handleToken = async (
  request: Request,
  options: OAuthRouterOptions,
): Promise<Response> => {
  const methodError = requireHttpMethod(request, POST_ONLY, NO_CORS);
  if (methodError) return methodError;

  let body: Record<string, string>;
  try {
    body = await readTokenBody(request);
  } catch {
    return oauthError(
      OAUTH_ERRORS.invalidRequest,
      400,
      "malformed request body",
    );
  }

  const handler = GRANT_HANDLERS[body.grant_type ?? ""];
  if (!handler) {
    return oauthError(
      OAUTH_ERRORS.unsupportedGrantType,
      400,
      "authorization_code only",
    );
  }
  return handler({ request, body, options });
};
