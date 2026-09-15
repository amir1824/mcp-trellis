import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { createDemo } from "../../examples/saas-demo/app.js";

const origin = "http://127.0.0.1:8787";
const password = "local-test-password-only";
const callback = "http://127.0.0.1:4000/cb";
const verifier = "a-valid-pkce-verifier-with-more-than-forty-three-characters";
const required = <T>(value: T | null | undefined): T => {
  assert.ok(value != null);
  return value;
};
const makeApp = () =>
  createDemo({ origin, password, codeSecret: "local-test-secret-with-at-least-32-characters" });
const formRequest = (path: string, data: Record<string, string>, cookie = "") =>
  new Request(`${origin}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: origin,
      Cookie: cookie,
    },
    body: new URLSearchParams(data),
  });

it("existing login → consent + PKCE → tool uses only token owner's projects", async () => {
  const app = makeApp();
  const registered = await app.fetch(
    new Request(`${origin}/mcp/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [callback] }),
    }),
  );
  assert.equal(registered.status, 201);
  const { client_id } = (await registered.json()) as { client_id: string };
  for (const user of ["alice", "bob"]) {
    const auth = new URL(`${origin}/mcp/oauth/authorize`);
    auth.search = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: callback,
      resource: `${origin}/mcp`,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      state: `state-${user}`,
    }).toString();
    const anonymous = await app.fetch(new Request(auth));
    assert.equal(anonymous.status, 302);
    assert.match(required(anonymous.headers.get("location")), /\/login\?/);
    const loggedIn = await app.fetch(formRequest("/login", { user, password }));
    assert.equal(loggedIn.status, 303);
    const cookie = required(required(loggedIn.headers.get("set-cookie")).split(";")[0]);
    const page = await app.fetch(new Request(`${origin}/`, { headers: { Cookie: cookie } }));
    assert.match(await page.text(), new RegExp(`${user}'s projects`));
    const consent = await app.fetch(new Request(auth, { headers: { Cookie: cookie } }));
    assert.equal(consent.status, 200);
    const ticket = (await consent.text()).match(/name="consent_ticket"\s+value="([^"]+)"/)?.[1];
    assert.ok(ticket);
    const approved = await app.fetch(
      formRequest("/mcp/oauth/consent", { consent_ticket: ticket, approved: "true" }, cookie),
    );
    assert.equal(approved.status, 302);
    const redirect = new URL(required(approved.headers.get("location")));
    assert.equal(redirect.searchParams.get("state"), `state-${user}`);
    const code = required(redirect.searchParams.get("code"));
    const exchange = await app.fetch(
      formRequest("/mcp/oauth/token", {
        grant_type: "authorization_code",
        code,
        client_id,
        redirect_uri: callback,
        resource: `${origin}/mcp`,
        code_verifier: verifier,
      }),
    );
    assert.equal(exchange.status, 200);
    const { access_token } = (await exchange.json()) as { access_token: string };
    const call = (token: string) =>
      app.fetch(
        new Request(`${origin}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "list_my_projects", arguments: {} },
          }),
        }),
      );
    const response = await call(access_token);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { result: { content: { text: string }[] } };
    const records = JSON.parse(required(body.result.content[0]).text) as { owner: string }[];
    assert.equal(records.length, user === "alice" ? 2 : 1);
    assert.ok(records.every((p) => p.owner === user));
    assert.equal((await call(`${access_token}tampered`)).status, 401);
    assert.equal((await call("unknown")).status, 401);
  }
});

it("refresh keeps original grant and rejects scope escalation", async () => {
  const app = makeApp();
  const registered = await app.fetch(
    new Request(`${origin}/mcp/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [callback] }),
    }),
  );
  const { client_id } = (await registered.json()) as { client_id: string };
  const auth = new URL(`${origin}/mcp/oauth/authorize`);
  auth.search = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: callback,
    resource: `${origin}/mcp`,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: "refresh-scope",
  }).toString();
  const loggedIn = await app.fetch(formRequest("/login", { user: "alice", password }));
  const cookie = required(required(loggedIn.headers.get("set-cookie")).split(";")[0]);
  const consent = await app.fetch(new Request(auth, { headers: { Cookie: cookie } }));
  const ticket = (await consent.text()).match(/name="consent_ticket"\s+value="([^"]+)"/)?.[1];
  assert.ok(ticket);
  const approved = await app.fetch(
    formRequest("/mcp/oauth/consent", { consent_ticket: ticket, approved: "true" }, cookie),
  );
  const code = required(
    new URL(required(approved.headers.get("location"))).searchParams.get("code"),
  );
  const exchange = await app.fetch(
    formRequest("/mcp/oauth/token", {
      grant_type: "authorization_code",
      code,
      client_id,
      redirect_uri: callback,
      resource: `${origin}/mcp`,
      code_verifier: verifier,
    }),
  );
  assert.equal(exchange.status, 200);
  const minted = (await exchange.json()) as {
    access_token: string;
    refresh_token: string;
    scope: string;
  };
  assert.equal(minted.scope, "mcp");
  assert.ok(minted.refresh_token);

  const escalate = await app.fetch(
    formRequest("/mcp/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: minted.refresh_token,
      client_id,
      resource: `${origin}/mcp`,
      scope: "admin",
    }),
  );
  assert.equal(escalate.status, 400);
  assert.equal(((await escalate.json()) as { error: string }).error, "invalid_grant");

  const narrowed = await app.fetch(
    formRequest("/mcp/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: minted.refresh_token,
      client_id,
      resource: `${origin}/mcp`,
      scope: "mcp",
    }),
  );
  assert.equal(narrowed.status, 200);
  const refreshed = (await narrowed.json()) as {
    access_token: string;
    refresh_token: string;
    scope: string;
  };
  assert.equal(refreshed.scope, "mcp");
  assert.notEqual(refreshed.access_token, minted.access_token);

  const replay = await app.fetch(
    formRequest("/mcp/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: minted.refresh_token,
      client_id,
      resource: `${origin}/mcp`,
    }),
  );
  assert.equal(replay.status, 400);

  const tool = await app.fetch(
    new Request(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${refreshed.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_my_projects", arguments: {} },
      }),
    }),
  );
  assert.equal(tool.status, 200);
});

it("login rejects wrong password and foreign origin; return URL stays local", async () => {
  const app = makeApp();
  assert.equal(
    (await app.fetch(formRequest("/login", { user: "alice", password: "wrong" }))).status,
    401,
  );
  const foreign = formRequest("/login", { user: "alice", password });
  foreign.headers.set("Origin", "https://attacker.example");
  assert.equal((await app.fetch(foreign)).status, 403);
  const result = await app.fetch(
    formRequest("/login?next=https://attacker.example", { user: "alice", password }),
  );
  assert.equal(result.headers.get("location"), "/");
  assert.match(required(result.headers.get("set-cookie")), /HttpOnly; SameSite=Lax/);
});
