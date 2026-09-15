/**
 * Public surface snapshot. A failure here means an export was added or
 * removed: update the list deliberately, and CHANGELOG + docs/reference.md
 * with it. Deprecated aliases must stay identical to their advanced export.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as advanced from "../src/advanced.js";
import * as deprecatedRoot from "../src/deprecated.js";
import * as deprecatedOAuth from "../src/oauth/deprecated.js";

const STABLE_ROOT = [
  "CLIENT_PROFILES",
  "DEFAULT_CLIENTS",
  "DEFAULT_PROTOCOL_VERSION",
  "JSONRPC_INTERNAL_ERROR",
  "JSONRPC_INVALID_PARAMS",
  "JSONRPC_INVALID_REQUEST",
  "JSONRPC_METHOD_NOT_FOUND",
  "JSONRPC_PARSE_ERROR",
  "JSONRPC_UNAUTHORIZED",
  "PROTOCOL_VERSIONS",
  "apiTool",
  "authMethodsFor",
  "consoleAudit",
  "createMcpApp",
  "createMcpHandler",
  "createToolRegistry",
  "defineTool",
  "hasDynamicClient",
  "jsonResponse",
  "parseBearer",
  "preRegisteredClients",
  "redirectUrisFor",
  "rejectQueryToken",
  "rpcError",
  "rpcResult",
  "wwwAuthenticateHeader",
];

const STABLE_OAUTH = [
  "CLAUDE_CALLBACK",
  "DEFAULT_RESOURCE_PATH",
  "DEFAULT_SCOPE",
  "GRANT_TYPES",
  "OAUTH_ERRORS",
  "TOKEN_ENDPOINT_AUTH_METHODS",
  "authorizationServerMetadata",
  "canonicalResource",
  "createOAuthRouter",
  "hashClientSecret",
  "isAllowedRedirectUri",
  "isCimdClientId",
  "mcpWwwAuthenticate",
  "protectedResourceMetadata",
  "resolveCimdClient",
  "resourcesEqual",
  "verifyClientSecret",
];

const NODE = [
  "InvalidOriginError",
  "asNodeHandler",
  "bodyLimitForPath",
  "isAllowedOrigin",
  "isAllowedRequestOrigin",
  "readNodeBody",
  "resolveOrigin",
  "sendWebResponse",
  "toWebRequest",
];

const names = (module: object): string[] => Object.keys(module).sort();
const sorted = (list: string[]): string[] => [...list].sort();

describe("public exports", () => {
  it("mcp-trellis = stable root + deprecated aliases", async () => {
    const root = await import("../src/server.js");
    assert.deepEqual(names(root), sorted([...STABLE_ROOT, ...names(deprecatedRoot)]));
  });

  it("mcp-trellis/oauth = stable oauth + deprecated aliases", async () => {
    const oauth = await import("../src/oauth/router.js");
    assert.deepEqual(names(oauth), sorted([...STABLE_OAUTH, ...names(deprecatedOAuth)]));
  });

  it("mcp-trellis/node", async () => {
    assert.deepEqual(names(await import("../src/adapters/node.js")), sorted(NODE));
  });

  it("mcp-trellis/advanced holds exactly the deprecated symbols", () => {
    assert.deepEqual(
      names(advanced),
      sorted([...names(deprecatedRoot), ...names(deprecatedOAuth)]),
    );
  });

  it("every deprecated alias is the same value as its advanced export", () => {
    const all = { ...deprecatedRoot, ...deprecatedOAuth } as Record<string, unknown>;
    const target = advanced as Record<string, unknown>;
    for (const [name, value] of Object.entries(all)) {
      assert.equal(value, target[name], `${name} diverged from mcp-trellis/advanced`);
    }
  });
});
