export {
  createMcpApp,
  type McpApp,
  type McpAppOptions,
  type McpAppAuth,
  type VerifiedToken,
} from "./app.js";

export {
  CLIENT_PROFILES,
  DEFAULT_CLIENTS,
  authMethodsFor,
  redirectUrisFor,
  preRegisteredClients,
  hasDynamicClient,
  type ClientName,
  type ClientProfile,
} from "./clients.js";

export {
  createMcpHandler,
  type McpHandler,
  type McpHandlerOptions,
  type McpPorts,
  type Principal,
  type AuditEntry,
  type ServerInfo,
} from "./dispatch.js";

export {
  createToolRegistry,
  type ToolDef,
  type ToolHandler,
  type ToolResult,
  type ToolRegistry,
  type ToolListEntry,
  type RegistryOptions,
} from "./registry.js";

export {
  defineTool,
  apiTool,
  type StandardSchemaV1,
  type DefineToolOptions,
  type ApiToolOptions,
  type ApiRequest,
} from "./tools.js";

export {
  rpcResult,
  rpcError,
  JSONRPC_PARSE_ERROR,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_UNAUTHORIZED,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./jsonrpc.js";

export {
  pickProtocolVersion,
  PROTOCOL_VERSIONS,
  DEFAULT_PROTOCOL_VERSION,
} from "./protocol.js";

export {
  parseBearer,
  timingSafeEqual,
  matchesAny,
  wwwAuthenticateHeader,
  rejectQueryToken,
  type WwwAuthenticateOptions,
} from "./auth/bearer.js";

export { validateAgainstSchema, JSON_SCHEMA_TYPES, type JsonSchema } from "./validate.js";

export {
  jsonResponse,
  emptyResponse,
  optionsResponse,
  corsHeaders,
  methodNotAllowed,
} from "./http.js";
