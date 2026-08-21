import { jsonResponse, requireHttpMethod } from "../http.js";
import { GRANT_TYPES } from "./constants.js";
import {
  authorizationServerMetadata,
  type GrantType,
  protectedResourceMetadata,
} from "./metadata.js";
import { type OAuthPorts, type OAuthRouterOptions, unregisteredClientsAllowed } from "./types.js";

const GET_ONLY = new Set(["GET"]);

const grantTypesOf = (ports: OAuthPorts): GrantType[] => {
  const grants: GrantType[] = [GRANT_TYPES.authorizationCode];
  if (ports.refreshAccessToken) grants.push(GRANT_TYPES.refreshToken);
  return grants;
};

export const handleWellKnown = async (
  request: Request,
  options: OAuthRouterOptions,
  paths: {
    prmPaths: Set<string>;
    asPaths: Set<string>;
    resourcePath: string;
    oauthPath: string;
  },
): Promise<Response | null> => {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!paths.prmPaths.has(path) && !paths.asPaths.has(path)) return null;

  const methodError = requireHttpMethod(request, GET_ONLY);
  if (methodError) return methodError;

  const metaOpts = {
    origin: url.origin,
    resourcePath: paths.resourcePath,
    oauthPath: paths.oauthPath,
    grantTypes: grantTypesOf(options.ports),
    ...(options.scopes !== undefined ? { scopes: options.scopes } : {}),
    ...(options.tokenEndpointAuthMethods !== undefined
      ? { tokenEndpointAuthMethods: options.tokenEndpointAuthMethods }
      : {}),
    dcrEnabled: unregisteredClientsAllowed(options),
    revocationEnabled: Boolean(options.ports.revokeToken),
  };

  const body = paths.prmPaths.has(path)
    ? protectedResourceMetadata(metaOpts)
    : authorizationServerMetadata(metaOpts);
  return jsonResponse(body);
};
