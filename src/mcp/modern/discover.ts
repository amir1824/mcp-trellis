/** `server/discover`, and the capabilities it shares with `initialize`. */

import { jsonResponse } from "../../http/http.js";
import { rpcResult } from "../jsonrpc.js";
import { SKILLS_EXTENSION_ID } from "../skills/types.js";
import type { RpcMethodHandler } from "../types.js";
import { discoverHints } from "./cache.js";
import { SUPPORTED_VERSIONS } from "./errors.js";

const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

type CapabilitySources = {
  resourceCatalog?: ReadonlyMap<string, unknown> | undefined;
  skillIndex?: ReadonlyMap<string, unknown> | undefined;
};

/**
 * `resources: {}` says only that the server has resources, never which. The Skills extension is declared
 * only when a skill exists, and always next to `resources`, which it depends on.
 */
export const serverCapabilities = ({ resourceCatalog, skillIndex }: CapabilitySources) => {
  if (!resourceCatalog) return { tools: {} };
  const capabilities = { tools: {}, resources: {} };
  return skillIndex ? { ...capabilities, extensions: { [SKILLS_EXTENSION_ID]: {} } } : capabilities;
};

/** Sets `resultType` and the hints itself: the hints depend on whether the caller was authenticated. */
export const DISCOVER_METHODS = {
  "server/discover": async ({ id, principal, options }) =>
    jsonResponse({
      data: rpcResult(id, {
        resultType: "complete",
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: serverCapabilities(options),
        _meta: { [SERVER_INFO_META_KEY]: options.serverInfo },
        ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
        ...discoverHints(principal === null),
      }),
    }),
} as const satisfies Record<string, RpcMethodHandler<unknown>>;
