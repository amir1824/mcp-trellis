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

describe("codeSecret validation — string form (construction-time)", () => {
  it("throws for a secret under 32 characters, naming the length and the fix", () => {
    assert.throws(
      () => createOAuthRouter({ ports: stubPorts({ codeSecret: "too-short" }) }),
      /at least 32 characters.*openssl rand -base64 32/s,
    );
  });

  it("rejects short published placeholders on the length rule", () => {
    for (const literal of ["e2e-code-secret-value", "change-me", "test-secret-value"]) {
      assert.throws(
        () => createOAuthRouter({ ports: stubPorts({ codeSecret: literal }) }),
        /at least 32 characters/,
        `expected construction to reject the literal ${JSON.stringify(literal)}`,
      );
    }
  });

  it("rejects any secret carrying the do-not-reuse example marker", () => {
    for (const literal of [
      "example-http-server-code-secret-do-not-reuse",
      "example-multi-tenant-code-secret-do-not-reuse",
      "example-express-code-secret-do-not-reuse!!!!!!",
      "example-nextjs-route-code-secret-do-not-reuse!!",
      "my-edited-copy-of-an-example-secret-do-not-reuse-123",
    ]) {
      assert.throws(
        () => createOAuthRouter({ ports: stubPorts({ codeSecret: literal }) }),
        /published in this package's own docs or examples/,
        `expected construction to reject the literal ${JSON.stringify(literal)}`,
      );
    }
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
    for (const file of files) {
      for (const [, literal] of readFileSync(join(root, file), "utf8").matchAll(LITERAL)) {
        assert.throws(
          () => createOAuthRouter({ ports: stubPorts({ codeSecret: literal ?? "" }) }),
          /published in this package's own docs or examples|at least 32 characters/,
          `${file} publishes codeSecret ${JSON.stringify(literal)} that the library accepts`,
        );
      }
    }
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
