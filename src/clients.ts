/**
 * Connector client profiles.
 *
 * Each AI client reaches an MCP server slightly differently — different
 * callback URLs, different registration models. Encoding that here is the
 * point: you name your clients, the library configures the AS to match.
 */

import {
  TOKEN_ENDPOINT_AUTH_METHODS,
  type TokenEndpointAuthMethod,
} from "./oauth/constants.js";
import { CLAUDE_CALLBACK } from "./oauth/redirect.js";

export type ClientName = "claude" | "gemini" | "codex";

export type ClientProfile = {
  /** Exact-match callbacks this client redirects to. */
  redirectUris: string[];
  /** Token-endpoint auth this client presents. */
  tokenEndpointAuthMethods: TokenEndpointAuthMethod[];
  /**
   * Whether the client is registered ahead of time rather than dynamically.
   * Pre-registered clients need `clientStore` on the OAuth ports.
   */
  preRegistered: boolean;
};

export const CLIENT_PROFILES: Record<ClientName, ClientProfile> = {
  /** Claude Custom Connectors — dynamic registration, public client + PKCE. */
  claude: {
    redirectUris: [CLAUDE_CALLBACK],
    tokenEndpointAuthMethods: [TOKEN_ENDPOINT_AUTH_METHODS.none],
    preRegistered: false,
  },
  /**
   * Gemini Enterprise — the org registers Gemini with its own IdP and
   * configures the resulting client_id / client_secret pair.
   */
  gemini: {
    redirectUris: [],
    tokenEndpointAuthMethods: [
      TOKEN_ENDPOINT_AUTH_METHODS.basic,
      TOKEN_ENDPOINT_AUTH_METHODS.post,
    ],
    preRegistered: true,
  },
  /** OpenAI Codex / ChatGPT connectors — OAuth 2.1 per the MCP auth spec. */
  codex: {
    redirectUris: [],
    tokenEndpointAuthMethods: [TOKEN_ENDPOINT_AUTH_METHODS.none],
    preRegistered: false,
  },
};

export const DEFAULT_CLIENTS: ClientName[] = ["claude"];

/** Exact-match redirect URIs contributed by the named clients. */
export const redirectUrisFor = (clients: ClientName[]): string[] => [
  ...new Set(clients.flatMap((name) => CLIENT_PROFILES[name].redirectUris)),
];

/** Auth methods to advertise, in a stable order. */
export const authMethodsFor = (
  clients: ClientName[],
): TokenEndpointAuthMethod[] => {
  const present = new Set(
    clients.flatMap((name) => CLIENT_PROFILES[name].tokenEndpointAuthMethods),
  );
  return [
    TOKEN_ENDPOINT_AUTH_METHODS.none,
    TOKEN_ENDPOINT_AUTH_METHODS.basic,
    TOKEN_ENDPOINT_AUTH_METHODS.post,
  ].filter((method) => present.has(method));
};

/** Clients that need a `clientStore` to work at all. */
export const preRegisteredClients = (clients: ClientName[]): ClientName[] =>
  clients.filter((name) => CLIENT_PROFILES[name].preRegistered);
