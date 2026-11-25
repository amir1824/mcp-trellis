import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UiResource } from "../../../src/mcp/ui/types.js";
import { ADMIN_URI, makeEnv, RESOURCES, readResource, rpc, TOKENS } from "./harness.js";

const SECRET_BLOB = Buffer.from("<html>top-secret-blob</html>").toString("base64");

const FULL: UiResource[] = [
  RESOURCES[0] as UiResource,
  RESOURCES[1] as UiResource,
  {
    uri: ADMIN_URI,
    blob: SECRET_BLOB,
    csp: { frameDomains: ["https://secret-frame.example.com"] },
    permissions: { camera: {}, microphone: {} },
    domain: "secret-domain.example.com",
    prefersBorder: true,
  },
];

const LEAKS = [
  SECRET_BLOB,
  "top-secret",
  "secret-frame",
  "secret-domain",
  "camera",
  "microphone",
  "permissions",
  "csp",
  "prefersBorder",
  "blob",
];

const leaked = (text: string): string[] => LEAKS.filter((leak) => text.includes(leak));

const MODES: Array<[string, boolean | "strict"]> = [
  ["off", false],
  ["true", true],
  ["strict", "strict"],
];

describe("U4 a denied or anonymous read never returns blob, permissions, csp or domain", () => {
  MODES.forEach(([label, mode]) => {
    it(`U4 hideToolsOutsideScope ${label}: a principal without the scope`, async () => {
      const env = makeEnv({ resources: FULL, options: { hideToolsOutsideScope: mode } });
      const denied = await readResource(env, ADMIN_URI, TOKENS.alice);
      assert.equal(denied.body.result, undefined);
      assert.deepEqual(leaked(denied.text), []);
    });

    it(`U4 hideToolsOutsideScope ${label}: no token`, async () => {
      const env = makeEnv({ resources: FULL, options: { hideToolsOutsideScope: mode } });
      const anonymous = await readResource(env, ADMIN_URI);
      assert.equal(anonymous.status, 401);
      assert.deepEqual(leaked(anonymous.text), []);
    });

    it(`U4 hideToolsOutsideScope ${label}: resources/list never carries them`, async () => {
      const env = makeEnv({ resources: FULL, options: { hideToolsOutsideScope: mode } });
      const listed = await rpc(env, "resources/list", undefined, TOKENS.root);
      assert.deepEqual(leaked(listed.text), []);
    });
  });

  it("U4 the same read with the scope returns the blob and every field", async () => {
    const env = makeEnv({ resources: FULL });
    const allowed = await readResource(env, ADMIN_URI, TOKENS.root);
    assert.deepEqual(allowed.body.result, {
      contents: [
        {
          uri: ADMIN_URI,
          mimeType: "text/html;profile=mcp-app",
          blob: SECRET_BLOB,
          _meta: {
            ui: {
              csp: { frameDomains: ["https://secret-frame.example.com"] },
              permissions: { camera: {}, microphone: {} },
              domain: "secret-domain.example.com",
              prefersBorder: true,
            },
          },
        },
      ],
    });
  });
});
