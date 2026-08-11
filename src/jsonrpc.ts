export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

export type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
};

export type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string };
};

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;
export const JSONRPC_UNAUTHORIZED = -32001;

export const rpcResult = (
  id: JsonRpcId,
  result: unknown,
): JsonRpcSuccess => ({
  jsonrpc: "2.0",
  id,
  result,
});

export const rpcError = (
  id: JsonRpcId,
  code: number,
  message: string,
): JsonRpcFailure => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
