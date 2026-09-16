export {
  createMcpApp,
  type McpApp,
  type McpAppAuth,
  type McpAppOptions,
  type UnifiedAuditEntry,
  type VerifiedToken,
} from "./app.js";
export { consoleAudit } from "./audit.js";
export {
  parseBearer,
  rejectQueryToken,
  type WwwAuthenticateOptions,
  wwwAuthenticateHeader,
} from "./auth/bearer.js";
export {
  type SignedTokenAuthOptions,
  signedTokenAuth,
} from "./auth/signed-token.js";

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
// Moved to `mcp-trellis/advanced`; deprecated aliases until 3.0.
export * from "./deprecated.js";
export {
  type JsonResponseInput,
  type JsonResponseOptions,
  jsonResponse,
} from "./http/http.js";
export {
  type AuditEntry,
  createMcpHandler,
  type McpHandler,
  type McpHandlerOptions,
  type McpPorts,
  type Principal,
  type ServerInfo,
} from "./mcp/dispatch.js";
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
} from "./mcp/jsonrpc.js";
export { DEFAULT_PROTOCOL_VERSION, PROTOCOL_VERSIONS } from "./mcp/protocol.js";
export {
  createToolRegistry,
  type RegistryOptions,
  type ToolDef,
  type ToolHandler,
  type ToolListEntry,
  type ToolRegistry,
  type ToolResult,
} from "./mcp/registry.js";
export {
  type ApiRequest,
  type ApiToolOptions,
  apiTool,
  type DefineToolOptions,
  defineTool,
  type StandardSchemaV1,
} from "./mcp/tools.js";
export type { JsonSchema } from "./mcp/validate.js";
export type { CodeStore } from "./oauth/crypto/codes.js";
/** Auth-port types used by `McpAppAuth` — annotate extracted stores/callbacks. */
export type {
  ClientStore,
  ConsentOptions,
  ConsentRequest,
  MintAccessTokenInput,
  MintedToken,
  OAuthUser,
  RefreshAccessTokenInput,
  RegisteredClient,
  RevokeTokenInput,
} from "./oauth/types.js";
