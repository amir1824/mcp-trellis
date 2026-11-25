import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ResourceDef } from "../../../src/mcp/resources/types.js";
import { UI_MIME_TYPE } from "../../../src/mcp/ui/types.js";
import type { Ctx } from "../ui/harness.js";
import { capturePost, makeResourceEnv, rpc, SECRET_FRAGMENT, TOKENS } from "./harness.js";

const INTERNAL_ERROR = -32603;
const FAILED_URI = "docs://failing";

class LeakyError extends Error {
  override readonly stack = `at ${SECRET_FRAGMENT} (/srv/app/db.ts:1:1)`;
}

const failing = (read: () => unknown): ResourceDef<Ctx> => ({
  uri: FAILED_URI,
  name: "Failing",
  read: read as ResourceDef<Ctx>["read"],
});

const throwsLeaky = (): never => {
  throw new LeakyError(SECRET_FRAGMENT);
};

const RESERVED_ATTEMPTS: ReadonlyArray<[string, ResourceDef<Ctx>]> = [
  ["the ui:// scheme", { uri: "ui://x/y", name: "x", read: () => "x" }],
  ["the app mime type", { uri: "docs://x", name: "x", mimeType: UI_MIME_TYPE, read: () => "x" }],
];

const THROWS: ReadonlyArray<[string, () => unknown]> = [
  [
    "a sync throw",
    () => {
      throw new LeakyError(SECRET_FRAGMENT);
    },
  ],
  ["a rejected promise", () => Promise.reject(new LeakyError(SECRET_FRAGMENT))],
  [
    "a thrown string",
    () => {
      throw SECRET_FRAGMENT;
    },
  ],
  [
    "a thrown object",
    () => {
      throw { message: SECRET_FRAGMENT, tenant: "globex" };
    },
  ],
];

const BAD_SHAPES: ReadonlyArray<[string, () => unknown]> = [
  ["undefined", () => undefined],
  ["null", () => null],
  ["a number", () => 7],
  ["an array", () => ["text"]],
  ["an object without text", () => ({})],
  ["a non-string text", () => ({ text: 5 })],
  ["a non-string mimeType", () => ({ text: "x", mimeType: 5 })],
  ["an empty mimeType", () => ({ text: "x", mimeType: "" })],
  ["the app mime type", () => ({ text: "<p>x</p>", mimeType: UI_MIME_TYPE })],
  [
    "the app mime type in other spelling",
    () => ({ text: "x", mimeType: "TEXT/HTML; profile=mcp-app" }),
  ],
];

const readFailing = (read: () => unknown) => {
  const env = makeResourceEnv({ resources: [failing(read)] });
  return { env, reply: rpc(env, "resources/read", { uri: FAILED_URI }, TOKENS.alice) };
};

describe("resources failure M4 M6", () => {
  THROWS.forEach(([label, read]) => {
    it(`M4 ${label} answers a fixed -32603 and nothing of the exception reaches the caller or the audit`, async () => {
      const { env, reply } = readFailing(read);
      const answered = await reply;
      assert.equal(answered.status, 200);
      assert.deepEqual(answered.body.error, {
        code: INTERNAL_ERROR,
        message: "Resource read failed",
      });
      assert.equal(JSON.stringify([answered.text, env.audits]).includes(SECRET_FRAGMENT), false);
      assert.equal(JSON.stringify(env.audits).includes("globex"), false);
    });
  });

  BAD_SHAPES.forEach(([label, read]) => {
    it(`M4 M6 a provider answering ${label} fails the same fixed way`, async () => {
      const { env, reply } = readFailing(read);
      const answered = await reply;
      assert.equal(answered.body.error?.message, "Resource read failed");
      assert.deepEqual(
        env.audits.map(({ method, ok, error }) => ({ method, ok, error })),
        [{ method: "resources/read", ok: false, error: "resource_failed" }],
      );
    });
  });

  it("M4 a retry repeats the same bytes", async () => {
    const env = makeResourceEnv({ resources: [failing(throwsLeaky)] });
    const first = await capturePost(env, "resources/read", { uri: FAILED_URI }, TOKENS.alice);
    const second = await capturePost(env, "resources/read", { uri: FAILED_URI }, TOKENS.alice);
    assert.deepEqual(first, second);
  });

  it("M4 the audit entry of a failed read names the uri, the principal and the fixed reason only", async () => {
    const { env, reply } = readFailing(throwsLeaky);
    await reply;
    assert.deepEqual(
      env.audits.map(({ method, resource, principalId, ok, error }) => ({
        method,
        resource,
        principalId,
        ok,
        error,
      })),
      [
        {
          method: "resources/read",
          resource: FAILED_URI,
          principalId: "alice",
          ok: false,
          error: "resource_failed",
        },
      ],
    );
  });

  RESERVED_ATTEMPTS.forEach(([label, attempt]) => {
    it(`M6 a general resource may not take ${label}`, () => {
      assert.throws(() => makeResourceEnv({ resources: [attempt] }), /uiResources owns/);
    });
  });
});
