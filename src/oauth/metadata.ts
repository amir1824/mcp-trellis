import {
  DEFAULT_SCOPE,
  TOKEN_ENDPOINT_AUTH_METHODS,
  type GrantType,
  type TokenEndpointAuthMethod,
} from "./constants.js";
import { canonicalResource, DEFAULT_RESOURCE_PATH } from "./resource.js";

export type { GrantType } from "./constants.js";

export type ProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported: string[];
};

export type AuthorizationServerMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  /** Omitted when this server does not accept dynamically registered clients. */
  registration_endpoint?: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: TokenEndpointAuthMethod[];
  scopes_supported: string[];
  /** RFC 8707 — clients must send `resource` on authorize/token. */
  resource_parameter_supported: boolean;
  /** Omitted when `revokeToken` is not configured. */
  revocation_endpoint?: string;
  revocation_endpoint_auth_methods_supported?: TokenEndpointAuthMethod[];
};

export type MetadataOptions = {
  origin: string;
  /** MCP resource path, e.g. "/mcp". */
  resourcePath?: string;
  /** OAuth path prefix, e.g. "/mcp/oauth". */
  oauthPath?: string;
  /** Only advertise grants that are actually handled. */
  grantTypes: GrantType[];
  scopes?: string[];
  /** Only advertise auth methods the configured clients actually use. */
  tokenEndpointAuthMethods?: TokenEndpointAuthMethod[];
  /** Advertise `registration_endpoint`. Default true. */
  dcrEnabled?: boolean;
  /** Advertise `revocation_endpoint`. Default false. */
  revocationEnabled?: boolean;
};

export const protectedResourceMetadata = (
  options: MetadataOptions,
): ProtectedResourceMetadata => ({
  resource: canonicalResource(options.origin, options.resourcePath),
  authorization_servers: [options.origin],
  bearer_methods_supported: ["header"],
  scopes_supported: options.scopes ?? [DEFAULT_SCOPE],
});

export const authorizationServerMetadata = (
  options: MetadataOptions,
): AuthorizationServerMetadata => {
  const oauthPath = options.oauthPath ?? "/mcp/oauth";
  const tokenEndpointAuthMethods = options.tokenEndpointAuthMethods ?? [
    TOKEN_ENDPOINT_AUTH_METHODS.none,
  ];
  return {
    issuer: options.origin,
    authorization_endpoint: `${options.origin}${oauthPath}/authorize`,
    token_endpoint: `${options.origin}${oauthPath}/token`,
    ...(options.dcrEnabled !== false
      ? { registration_endpoint: `${options.origin}${oauthPath}/register` }
      : {}),
    ...(options.revocationEnabled
      ? {
          revocation_endpoint: `${options.origin}${oauthPath}/revoke`,
          revocation_endpoint_auth_methods_supported: tokenEndpointAuthMethods,
        }
      : {}),
    response_types_supported: ["code"],
    grant_types_supported: [...options.grantTypes],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: tokenEndpointAuthMethods,
    scopes_supported: options.scopes ?? [DEFAULT_SCOPE],
    resource_parameter_supported: true,
  };
};

export const mcpWwwAuthenticate = (
  origin: string,
  resourcePath = DEFAULT_RESOURCE_PATH,
  realm = "mcp",
): string =>
  `Bearer realm="${realm}", resource_metadata="${origin}/.well-known/oauth-protected-resource${resourcePath}"`;
