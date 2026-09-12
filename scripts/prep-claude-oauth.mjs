#!/usr/bin/env node
/** Walk login → DCR → consent → PKCE → list_my_projects against a live demo origin. */
import { createHash, randomBytes } from "node:crypto";

const origin = process.env.PUBLIC_ORIGIN?.replace(/\/$/, "");
const password = process.env.DEMO_PASSWORD;
if (!origin || !password) {
  console.error("Set PUBLIC_ORIGIN and DEMO_PASSWORD");
  process.exit(1);
}

const callback = "http://127.0.0.1:4000/cb";
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const resource = `${origin}/mcp`;

const jar = { cookie: "" };
const remember = (res) => {
  const raw = res.headers.getSetCookie?.() ?? [];
  const first = raw[0] ?? res.headers.get("set-cookie");
  if (first) jar.cookie = first.split(";")[0];
  return res;
};

const registered = await fetch(`${origin}/mcp/oauth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ redirect_uris: [callback] }),
}).then((r) => r.json());

const auth = new URL(`${origin}/mcp/oauth/authorize`);
auth.search = new URLSearchParams({
  response_type: "code",
  client_id: registered.client_id,
  redirect_uri: callback,
  resource,
  code_challenge_method: "S256",
  code_challenge: challenge,
  state: "prep",
}).toString();

remember(
  await fetch(`${origin}/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: origin,
    },
    body: new URLSearchParams({ user: "alice", password }),
    redirect: "manual",
  }),
);

const consentHtml = await fetch(auth, { headers: { Cookie: jar.cookie } }).then(async (r) => {
  remember(r);
  return r.text();
});
const ticket = consentHtml.match(/name="consent_ticket"\s+value="([^"]+)"/)?.[1];
if (!ticket) {
  console.error("Consent page missing ticket — open login in a browser first.");
  process.exit(1);
}

const approved = remember(
  await fetch(`${origin}/mcp/oauth/consent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: origin,
      Cookie: jar.cookie,
    },
    body: new URLSearchParams({ consent_ticket: ticket, approved: "true" }),
    redirect: "manual",
  }),
);
const code = new URL(approved.headers.get("location")).searchParams.get("code");
const token = await fetch(`${origin}/mcp/oauth/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: registered.client_id,
    redirect_uri: callback,
    resource,
    code_verifier: verifier,
  }),
}).then((r) => r.json());

const tool = await fetch(resource, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token.access_token}`,
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "list_my_projects", arguments: {} },
  }),
}).then((r) => r.json());

const text = tool.result?.content?.[0]?.text ?? JSON.stringify(tool, null, 2);
console.log("OAuth + tool OK for alice");
console.log(text);

if (!token.refresh_token) {
  console.error("Expected refresh_token from demo mint");
  process.exit(1);
}

const escalate = await fetch(`${origin}/mcp/oauth/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
    client_id: registered.client_id,
    resource,
    scope: "admin",
  }),
}).then((r) => r.json());
if (escalate.error !== "invalid_grant") {
  console.error("Expected refresh scope escalation to fail:", escalate);
  process.exit(1);
}

const refreshed = await fetch(`${origin}/mcp/oauth/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: token.refresh_token,
    client_id: registered.client_id,
    resource,
    scope: "mcp",
  }),
}).then((r) => r.json());
if (!refreshed.access_token || refreshed.scope !== "mcp") {
  console.error("Refresh with reduced/same scope failed:", refreshed);
  process.exit(1);
}

const tool2 = await fetch(resource, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${refreshed.access_token}`,
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "list_my_projects", arguments: {} },
  }),
}).then((r) => r.json());
if (!tool2.result?.content?.[0]?.text) {
  console.error("Tool call after refresh failed:", tool2);
  process.exit(1);
}

console.log("Refresh scope subset + tool OK");
console.log(`\nMCP URL for Claude: ${resource}`);
