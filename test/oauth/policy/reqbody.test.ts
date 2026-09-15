import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readOAuthBody } from "../../../src/oauth/policy/reqbody.js";

const jsonRequest = (body: unknown): Request =>
  new Request("https://example.test/mcp/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const formRequest = (body: string): Request =>
  new Request("https://example.test/mcp/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

describe("readOAuthBody — JSON", () => {
  it("parses a well-formed JSON body", async () => {
    const body = await readOAuthBody(jsonRequest({ grant_type: "authorization_code", code: "c1" }));
    assert.deepEqual(body, { grant_type: "authorization_code", code: "c1" });
  });

  it("coerces a number/boolean field to its string form", async () => {
    const body = await readOAuthBody(jsonRequest({ n: 1, b: true }));
    assert.deepEqual(body, { n: "1", b: "true" });
  });

  it("drops a null/undefined field entirely rather than stringifying it", async () => {
    const body = await readOAuthBody(jsonRequest({ a: "x", b: null }));
    assert.deepEqual(body, { a: "x" });
  });

  it("rejects an object-valued field instead of silently stringifying to [object Object]", async () => {
    await assert.rejects(readOAuthBody(jsonRequest({ grant_type: {} })), /must be a scalar value/);
  });

  it("rejects an array-valued field the same way", async () => {
    await assert.rejects(
      readOAuthBody(jsonRequest({ scope: ["a", "b"] })),
      /must be a scalar value/,
    );
  });

  it("rejects a top-level array body", async () => {
    await assert.rejects(readOAuthBody(jsonRequest(["a", "b"])), /malformed request body/);
  });

  it("rejects malformed JSON", async () => {
    const req = new Request("https://example.test/mcp/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    await assert.rejects(readOAuthBody(req));
  });
});

describe("readOAuthBody — form", () => {
  it("parses a well-formed form body", async () => {
    const body = await readOAuthBody(formRequest("grant_type=authorization_code&code=c1"));
    assert.deepEqual(body, { grant_type: "authorization_code", code: "c1" });
  });

  it("rejects a duplicate parameter instead of silently keeping the last one", async () => {
    await assert.rejects(
      readOAuthBody(formRequest("grant_type=authorization_code&grant_type=refresh_token")),
      /duplicate "grant_type"/,
    );
  });

  it("accepts distinct keys that merely share a prefix", async () => {
    const body = await readOAuthBody(formRequest("code=c1&code_verifier=v1"));
    assert.deepEqual(body, { code: "c1", code_verifier: "v1" });
  });
});
