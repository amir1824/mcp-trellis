/** `server/discover`, and the capabilities it shares with `initialize`. */

import { jsonResponse } from "../../http/http.js";
import { rpcResult } from "../jsonrpc.js";
import type { RpcMethodHandler } from "../types.js";
import { discoverHints } from "./cache.js";
import { SUPPORTED_VERSIONS } from "./errors.js";

const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

/** `resources: {}` says only that the server has resources, never which. */
export const serverCapabilities = (catalog: ReadonlyMap<string, unknown> | undefined) =>
  catalog ? { tools: {}, resources: {} } : { tools: {} };

/** Sets `resultType` and the hints itself: the hints depend on whether the caller was authenticated. */
export const DISCOVER_METHODS = {
  "server/discover": async ({ id, principal, options }) =>
    jsonResponse({
      data: rpcResult(id, {
        resultType: "complete",
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: serverCapabilities(options.resourceCatalog),
        _meta: { [SERVER_INFO_META_KEY]: options.serverInfo },
        ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
        ...discoverHints(principal === null),
      }),
    }),
} as const satisfies Record<string, RpcMethodHandler<unknown>>;
