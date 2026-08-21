import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import { createRequire } from "node:module";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { sha256Base64Url } from "../../src/oauth/pkce.js";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const serverPath = fileURLToPath(new URL("../../examples/http-server.ts", import.meta.url));
const READY = /listening (http:\/\/127\.0\.0\.1:\d+)/;
const START_MS = 15_000;
const noFollow = { redirect: "manual" as const };
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
      const origin = match?.[1];
      if (!origin || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ origin, child });
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
  const as = await fetch(`${origin}/.well-known/oauth-authorization-server`, noFollow);
  assert.equal(as.status, 200);
  const asMeta = (await as.json()) as {
    authorization_endpoint: string;
    revocation_endpoint: string;
  };
  assert.equal(asMeta.authorization_endpoint, `${origin}/mcp/oauth/authorize`);
  assert.equal(asMeta.revocation_endpoint, `${origin}/mcp/oauth/revoke`);
  const prm = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`, noFollow);
  assert.equal(prm.status, 200);
  assert.equal(((await prm.json()) as { resource: string }).resource, `${origin}/mcp`);
};

const authorizeCode = async (origin: string): Promise<{ code: string; clientId: string }> => {
  const registered = await fetch(`${origin}/mcp/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT] }),
    ...noFollow,
  });
  assert.equal(registered.status, 200);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  assert.ok(clientId);

  const authorize = new URL(`${origin}/mcp/oauth/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: await sha256Base64Url(VERIFIER),
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
  }).toString();
  const authorized = await fetch(authorize, noFollow);
  assert.equal(authorized.status, 200, "authorize must render the consent interstitial");
  const html = await authorized.text();
  const ticketMatch = html.match(/name="consent_ticket"\s+value="([^"]+)"/);
  assert.ok(ticketMatch?.[1], "consent page must carry a well-formed consent_ticket");

  const approved = await fetch(`${origin}/mcp/oauth/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      consent_ticket: ticketMatch[1],
      approved: "true",
    }).toString(),
    ...noFollow,
  });
  assert.equal(approved.status, 302);
  const location = approved.headers.get("location");
  assert.ok(location);
  const code = new URL(location).searchParams.get("code");
  assert.ok(code);
  return { code, clientId };
};

const exchangeToken = async (origin: string, code: string, clientId: string): Promise<string> => {
  const tokenRes = await fetch(`${origin}/mcp/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
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

const mintViaPkce = async (origin: string): Promise<{ token: string; clientId: string }> => {
  const { code, clientId } = await authorizeCode(origin);
  return { token: await exchangeToken(origin, code, clientId), clientId };
};

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

const revokeAccess = (origin: string, token: string, clientId: string): Promise<Response> =>
  fetch(`${origin}/mcp/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, client_id: clientId }).toString(),
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
    const { token, clientId } = await mintViaPkce(origin);
    const called = await callEcho(origin, token);
    assert.equal(called.status, 200);
    const body = (await called.json()) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    assert.equal(body.result.isError, false);
    assert.equal(body.result.content[0]?.text, "hello");
    const revoked = await revokeAccess(origin, token, clientId);
    assert.equal(revoked.status, 200);
    assert.equal(await revoked.text(), "");
    assert.equal((await callEcho(origin, token)).status, 401);
    const denied = await callEchoUnauthed(origin);
    assert.equal(denied.status, 401);
    assert.ok(denied.headers.get("www-authenticate")?.includes("resource_metadata="));
  });

  it("rejects an oversized Content-Length on /mcp with 413 without writing a body", async () => {
    const { status } = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: Number(new URL(origin).port),
          path: "/mcp",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(2 * 1024 * 1024),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      // Do not write a body — exercises early Content-Length reject only.
      req.end();
    });
    assert.equal(status, 413);
  });
});
