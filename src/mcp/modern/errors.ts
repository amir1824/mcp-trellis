/** The 2026-07-28 error responses. Messages are fixed text: nothing a client sent is echoed back, except the clipped `requested` version. */

import { jsonResponse } from "../../http/http.js";
import { clipText } from "../../util/clip.js";
import {
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PAYLOAD_TOO_LARGE,
  type JsonRpcId,
  rpcError,
} from "../jsonrpc.js";
import { MODERN_PROTOCOL_VERSION, PROTOCOL_VERSIONS } from "../protocol.js";

export const JSONRPC_HEADER_MISMATCH = -32020;
export const JSONRPC_UNSUPPORTED_PROTOCOL_VERSION = -32022;

const MAX_REQUESTED_VERSION_LENGTH = 64;

/** Newest first: the versions `server/discover` and `-32022` both name. */
export const SUPPORTED_VERSIONS: readonly string[] = [
  MODERN_PROTOCOL_VERSION,
  ...[...PROTOCOL_VERSIONS].reverse(),
];

type ModernErrorInput = {
  id: JsonRpcId;
  status: number;
  code: number;
  message: string;
  data?: unknown;
};

const modernError = ({ id, status, code, message, data }: ModernErrorInput): Response =>
  jsonResponse({
    data: {
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    },
    status,
  });

export const headerMismatch = (id: JsonRpcId, message: string): Response =>
  modernError({ id, status: 400, code: JSONRPC_HEADER_MISMATCH, message });

export const invalidMeta = (id: JsonRpcId, message: string): Response =>
  modernError({ id, status: 400, code: JSONRPC_INVALID_PARAMS, message });

export const unsupportedVersion = (id: JsonRpcId, requested: string): Response =>
  modernError({
    id,
    status: 400,
    code: JSONRPC_UNSUPPORTED_PROTOCOL_VERSION,
    message: "Unsupported protocol version",
    data: {
      supported: SUPPORTED_VERSIONS,
      requested: clipText(requested, MAX_REQUESTED_VERSION_LENGTH, "…"),
    },
  });

/** The spec asks for HTTP 404 with -32601 for a method the server does not implement. */
export const methodNotFound = (id: JsonRpcId): Response =>
  modernError({ id, status: 404, code: JSONRPC_METHOD_NOT_FOUND, message: "Method not found" });

/** `-32002` may not be emitted under 2026-07-28; the spec names no replacement, so Invalid Request. */
const PAYLOAD_TOO_LARGE_STATUS = 413;
const PAYLOAD_TOO_LARGE_ERROR = {
  jsonrpc: "2.0",
  id: null,
  error: { code: JSONRPC_INVALID_REQUEST, message: "Payload too large" },
};

/** The body a Node adapter sends when it refuses an oversized body before any handler runs. */
export const sizeErrorBody = (versionHeader: string | string[] | undefined): string =>
  JSON.stringify(
    versionHeader === MODERN_PROTOCOL_VERSION
      ? PAYLOAD_TOO_LARGE_ERROR
      : rpcError(null, JSONRPC_PAYLOAD_TOO_LARGE, "Payload too large"),
  );

export const payloadTooLarge = (): Response =>
  jsonResponse({ data: PAYLOAD_TOO_LARGE_ERROR, status: PAYLOAD_TOO_LARGE_STATUS });
