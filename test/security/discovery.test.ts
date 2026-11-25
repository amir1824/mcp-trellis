/**
 * SCRUM-25 T3, R8 R16 and M1 M5: what a caller can learn about tools and resources it may not use,
 * under each value of `hideToolsOutsideScope`. Stub ports: this proves the library's rule, not a host's.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { McpHandlerOptions } from "../../src/mcp/types.js";
import {
  ADMIN_URI,
  type Ctx,
  callTool,
  makeEnv,
  PRODUCTS_URI,
  rpc,
  TOKENS,
} from "../mcp/ui/harness.js";

type Tool = { name: string };
type ListReply = { result?: { tools?: Tool[]; resources?: Array<{ uri: string }> } };

const HIDDEN_TOOL = "admin_report";
/** Same length as the hidden tool, so a reply for it differs from the hidden one only by the name. */
const MISSING_TOOL = "admin_repost";

/** `default` leaves the option out, as an existing integration does. */
const MODES = {
  default: {},
  enabled: { hideToolsOutsideScope: true },
  strict: { hideToolsOutsideScope: "strict" },
} as const;

const toolNames = async (options: Partial<McpHandlerOptions<Ctx>>): Promise<string[]> => {
  const env = makeEnv({ options });
  const reply = (await rpc(env, "tools/list", undefined, TOKENS.alice)).body as ListReply;
  return (reply.result?.tools ?? []).map((tool) => tool.name);
};

describe("R8 R16 listing under each value of hideToolsOutsideScope", () => {
  it("R8 M5 by default a tool outside the caller's scope is listed, as before", async () => {
    assert.ok((await toolNames(MODES.default)).includes(HIDDEN_TOOL));
  });

  it("R8 R16 with true and with strict a tool outside the caller's scope is not listed", async () => {
    const [enabled, strict] = await Promise.all([
      toolNames(MODES.enabled),
      toolNames(MODES.strict),
    ]);
    assert.deepEqual([enabled.includes(HIDDEN_TOOL), strict.includes(HIDDEN_TOOL)], [false, false]);
  });

  it("R8 R16 resources/list never lists a resource the caller has no tool for, in every mode", async () => {
    const lists = await Promise.all(
      [MODES.default, MODES.enabled, MODES.strict].map(async (options) => {
        const env = makeEnv({ options });
        const reply = (await rpc(env, "resources/list", undefined, TOKENS.alice)).body as ListReply;
        return (reply.result?.resources ?? []).map((resource) => resource.uri);
      }),
    );
    assert.deepEqual(
      lists.map((uris) => uris.includes(ADMIN_URI)),
      [false, false, false],
    );
    assert.deepEqual(
      lists.map((uris) => uris.includes(PRODUCTS_URI)),
      [true, true, true],
    );
  });
});

describe("R8 R16 calling a tool outside the caller's scope", () => {
  it("R8 M5 with false and with true the call is a 403 that names the scope, as before", async () => {
    const replies = await Promise.all(
      [MODES.default, MODES.enabled].map((options) =>
        callTool(makeEnv({ options }), HIDDEN_TOOL, TOKENS.alice),
      ),
    );
    assert.deepEqual(
      replies.map((reply) => [reply.status, /scope="admin"/.test(reply.challenge ?? "")]),
      [
        [403, true],
        [403, true],
      ],
    );
  });

  it("R8 R16 with strict the call answers exactly like a tool that does not exist", async () => {
    const env = makeEnv({ options: { hideToolsOutsideScope: "strict" } });
    const hidden = await callTool(env, HIDDEN_TOOL, TOKENS.alice);
    const missing = await callTool(env, MISSING_TOOL, TOKENS.alice);
    assert.equal(hidden.status, missing.status);
    assert.equal(hidden.challenge, missing.challenge);
    assert.equal(
      hidden.text.replace(HIDDEN_TOOL, "NAME"),
      missing.text.replace(MISSING_TOOL, "NAME"),
    );
  });

  it("R8 M1 with strict the hidden call never runs the tool or builds a context, and is audited as a missing scope", async () => {
    const env = makeEnv({ options: { hideToolsOutsideScope: "strict" } });
    await callTool(env, HIDDEN_TOOL, TOKENS.alice);
    assert.deepEqual(env.contexts, []);
    assert.deepEqual(
      env.audits.map((entry) => [entry.principalId, entry.tool, entry.ok, entry.error]),
      [["alice", HIDDEN_TOOL, false, "missing_scope"]],
    );
  });

  it("R8 with strict a caller that holds the scope still runs the tool", async () => {
    const env = makeEnv({ options: { hideToolsOutsideScope: "strict" } });
    const reply = await callTool(env, "plain_tool", TOKENS.alice);
    assert.equal(reply.status, 200);
    assert.deepEqual(env.contexts, ["alice"]);
  });

  it("R8 with strict a request with no principal is still a 401, not an unknown tool", async () => {
    const env = makeEnv({
      options: { hideToolsOutsideScope: "strict", publicMethods: new Set(["tools/call"]) },
    });
    const reply = await callTool(env, HIDDEN_TOOL);
    assert.equal(reply.status, 401);
  });
});
