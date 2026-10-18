import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMcpHandler } from "../../src/mcp/dispatch.js";
import type { AuditEntry } from "../../src/mcp/methods.js";
import { createToolRegistry, type ToolDef } from "../../src/mcp/registry.js";
import { MAX_VALIDATION_ERRORS, validateAgainstSchema } from "../../src/mcp/validate.js";

type Ctx = Record<string, never>;

type RpcBody = {
  error?: { code: number; message: string };
  result?: { isError?: boolean; content: Array<{ text: string }> };
};

const build = (tools: ToolDef<Ctx>[]) => {
  const audit: AuditEntry[] = [];
  const handler = createMcpHandler<Ctx>({
    registry: createToolRegistry<Ctx>(tools),
    serverInfo: { name: "t", version: "0" },
    wwwAuthenticate: { realm: "t", resourceMetadataUrl: "https://example.test/.well-known/x" },
    ports: {
      authenticate: async (req) =>
        req.headers.get("authorization") === "Bearer ok" ? { id: "u1", scopes: ["*"] } : null,
      context: async () => ({}) as Ctx,
      audit: (entry) => {
        audit.push(entry);
      },
    },
  });
  const call = async (params: unknown, token = true) => {
    const res = await handler.fetch(
      new Request("https://example.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: "Bearer ok" } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }),
      }),
    );
    return { res, body: (await res.json()) as RpcBody };
  };
  return { call, audit };
};

const purge: ToolDef<Ctx> = {
  name: "purge",
  description: "purge",
  inputSchema: {
    type: "object",
    properties: { filter: { type: "string" } },
  },
  handler: (_ctx, args) =>
    args.filter === undefined ? "purged EVERYTHING" : `purged ${args.filter}`,
};

describe("tools/call params handling", () => {
  it("a hostile params.name is rejected, not a 500 (unauthenticated: 401)", async () => {
    const { call, audit } = build([purge]);
    const anonymous = await call({ name: { toString: 1 } }, false);
    assert.equal(anonymous.res.status, 401);
    const authed = await call({ name: { toString: 1 } });
    assert.equal(authed.res.status, 200);
    assert.equal(authed.body.error?.code, -32602);
    assert.ok(audit.every((entry) => !/primitive/i.test(entry.error ?? "")));
  });

  it("a non-string name is not coerced into a real tool name", async () => {
    const { call } = build([purge]);
    const { body } = await call({ name: ["purge"], arguments: {} });
    assert.equal(body.error?.code, -32602);
  });

  for (const [label, args] of [
    ["a string", "filter=prod"],
    ["an array", ["prod"]],
    ["null", null],
    ["a number", 7],
  ] as const) {
    it(`rejects arguments that are ${label} instead of running the tool with none`, async () => {
      const { call, audit } = build([purge]);
      const { res, body } = await call({ name: "purge", arguments: args });
      assert.equal(res.status, 200);
      assert.equal(body.error?.code, -32602);
      assert.equal(body.result, undefined);
      assert.equal(audit.at(-1)?.error, "invalid_params");
    });
  }

  it("still runs with arguments omitted or an empty object", async () => {
    const { call } = build([purge]);
    assert.equal(
      (await call({ name: "purge" })).body.result?.content[0]?.text,
      "purged EVERYTHING",
    );
    assert.equal(
      (await call({ name: "purge", arguments: {} })).body.result?.content[0]?.text,
      "purged EVERYTHING",
    );
    assert.equal(
      (await call({ name: "purge", arguments: { filter: "prod" } })).body.result?.content[0]?.text,
      "purged prod",
    );
  });

  it("echoes and audits a long unknown tool name only up to a bound", async () => {
    const { call, audit } = build([purge]);
    const { body } = await call({ name: "x".repeat(100_000) });
    assert.ok((body.error?.message.length ?? 0) < 300);
    assert.ok((audit.at(-1)?.tool?.length ?? 0) < 300);
  });
});

