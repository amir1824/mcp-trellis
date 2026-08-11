import { DEFAULT_SCOPE } from "./constants.js";
import type { CodeStore } from "./codes.js";
import type { RedirectAllowlistOptions } from "./redirect.js";
import { jsonResponse } from "../http.js";

export type OAuthUser = { id: string };

export type MintedToken = {
  accessToken: string;
  tokenType?: string;
  expiresIn: number;
  scope?: string;
  refreshToken?: string;
};

export type OAuthPorts = {
  /** HMAC secret for signing auth codes. */
  codeSecret: string | ((req: Request) => string | Promise<string>);
  /** Resolve the logged-in user, or null → redirect to login. */
  resolveUser: (req: Request) => Promise<OAuthUser | null>;
  /** Where to send unauthenticated authorize requests. */
  loginUrl: (req: Request, nextPath: string) => string;
  /** Mint an access token bound to the consenting user. */
  mintAccessToken: (input: {
    userId: string;
    clientId: string;
    scope: string;
  }) => Promise<MintedToken>;
  /** Optional refresh_token grant. Presence advertises the grant. */
  refreshAccessToken?: (input: {
    refreshToken: string;
    clientId: string;
  }) => Promise<MintedToken | null>;
  /** Shared single-use jti store for multi-instance; in-memory default otherwise. */
  codeStore?: CodeStore;
};

export type OAuthRouterOptions = {
  ports: OAuthPorts;
  resourcePath?: string;
  oauthPath?: string;
  realm?: string;
  scopes?: string[];
  redirect?: RedirectAllowlistOptions;
};

export const resolveSecret = async (
  ports: OAuthPorts,
  req: Request,
): Promise<string> => {
  if (typeof ports.codeSecret === "string") return ports.codeSecret;
  return ports.codeSecret(req);
};

export const oauthError = (
  error: string,
  status: number,
  description?: string,
): Response =>
  jsonResponse(
    description ? { error, error_description: description } : { error },
    status,
    undefined,
    { cors: false },
  );

export const tokenResponse = (minted: MintedToken): Response =>
  jsonResponse(
    {
      access_token: minted.accessToken,
      token_type: minted.tokenType ?? "bearer",
      expires_in: minted.expiresIn,
      scope: minted.scope ?? DEFAULT_SCOPE,
      ...(minted.refreshToken ? { refresh_token: minted.refreshToken } : {}),
    },
    200,
    undefined,
    { cors: false },
  );
