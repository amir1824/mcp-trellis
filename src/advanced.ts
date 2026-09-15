/**
 * `mcp-trellis/advanced` — low-level building blocks for hosts assembling
 * their own MCP transport or OAuth flow. Less stable than the root and
 * `mcp-trellis/oauth` entry points: these follow the internals more closely
 * and may change in a minor release when the protocol work requires it.
 */

export { matchesAny, timingSafeEqual } from "./auth/bearer.js";
export { corsHeaders, emptyResponse, methodNotAllowed, optionsResponse } from "./http/http.js";
export { ASSUMED_HEADER_PROTOCOL_VERSION, pickProtocolVersion } from "./mcp/protocol.js";
export {
  IGNORED_SCHEMA_KEYWORDS,
  JSON_SCHEMA_TYPES,
  missingObjectType,
  SUPPORTED_SCHEMA_KEYWORDS,
  unsupportedKeywords,
  validateAgainstSchema,
} from "./mcp/validate.js";
export {
  advertisedScopes,
  defaultScopes,
  registeredClientsRequired,
  unregisteredClientsAllowed,
} from "./oauth/config.js";
export {
  type ClientAuth,
  firstClientAuthError,
  readClientAuth,
} from "./oauth/crypto/clientauth.js";
export {
  type AuthCodeRecord,
  type CodeStore,
  consumeAuthCode,
  issueAuthCode,
  newClientId,
} from "./oauth/crypto/codes.js";
export { randomBase64Url, sha256Base64Url, verifyPkceS256 } from "./oauth/crypto/pkce.js";
export { buildErrorRedirectUrl } from "./oauth/endpoints/callback.js";
export {
  firstResourceError,
  normalizeConfiguredPath,
  resourceErrorInfo,
} from "./oauth/policy/resource.js";
export {
  firstScopeError,
  formatScope,
  parseScope,
  requestedScopes,
  scopeErrorInfo,
} from "./oauth/policy/scope.js";
