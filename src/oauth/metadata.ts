import { DEFAULT_SCOPE, type GrantType } from "./constants.js";

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
  registration_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
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
};

export const protectedResourceMetadata = (
  options: MetadataOptions,
): ProtectedResourceMetadata => {
  const resourcePath = options.resourcePath ?? "/mcp";
  return {
    resource: `${options.origin}${resourcePath}`,
    authorization_servers: [options.origin],
    bearer_methods_supported: ["header"],
    scopes_supported: options.scopes ?? [DEFAULT_SCOPE],
  };
};

export const authorizationServerMetadata = (
  options: MetadataOptions,
): AuthorizationServerMetadata => {
  const oauthPath = options.oauthPath ?? "/mcp/oauth";
  return {
    issuer: options.origin,
    authorization_endpoint: `${options.origin}${oauthPath}/authorize`,
    token_endpoint: `${options.origin}${oauthPath}/token`,
    registration_endpoint: `${options.origin}${oauthPath}/register`,
    response_types_supported: ["code"],
    grant_types_supported: [...options.grantTypes],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: options.scopes ?? [DEFAULT_SCOPE],
  };
};

export const mcpWwwAuthenticate = (
  origin: string,
  resourcePath = "/mcp",
  realm = "mcp",
): string =>
  `Bearer realm="${realm}", resource_metadata="${origin}/.well-known/oauth-protected-resource${resourcePath}"`;
