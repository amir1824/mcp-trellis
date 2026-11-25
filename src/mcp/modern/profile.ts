/** Where a request for 2026-07-28 and a request for an older version differ, in one place per version. */

import { jsonResponse } from "../../http/http.js";
import {
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PAYLOAD_TOO_LARGE,
  type JsonRpcId,
  type JsonRpcRequest,
  protocolVersionHeaderError,
  rpcError,
} from "../jsonrpc.js";
import type { ResolvedMcpHandlerOptions, ResultWriter } from "../types.js";
import { methodNotFound, payloadTooLarge } from "./errors.js";
import { isModernRequest, modernRequestError, unsupportedModernVersionError } from "./request.js";
import { legacyWriter, modernWriter } from "./result.js";

type PublicMethodOptions = Pick<
  ResolvedMcpHandlerOptions<unknown>,
  "publicMethods" | "modernPublicMethods"
>;

type RequestCheck = (request: Request, envelope: JsonRpcRequest) => Response | null;

export type VersionProfile = {
  /** Keys the method tables in `rpc-handlers.ts`. */
  name: "legacy" | "modern";
  /** The answer to a body over the size limit. */
  tooLarge: () => Response;
  /** Checks the protocol version header, before the notification check. */
  versionError: RequestCheck;
  /** Checks what the version requires of every request, after the notification check. */
  requestError: RequestCheck;
  /** What may be called without authentication. */
  publicMethods: (options: PublicMethodOptions) => Set<string>;
  /** The answer to a method the version does not have. */
  notFound: (id: JsonRpcId, method: string) => Response;
  /** Writes a method's success result. */
  writer: (method: string) => ResultWriter;
};

const noError: RequestCheck = () => null;

export const legacyProfile: VersionProfile = {
  name: "legacy",
  tooLarge: () =>
    jsonResponse({
      data: rpcError(null, JSONRPC_PAYLOAD_TOO_LARGE, "Payload too large"),
      status: 413,
    }),
  // An unknown header with a matching 2026-07-28 `_meta` is refused first; every other case keeps the older rule.
  versionError: (request, envelope) =>
    unsupportedModernVersionError(request, envelope) ??
    protocolVersionHeaderError(request, envelope),
  requestError: noError,
  publicMethods: (options) => options.publicMethods,
  notFound: (id, method) =>
    jsonResponse({
      data: rpcError(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`),
    }),
  writer: () => legacyWriter,
};

export const modernProfile: VersionProfile = {
  name: "modern",
  tooLarge: payloadTooLarge,
  // The older header check does not know 2026-07-28 and would refuse its header.
  versionError: noError,
  requestError: modernRequestError,
  publicMethods: (options) => options.modernPublicMethods,
  notFound: methodNotFound,
  writer: modernWriter,
};

/** The header decides, and it is known before the body is read. */
export const profileFor = (request: Request): VersionProfile =>
  isModernRequest(request) ? modernProfile : legacyProfile;
