import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ResourceDef } from "../../../src/mcp/resources/types.js";
import { UI_MIME_TYPE } from "../../../src/mcp/ui/types.js";
import { buildHandler, json, modern, READ_TOKEN, send } from "../modern/harness.js";
import {
  callTool,
  makeEnv,
  PRODUCTS_URI,
  readResource,
  RESOURCES as UI_DOCUMENTS,
} from "../ui/harness.js";
import {
  capturePost,
  HANDBOOK_TEXT,
  listedUris,
  makeResourceEnv,
  rpc,
  TOKENS,
  URIS,
} from "./harness.js";

type Reply = { result?: Record<string, unknown>; error?: { code: number } };

const METHOD_NOT_FOUND = -32601;

const MODERN_RESOURCES: ResourceDef<unknown>[] = [
  { uri: "docs://modern/guide", name: "Guide", scope: "read", read: () => "modern guide" },
  { uri: "docs://modern/secret", name: "Secret", scope: "ingest", read: () => "ingest only" },
];

/** What the `*` principal sees: `acmeOnly` needs a tenant claim and `broken` has an `allow` that throws. */
const ROOT_VISIBLE = [URIS.handbook, URIS.open, URIS.admin, URIS.tenant, URIS.typed];

const UNIMPLEMENTED_METHODS = [
  "resources/templates/list",
  "resources/subscribe",
  "completion/complete",
];

