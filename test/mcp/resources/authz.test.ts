import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ResourceDef } from "../../../src/mcp/resources/types.js";
import type { Ctx } from "../ui/harness.js";
import {
  ADMIN_DESCRIPTION,
  ADMIN_TEXT,
  capturePost,
  listedUris,
  makeFixture,
  makeResourceEnv,
  rpc,
  TOKENS,
  URIS,
} from "./harness.js";

const INVALID_PARAMS = -32602;
const INSUFFICIENT_SCOPE = -32003;
const UNAUTHORIZED = -32001;

const VISIBLE_TO = [
  [
    "alice (read, acme)",
    TOKENS.alice,
    [URIS.handbook, URIS.open, URIS.acmeOnly, URIS.tenant, URIS.typed],
  ],
  ["bob (read and write, globex)", TOKENS.bob, [URIS.handbook, URIS.open, URIS.tenant, URIS.typed]],
  ["carol (write, initech)", TOKENS.carol, [URIS.open, URIS.tenant, URIS.typed]],
  ["eve (no scopes)", TOKENS.eve, [URIS.open, URIS.tenant, URIS.typed]],
  [
    "root (*), but allow still applies",
    TOKENS.root,
    [URIS.handbook, URIS.open, URIS.admin, URIS.tenant, URIS.typed],
  ],
] as const;

/** Variants of a denied uri that must never reach it: the lookup is an exact Map.get. */
const URI_VARIANTS = [
  "DOCS://admin/keys",
  "docs://Admin/keys",
  "docs://admin/keys/",
  "docs://admin/keys#",
  "docs://admin/keys?",
  "docs://admin/%6beys",
  "docs://admin/keys%00",
  " docs://admin/keys",
  "__proto__",
  "constructor",
  "toString",
  "hasOwnProperty",
] as const;

const HIDING_MODES = [true, "strict"] as const;

/** One server holds the resource, the other registers only a different one: a read of `uri` is unknown on it. */
const withAndWithout = (uri: string, hideToolsOutsideScope: boolean | "strict") => {
  const { resources } = makeFixture();
  const options = { hideToolsOutsideScope };
  return {
    registered: makeResourceEnv({ resources, options }),
    unregistered: makeResourceEnv({
      resources: resources.filter((def) => def.uri !== uri),
      options,
    }),
  };
};

