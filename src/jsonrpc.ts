import { jsonResponse } from "./http.js";
import { PROTOCOL_VERSIONS } from "./protocol.js";

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
export const JSONRPC_PAYLOAD_TOO_LARGE = -32002;

export const rpcResult = (id: JsonRpcId, result: unknown): JsonRpcSuccess => ({
  jsonrpc: "2.0",
  id,
  result,
});

export const rpcError = (id: JsonRpcId, code: number, message: string): JsonRpcFailure => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

export const isJsonRpcId = (id: unknown): id is JsonRpcId =>
  id === null || typeof id === "string" || typeof id === "number";

/**
 * RFC-shaped JSON-RPC id for an error response — omitted → `null`; valid ids
 * echoed; invalid shapes → `null` so we never reflect an illegal id.
 */
export const errorId = (jsonRpcRequest: JsonRpcRequest): JsonRpcId => {
  if (jsonRpcRequest.id === undefined) return null;
  return isJsonRpcId(jsonRpcRequest.id) ? jsonRpcRequest.id : null;
};

/** Runtime JSON-RPC Request shape — types alone do not enforce this. */
export const jsonRpcShapeError = (jsonRpcRequest: JsonRpcRequest): Response | null => {
  if (jsonRpcRequest.id !== undefined && !isJsonRpcId(jsonRpcRequest.id)) {
    return jsonResponse({
      data: rpcError(null, JSONRPC_INVALID_REQUEST, "id must be string, number, or null"),
      status: 400,
    });
  }
  const orphanResult =
    jsonRpcRequest.method === undefined &&
    jsonRpcRequest.id === undefined &&
    "result" in jsonRpcRequest;
  if (orphanResult) return null;
  if (typeof jsonRpcRequest.method !== "string" || jsonRpcRequest.method.length === 0) {
    return jsonResponse({
      data: rpcError(
        errorId(jsonRpcRequest),
        JSONRPC_INVALID_REQUEST,
        "method must be a non-empty string",
      ),
      status: 400,
    });
  }
  return null;
};

/** Batch / jsonrpc version / shape — returns a Response or a validated request. */
export const validateJsonRpcEnvelope = (parsed: unknown): Response | JsonRpcRequest => {
  if (Array.isArray(parsed)) {
    return jsonResponse({
      data: rpcError(null, JSONRPC_INVALID_REQUEST, "Batch requests not supported"),
      status: 400,
    });
  }
  if (!parsed || typeof parsed !== "object") {
    return jsonResponse({ data: rpcError(null, JSONRPC_PARSE_ERROR, "Parse error"), status: 400 });
  }
  const jsonRpcRequest = parsed as JsonRpcRequest;
  if (jsonRpcRequest.jsonrpc !== "2.0") {
    return jsonResponse({
      data: rpcError(errorId(jsonRpcRequest), JSONRPC_INVALID_REQUEST, 'jsonrpc must be "2.0"'),
      status: 400,
    });
  }
  return jsonRpcShapeError(jsonRpcRequest) ?? jsonRpcRequest;
};

/**
 * Spec requires `MCP-Protocol-Version` past `initialize`. Unknown → 400.
 * Missing → assume `2025-03-26` (header BC rule; see `protocol.ts`).
 */
export const protocolVersionHeaderError = (
  request: Request,
  jsonRpcRequest: JsonRpcRequest,
): Response | null => {
  if (jsonRpcRequest.method === "initialize") return null;
  const header = request.headers.get("MCP-Protocol-Version");
  if (!header || PROTOCOL_VERSIONS.has(header)) return null;
  return jsonResponse({
    data: rpcError(
      errorId(jsonRpcRequest),
      JSONRPC_INVALID_REQUEST,
      `Unsupported MCP-Protocol-Version: ${header}`,
    ),
    status: 400,
  });
};
