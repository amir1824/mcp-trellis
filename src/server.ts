export {
  createMcpApp,
  type McpApp,
  type McpAppAuth,
  type McpAppOptions,
  type VerifiedToken,
} from "./app.js";
export { consoleAudit } from "./audit.js";
export {
  matchesAny,
  parseBearer,
  rejectQueryToken,
  timingSafeEqual,
  type WwwAuthenticateOptions,
  wwwAuthenticateHeader,
} from "./auth/bearer.js";

export {
  authMethodsFor,
  CLIENT_PROFILES,
  type ClientName,
  type ClientProfile,
  DEFAULT_CLIENTS,
  hasDynamicClient,
  preRegisteredClients,
  redirectUrisFor,
} from "./clients.js";

export {
  type AuditEntry,
  createMcpHandler,
  type McpHandler,
  type McpHandlerOptions,
  type McpPorts,
  type Principal,
  type ServerInfo,
} from "./dispatch.js";
export {
  corsHeaders,
  emptyResponse,
  jsonResponse,
  methodNotAllowed,
  optionsResponse,
} from "./http.js";
export {
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PARSE_ERROR,
  JSONRPC_UNAUTHORIZED,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  rpcError,
  rpcResult,
} from "./jsonrpc.js";
export type { CodeStore } from "./oauth/codes.js";
export type { ConsentOptions, ConsentRequest } from "./oauth/consent.js";
/** Auth-port types used by `McpAppAuth` — annotate extracted stores/callbacks. */
export type {
  ClientStore,
  MintAccessTokenInput,
  MintedToken,
  OAuthUser,
  RefreshAccessTokenInput,
  RegisteredClient,
  RevokeTokenInput,
} from "./oauth/types.js";

export {
  ASSUMED_HEADER_PROTOCOL_VERSION,
  DEFAULT_PROTOCOL_VERSION,
  PROTOCOL_VERSIONS,
  pickProtocolVersion,
} from "./protocol.js";
export {
  createToolRegistry,
  type RegistryOptions,
  type ToolDef,
  type ToolHandler,
  type ToolListEntry,
  type ToolRegistry,
  type ToolResult,
} from "./registry.js";
export {
  type ApiRequest,
  type ApiToolOptions,
  apiTool,
  type DefineToolOptions,
  defineTool,
  type StandardSchemaV1,
} from "./tools.js";
export {
  IGNORED_SCHEMA_KEYWORDS,
  JSON_SCHEMA_TYPES,
  type JsonSchema,
  missingObjectType,
  SUPPORTED_SCHEMA_KEYWORDS,
  unsupportedKeywords,
  validateAgainstSchema,
} from "./validate.js";