describe("resources authz R3 R11 M1 M3 M7 M8", () => {
  describe("R3 listing is filtered by scope and allow", () => {
    for (const [who, token, expected] of VISIBLE_TO) {
      it(`R3 M1 lists to ${who} only what it may read`, async () => {
        assert.deepEqual(await listedUris(makeResourceEnv(), token), expected);
      });
    }

    for (const mode of HIDING_MODES) {
      it(`R11 lists the same under hideToolsOutsideScope ${String(mode)}`, async () => {
        const env = makeResourceEnv({ options: { hideToolsOutsideScope: mode } });
        assert.deepEqual(await listedUris(env, TOKENS.alice), VISIBLE_TO[0][2]);
      });
    }
  });

  describe("R3 a denied read by default", () => {
    it("R3 a missing scope answers 403 insufficient_scope naming the scope", async () => {
      const reply = await rpc(
        makeResourceEnv(),
        "resources/read",
        { uri: URIS.admin },
        TOKENS.alice,
      );
      assert.equal(reply.status, 403);
      assert.equal(reply.body.error?.code, INSUFFICIENT_SCOPE);
      assert.match(reply.challenge ?? "", /error="insufficient_scope".*scope="admin"/);
    });

    it("R3 M1 a false allow answers like an unknown uri, with no scope to step up to", async () => {
      const reply = await rpc(
        makeResourceEnv(),
        "resources/read",
        { uri: URIS.acmeOnly },
        TOKENS.bob,
      );
      assert.equal(reply.status, 200);
      assert.equal(reply.challenge, null);
      assert.equal(reply.body.error?.code, INVALID_PARAMS);
      assert.equal(reply.body.error?.message, `Unknown resource: ${URIS.acmeOnly}`);
    });

    it("M1 M8 a throwing allow denies and leaks nothing of the exception", async () => {
      const reply = await rpc(
        makeResourceEnv(),
        "resources/read",
        { uri: URIS.broken },
        TOKENS.root,
      );
      assert.equal(reply.body.error?.code, INVALID_PARAMS);
      assert.equal(reply.text.includes("hunter2"), false);
    });

    it("M1 a read fails the allow first when the scope fails too", async () => {
      const both: ResourceDef<Ctx> = {
        uri: "docs://both",
        name: "Both",
        scope: "admin",
        allow: () => false,
        read: () => "never",
      };
      const reply = await rpc(
        makeResourceEnv({ resources: [both] }),
        "resources/read",
        { uri: both.uri },
        TOKENS.alice,
      );
      assert.equal(reply.status, 200);
      assert.equal(reply.body.error?.code, INVALID_PARAMS);
    });

    it("M1 an allow that returns a promise or a truthy non-boolean denies", async () => {
      const lax = ["yes", Promise.resolve(true), 1].map(
        (value, index): ResourceDef<Ctx> => ({
          uri: `docs://lax/${index}`,
          name: "Lax",
          allow: (() => value) as unknown as () => boolean,
          read: () => "never",
        }),
      );
      const replies = await Promise.all(
        lax.map((def) =>
          rpc(
            makeResourceEnv({ resources: lax }),
            "resources/read",
            { uri: def.uri },
            TOKENS.alice,
          ),
        ),
      );
      assert.deepEqual(
        replies.map((reply) => reply.body.error?.code),
        [INVALID_PARAMS, INVALID_PARAMS, INVALID_PARAMS],
      );
    });
  });

  describe("M1 uri variants never match", () => {
    for (const variant of URI_VARIANTS) {
      it(`M1 ${JSON.stringify(variant)} is unknown to a principal without the scope`, async () => {
        const reply = await rpc(
          makeResourceEnv(),
          "resources/read",
          { uri: variant },
          TOKENS.alice,
        );
        assert.equal(reply.body.error?.code, INVALID_PARAMS);
        assert.equal(reply.text.includes(ADMIN_TEXT), false);
      });
    }

    it("M1 alice's listing never holds the admin resource", async () => {
      assert.equal((await listedUris(makeResourceEnv(), TOKENS.alice)).includes(URIS.admin), false);
    });
  });

  describe("M3 a hidden resource is indistinguishable from an unknown one", () => {
    for (const mode of HIDING_MODES) {
      for (const uri of [URIS.admin, URIS.acmeOnly, URIS.broken]) {
        it(`M3 ${String(mode)}: ${uri} answers the same bytes as an unregistered uri`, async () => {
          const { registered, unregistered } = withAndWithout(uri, mode);
          const hidden = await capturePost(registered, "resources/read", { uri }, TOKENS.eve);
          const unknown = await capturePost(unregistered, "resources/read", { uri }, TOKENS.eve);
          assert.deepEqual(hidden, unknown);
          assert.equal(JSON.parse(hidden.body).error.code, INVALID_PARAMS);
        });
      }
    }

    it("M3 a false allow equals an unknown uri by default, with no hide option at all", async () => {
      const { registered, unregistered } = withAndWithout(URIS.acmeOnly, false);
      const hidden = await capturePost(
        registered,
        "resources/read",
        { uri: URIS.acmeOnly },
        TOKENS.bob,
      );
      const unknown = await capturePost(
        unregistered,
        "resources/read",
        { uri: URIS.acmeOnly },
        TOKENS.bob,
      );
      assert.deepEqual(hidden, unknown);
    });
  });

  describe("M7 a public method still needs a principal", () => {
    const publicOptions = { publicMethods: new Set(["resources/list", "resources/read"]) };

    for (const [method, params] of [
      ["resources/list", undefined],
      ["resources/read", { uri: URIS.open }],
    ] as const) {
      it(`M7 ${method} answers 401 to a request with no token, though listed in publicMethods`, async () => {
        const reply = await rpc(makeResourceEnv({ options: publicOptions }), method, params);
        assert.equal(reply.status, 401);
        assert.equal(reply.body.error?.code, UNAUTHORIZED);
        assert.notEqual(reply.challenge, null);
      });
    }
  });

  describe("M8 nothing about a resource reaches a principal that may not see it", () => {
    it("M8 a denied read shows the scope and nothing of the name, description or body", async () => {
      const env = makeResourceEnv();
      const reply = await rpc(env, "resources/read", { uri: URIS.admin }, TOKENS.alice);
      const everything = JSON.stringify([reply.text, reply.challenge, env.audits]);
      const leaked = [ADMIN_TEXT, ADMIN_DESCRIPTION, "Admin keys"].map((secret) =>
        everything.includes(secret),
      );
      assert.deepEqual(leaked, [false, false, false]);
    });
  });
});
