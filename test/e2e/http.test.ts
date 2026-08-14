import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sha256Base64Url } from "../../src/oauth/pkce.js";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const serverPath = fileURLToPath(
  new URL("../../examples/http-server.ts", import.meta.url),
);
const READY = /listening (http:\/\/127\.0\.0\.1:\d+)/;
const START_MS = 15_000;
const noFollow = { redirect: "manual" as const };
const CLIENT_ID = "e2e-client";
const REDIRECT = "http://127.0.0.1:4000/cb";
const VERIFIER = "pkce-verifier-value-that-is-long-enough";
const ECHO = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "echo", arguments: { text: "hello" } },
};

const spawnServer = (): Promise<{ origin: string; child: ChildProcess }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, serverPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: "0" },
    });

    let buf = "";
    let settled = false;
    const fail = (reason: string): void => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(reason));
    };

    const timer = setTimeout(
      () => fail(`e2e server did not start within ${START_MS}ms: ${buf}`),
      START_MS,
    );

    const onChunk = (chunk: Buffer): void => {
      buf += chunk.toString();
      const match = buf.match(READY);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ origin: match[1], child });
    };

    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("error", (err) => {
      clearTimeout(timer);
      fail(err.message);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      fail(`e2e server exited ${code}: ${buf}`);
    });
  });

const assertDiscovery = async (origin: string): Promise<void> => {
  const as = await fetch(
    `${origin}/.well-known/oauth-authorization-server`,
    noFollow,
  );
  assert.equal(as.status, 200);
  const asMeta = (await as.json()) as {
    authorization_endpoint: string;
    revocation_endpoint: string;
  };
  assert.equal(asMeta.authorization_endpoint, `${origin}/mcp/oauth/authorize`);
  assert.equal(asMeta.revocation_endpoint, `${origin}/mcp/oauth/revoke`);
  const prm = await fetch(
    `${origin}/.well-known/oauth-protected-resource/mcp`,
    noFollow,
  );
  assert.equal(prm.status, 200);
  assert.equal(
    ((await prm.json()) as { resource: string }).resource,
    `${origin}/mcp`,
  );
};

const authorizeCode = async (origin: string): Promise<string> => {
  const authorize = new URL(`${origin}/mcp/oauth/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_challenge: await sha256Base64Url(VERIFIER),
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
  }).toString();
  const authorized = await fetch(authorize, noFollow);
  assert.equal(authorized.status, 302);
  const location = authorized.headers.get("location");
  assert.ok(location);
  const code = new URL(location).searchParams.get("code");
  assert.ok(code);
  return code;
};

const exchangeToken = async (origin: string, code: string): Promise<string> => {
  const tokenRes = await fetch(`${origin}/mcp/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      resource: `${origin}/mcp`,
    }).toString(),
    ...noFollow,
  });
  assert.equal(tokenRes.status, 200);
  const minted = (await tokenRes.json()) as { access_token: string };
  assert.ok(minted.access_token);
  return minted.access_token;
};

const mintViaPkce = async (origin: string): Promise<string> =>
  exchangeToken(origin, await authorizeCode(origin));

const callEcho = (origin: string, token: string): Promise<Response> =>
  fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(ECHO),
    ...noFollow,
  });

const callEchoUnauthed = (origin: string): Promise<Response> =>
  fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ECHO),
    ...noFollow,
  });

const revokeAccess = (origin: string, token: string): Promise<Response> =>
  fetch(`${origin}/mcp/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, client_id: CLIENT_ID }).toString(),
    ...noFollow,
  });

describe("real-socket connector walk", () => {
  let origin = "";
  let child: ChildProcess | undefined;

  before(async () => {
    const started = await spawnServer();
    origin = started.origin;
    child = started.child;
  });

  after(() => {
    child?.kill("SIGTERM");
  });

  it("completes metadata → authorize → token → tools/call → revoke over TCP", async () => {
    await assertDiscovery(origin);
    const token = await mintViaPkce(origin);
    const called = await callEcho(origin, token);
    assert.equal(called.status, 200);
    const body = (await called.json()) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    assert.equal(body.result.isError, false);
    assert.equal(body.result.content[0]?.text, "hello");
    const revoked = await revokeAccess(origin, token);
    assert.equal(revoked.status, 200);
    assert.equal(await revoked.text(), "");
    assert.equal((await callEcho(origin, token)).status, 401);
    const denied = await callEchoUnauthed(origin);
    assert.equal(denied.status, 401);
    assert.ok(
      denied.headers.get("www-authenticate")?.includes("resource_metadata="),
    );
  });
});
