import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sha256Base64Url } from "../../../src/oauth/crypto/pkce.js";
import { stubPorts } from "../../helpers/ports.js";
import { createOAuthRouter } from "../../helpers/router.js";
import { DEFAULT_ORIGIN } from "../../helpers/target.js";

const ORIGIN = DEFAULT_ORIGIN;
const RESOURCE = `${ORIGIN}/mcp`;
const VALID_SECRET = "a-perfectly-fine-code-secret-32-chars-plus!!";
const SHORT_PLACEHOLDERS = ["e2e-code-secret-value", "change-me", "test-secret-value"];
const DO_NOT_REUSE_SECRETS = [
  "example-http-server-code-secret-do-not-reuse",
  "example-multi-tenant-code-secret-do-not-reuse",
  "example-express-code-secret-do-not-reuse!!!!!!",
  "example-nextjs-route-code-secret-do-not-reuse!!",
  "my-edited-copy-of-an-example-secret-do-not-reuse-123",
];
const constructionPort = (codeSecret: string) => () =>
  createOAuthRouter({ ports: stubPorts({ codeSecret }) });
// The construction error message, or "" when the secret was accepted (which no expected pattern matches).
const constructionError = (codeSecret: string): string => {
  try {
    constructionPort(codeSecret)();
    return "";
  } catch (error) {
    return String(error);
  }
};

describe("codeSecret validation — string form (construction-time)", () => {
  it("throws for a secret under 32 characters, naming the length and the fix", () => {
    assert.throws(
      () => createOAuthRouter({ ports: stubPorts({ codeSecret: "too-short" }) }),
      /at least 32 characters.*openssl rand -base64 32/s,
    );
  });

  SHORT_PLACEHOLDERS.forEach((literal) => {
    it(`rejects the short published placeholder ${JSON.stringify(literal)} on the length rule`, () => {
      assert.throws(constructionPort(literal), /at least 32 characters/);
    });
  });

  DO_NOT_REUSE_SECRETS.forEach((literal) => {
    it(`rejects the do-not-reuse example secret ${JSON.stringify(literal)}`, () => {
      assert.throws(constructionPort(literal), /published in this package's own docs or examples/);
    });
  });

  it("rejects every codeSecret literal published in examples/, README.md, or docs/", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const files = [
      "README.md",
      ...readdirSync(join(root, "examples"), { recursive: true })
        .map(String)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => join("examples", f)),
      ...readdirSync(join(root, "docs"), { recursive: true })
        .map(String)
        .filter((f) => f.endsWith(".md"))
        .map((f) => join("docs", f)),
    ];
    const LITERAL = /(?:codeSecret|CODE_SECRET)\s*[:=]\s*["'`]([^"'`$]+)["'`]/g;
    const rejection = /published in this package's own docs or examples|at least 32 characters/;
    const accepted = files
      .flatMap((file) =>
        [...readFileSync(join(root, file), "utf8").matchAll(LITERAL)].map(([, literal]) => ({
          file,
          literal: literal ?? "",
        })),
      )
      .filter(({ literal }) => !rejection.test(constructionError(literal)));
    assert.deepEqual(accepted, [], "published codeSecret literals the library accepts");
  });

  it("accepts a 32+ character secret that isn't denylisted", () => {
    assert.doesNotThrow(() =>
      createOAuthRouter({ ports: stubPorts({ codeSecret: VALID_SECRET }) }),
    );
  });
});

describe("codeSecret validation — function form (validated on every call)", () => {
  it("does not throw at construction — the value isn't known yet", () => {
    assert.doesNotThrow(() =>
      createOAuthRouter({
        ports: stubPorts({ codeSecret: () => "whatever-this-turns-out-to-be" }),
      }),
    );
  });

  it("surfaces as server_error when a per-request secret is too short", async () => {
    const router = createOAuthRouter({
      ports: stubPorts({ codeSecret: () => "short" }),
    });
    const url = new URL(`${ORIGIN}/mcp/oauth/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: "c1",
      redirect_uri: "http://127.0.0.1:4321/cb",
      code_challenge: await sha256Base64Url("verifier-value-long-enough-for-pkce"),
      code_challenge_method: "S256",
      resource: RESOURCE,
    }).toString();
    const res = await router.tryHandle(new Request(url, { method: "GET" }));
    assert.ok(res);
    assert.equal(res.status, 500);
    assert.equal(((await res.json()) as { error: string }).error, "server_error");
  });

  it("surfaces as server_error when a per-request secret is a denylisted literal", async () => {
    const router = createOAuthRouter({
      ports: stubPorts({ codeSecret: () => "change-me" }),
    });
    const url = new URL(`${ORIGIN}/mcp/oauth/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: "c1",
      redirect_uri: "http://127.0.0.1:4321/cb",
      code_challenge: await sha256Base64Url("verifier-value-long-enough-for-pkce"),
      code_challenge_method: "S256",
      resource: RESOURCE,
    }).toString();
    const res = await router.tryHandle(new Request(url, { method: "GET" }));
    assert.ok(res);
    assert.equal(res.status, 500);
    assert.equal(((await res.json()) as { error: string }).error, "server_error");
  });

  it("succeeds end to end when the per-request secret passes validation", async () => {
    const router = createOAuthRouter({
      ports: stubPorts({ codeSecret: () => VALID_SECRET }),
    });
    const url = new URL(`${ORIGIN}/mcp/oauth/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: "c1",
      redirect_uri: "http://127.0.0.1:4321/cb",
      code_challenge: await sha256Base64Url("verifier-value-long-enough-for-pkce"),
      code_challenge_method: "S256",
      resource: RESOURCE,
    }).toString();
    const res = await router.tryHandle(new Request(url, { method: "GET" }));
    assert.ok(res);
    assert.equal(res.status, 200);
  });
});