describe("tools/call authorization comes before argument validation", () => {
  it("a caller without the tool's scope is told so (403), not that its arguments are malformed", async () => {
    const audit: AuditEntry[] = [];
    const handler = createMcpHandler<Ctx>({
      registry: createToolRegistry<Ctx>([{ ...purge, name: "admin", scope: "admin" }]),
      serverInfo: { name: "t", version: "0" },
      wwwAuthenticate: { realm: "t", resourceMetadataUrl: "https://example.test/.well-known/x" },
      ports: {
        authenticate: async () => ({ id: "u1", scopes: ["read"] }),
        context: async () => ({}) as Ctx,
        audit: (entry) => {
          audit.push(entry);
        },
      },
    });
    const res = await handler.fetch(
      new Request("https://example.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer x" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "admin", arguments: "x" },
        }),
      }),
    );
    assert.equal(res.status, 403);
    assert.equal(audit.at(-1)?.error, "missing_scope");
  });
});

describe("tool handler results", () => {
  const returning = (value: unknown): ToolDef<Ctx> => ({
    name: "ret",
    description: "ret",
    inputSchema: { type: "object", properties: {} },
    handler: (() => value) as ToolDef<Ctx>["handler"],
  });

  for (const [label, value] of [
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an object without content", { ok: true }],
  ] as const) {
    it(`a handler returning ${label} is a tool error, not a 500 or a malformed result`, async () => {
      const { call } = build([returning(value)]);
      const { res, body } = await call({ name: "ret", arguments: {} });
      assert.equal(res.status, 200);
      assert.equal(body.result?.isError, true);
      assert.equal(body.result?.content[0]?.text, "Tool returned an invalid result");
    });
  }

  it("truncates a very long tool failure text in the audit entry", async () => {
    const { call, audit } = build([
      {
        name: "big",
        description: "big",
        inputSchema: { type: "object", properties: {} },
        handler: () => ({ content: [{ type: "text", text: "e".repeat(50_000) }], isError: true }),
      },
    ]);
    await call({ name: "big", arguments: {} });
    assert.ok((audit.at(-1)?.error?.length ?? 0) <= 1001);
  });
});

describe("validation error budget", () => {
  const schema = { type: "array", items: { type: "string" } } as const;

  it("stops after MAX_VALIDATION_ERRORS however large the input", () => {
    const errors = validateAgainstSchema(
      Array.from({ length: 500_000 }, () => 1),
      schema,
    );
    assert.equal(errors.length, MAX_VALIDATION_ERRORS + 1);
    assert.match(errors.at(-1) ?? "", /stopped after 20 errors; more may follow/);
  });

  it("does not add the marker when every violation fit", () => {
    const errors = validateAgainstSchema([1, 2], schema);
    assert.equal(errors.length, 2);
    assert.doesNotMatch(errors.join(), /stopped/);
  });

  it("bounds additionalProperties:false errors for an object with many keys", () => {
    const value = Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`k${i}`, 1]));
    const errors = validateAgainstSchema(value, {
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    assert.equal(errors.length, MAX_VALIDATION_ERRORS + 1);
  });

  it("keeps required errors first and still reports a small number of real ones in full", () => {
    const errors = validateAgainstSchema(
      { b: 1 },
      {
        type: "object",
        required: ["a"],
        properties: { b: { type: "string" } },
      },
    );
    assert.deepEqual(errors, ["args.a: required", "args.b: expected string, got number"]);
  });

  it("caps the message a tools/call returns, even with attacker-chosen key names", async () => {
    const { call } = build([
      {
        name: "strict",
        description: "strict",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        handler: () => "ok",
      },
    ]);
    const huge = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`${i}${"k".repeat(20_000)}`, 1]),
    );
    const { body } = await call({ name: "strict", arguments: huge });
    assert.equal(body.result?.isError, true);
    assert.ok((body.result?.content[0]?.text.length ?? 0) <= 2001);
  });
});