describe("resources protocol R2 R5 R7 R13 R20", () => {
  describe("R2 list and read", () => {
    it("R2 lists general entries as uri, name, description and a text/plain default", async () => {
      const env = makeResourceEnv();
      const reply = await rpc(env, "resources/list", undefined, TOKENS.root);
      const { resources } = reply.body.result as { resources: Array<Record<string, unknown>> };
      assert.deepEqual(resources[0], {
        uri: URIS.handbook,
        name: "Handbook",
        description: "Team handbook",
        mimeType: "text/plain",
      });
      assert.deepEqual(resources[1], { uri: URIS.open, name: "Open", mimeType: "text/plain" });
    });

    it("R2 lists a declared mime type and keeps registration order", async () => {
      const env = makeResourceEnv();
      const reply = await rpc(env, "resources/list", undefined, TOKENS.root);
      const { resources } = reply.body.result as { resources: Array<Record<string, unknown>> };
      assert.deepEqual(
        resources.map(({ uri }) => uri),
        ROOT_VISIBLE,
      );
      assert.equal(resources[4]?.mimeType, "text/csv");
    });

    it("R2 lists UI documents first, then general resources", async () => {
      const env = makeResourceEnv({ withUi: true });
      const uris = await listedUris(env, TOKENS.root);
      assert.deepEqual(uris, [...UI_DOCUMENTS.map(({ uri }) => uri), ...ROOT_VISIBLE]);
    });

    it("R2 reads a general resource as one text content", async () => {
      const reply = await readResource(makeResourceEnv(), URIS.handbook, TOKENS.alice);
      assert.deepEqual(reply.body.result, {
        contents: [{ uri: URIS.handbook, mimeType: "text/plain", text: HANDBOOK_TEXT }],
      });
    });

    it("R2 a body's own mime type wins over the declared one", async () => {
      const reply = await readResource(makeResourceEnv(), URIS.typed, TOKENS.alice);
      assert.deepEqual(reply.body.result, {
        contents: [{ uri: URIS.typed, mimeType: "text/csv", text: "a,b" }],
      });
    });

    it("R2 still reads a ui:// document with its app mime type next to general resources", async () => {
      const reply = await readResource(
        makeResourceEnv({ withUi: true }),
        PRODUCTS_URI,
        TOKENS.alice,
      );
      const { contents } = reply.body.result as { contents: Array<{ mimeType: string }> };
      assert.equal(contents[0]?.mimeType, UI_MIME_TYPE);
    });
  });

  describe("R5 capability says only that resources exist", () => {
    it("R5 initialize and server/discover carry resources: {} and no uri or name", async () => {
      const env = makeResourceEnv();
      const initialize = await capturePost(env, "initialize", {});
      const discover = await capturePost(env, "server/discover", {});
      assert.match(initialize.body, /"capabilities":\{"tools":\{\},"resources":\{\}\}/);
      assert.equal(initialize.body.includes("docs://"), false);
      assert.equal(discover.body.includes("Handbook"), false);
    });
  });

  describe("R7 methods that stay unimplemented", () => {
    UNIMPLEMENTED_METHODS.forEach((method) => {
      it(`R7 ${method} answers -32601 on a server with general resources`, async () => {
        const reply = await rpc(makeResourceEnv(), method, {}, TOKENS.root);
        assert.equal(reply.body.error?.code, METHOD_NOT_FOUND);
      });

      it(`R7 ${method} answers -32601 on a UI-only server`, async () => {
        const reply = await rpc(
          makeResourceEnv({ withUi: true, resources: [] }),
          method,
          {},
          TOKENS.root,
        );
        assert.equal(reply.body.error?.code, METHOD_NOT_FOUND);
      });
    });
  });

  describe("R13 an integration that registers no general resource", () => {
    it("R13 answers byte-identically with resources omitted, empty or undefined", async () => {
      const withEmptyList = makeResourceEnv({ withUi: true, resources: [] });
      const baseline = makeEnv();
      const requests = [
        ["initialize", {}],
        ["tools/list", {}],
        ["resources/list", undefined],
        ["resources/read", { uri: PRODUCTS_URI }],
        ["resources/read", { uri: "ui://shop/nope" }],
        ["resources/templates/list", {}],
      ] as const;
      const replies = await Promise.all(
        requests.map(async ([method, params]) => ({
          actual: await capturePost(withEmptyList, method, params, TOKENS.alice),
          expected: await capturePost(baseline, method, params, TOKENS.alice),
        })),
      );
      assert.deepEqual(
        replies.map(({ actual }) => actual),
        replies.map(({ expected }) => expected),
      );
    });

    it("R13 a server with no resources at all answers resources/list as an unknown method", async () => {
      const handler = buildHandler().handler;
      const res = await send(handler, { ...modern("resources/list", {}, READ_TOKEN) });
      const body = await json<Reply>(res);
      assert.equal(body.error?.code, METHOD_NOT_FOUND);
    });
  });

  describe("R20 the 2026-07-28 path", () => {
    it("R20 lists and reads with private hints, a zero ttl and Mcp-Name", async () => {
      const { handler } = buildHandler({ resources: MODERN_RESOURCES });
      const list = await json<Reply>(await send(handler, modern("resources/list", {}, READ_TOKEN)));
      const read = await json<Reply>(
        await send(handler, modern("resources/read", { uri: "docs://modern/guide" }, READ_TOKEN)),
      );
      assert.deepEqual(
        (list.result as { resources: Array<{ uri: string }> }).resources.map(({ uri }) => uri),
        ["docs://modern/guide"],
      );
      assert.deepEqual(read.result, {
        contents: [{ uri: "docs://modern/guide", mimeType: "text/plain", text: "modern guide" }],
        resultType: "complete",
        ttlMs: 0,
        cacheScope: "private",
      });
    });

    it("R20 a read whose Mcp-Name header names another uri is refused before the provider runs", async () => {
      const { handler } = buildHandler({ resources: MODERN_RESOURCES });
      const call = modern("resources/read", { uri: "docs://modern/guide" }, READ_TOKEN);
      const res = await send(handler, {
        ...call,
        headers: { ...call.headers, "Mcp-Name": "docs://modern/secret" },
      });
      assert.equal(res.status, 400);
    });

    it("R20 a UI-only legacy tool call is untouched by general resources", async () => {
      const reply = await callTool(
        makeResourceEnv({ withUi: true }),
        "list_products",
        TOKENS.alice,
      );
      assert.equal(reply.status, 200);
    });
  });
});
