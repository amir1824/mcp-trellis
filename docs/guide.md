# Guide

Practical deep dive: architecture, host recipes, ports, tools, and multi-tenant
connectors. For a working minimal server, start from the [README](../README.md).
API tables and exports live in [reference.md](reference.md). Security guarantees
and threat model: [security.md](security.md).

[Architecture](#how-it-fits-together) · [Clients](#clients) · [Recipes](#recipes) ·
[Compose the primitives](#advanced-compose-the-primitives) ·
[Ports](#ports--what-you-implement) · [Tool registry](#tool-registry) ·
[Multi-tenant](#multi-tenant-saas-connectors)

## How it fits together

What `createMcpApp` wires for you — two pieces, one deciding which requests go
to the other:

![Architecture: connector → edge → OAuth or MCP → your ports](diagrams/architecture.svg)

Typical first-connection path:

![Sequence: OAuth authorize and token, then MCP tool call](diagrams/first-connection.svg)

You only touch this routing directly if you skip `createMcpApp` — see
[Advanced: compose the primitives](#advanced-compose-the-primitives).

## Clients

Name the connector clients you serve; the AS is configured to match.

| Client | Registration | Token endpoint auth | Notes |
|--------|--------------|---------------------|-------|
| `claude` | Dynamic (DCR), public + PKCE | `none` | Claude Custom Connectors callback is allowlisted for you |
| `gemini` | **Pre-registered**, confidential | `client_secret_basic`, `client_secret_post` | Gemini Enterprise is registered with your org's IdP — supply `auth.clientStore` |
| `codex` | OAuth 2.1 per MCP auth spec, public + PKCE | `none` | ChatGPT / Codex share one connector contract |

```ts
createMcpApp({
  clients: ["claude", "gemini"],
  auth: {
    // …
    clientStore: {
      get: async (clientId) => lookupClient(clientId),
      verifySecret: async (clientId, presented) =>
        checkSecret(clientId, presented),
    },
  },
});
```

Naming a pre-registered client without a `clientStore` throws at construction
rather than failing at the first token exchange. Secret storage and comparison
stay in your `clientStore` — the library never sees or persists credentials.

Naming only pre-registered clients (`clients: ["gemini"]`, no `claude` /
`codex`) sets `allowUnregisteredClients: false`: `/register` is unmounted
and dropped from AS metadata, unknown ids are rejected with
`unauthorized_client` at `authorize` and `invalid_client` at `token` and
`revoke`. Naming `claude` or `codex` alongside `gemini` reopens dynamic
registration.

## Recipes

### Cloudflare Worker, Next.js, Deno, Bun

`createMcpApp` returns a plain `fetch`, so the same object mounts everywhere:

```ts
// Worker
export default { fetch: (req: Request, env: Env) => buildApp(env).fetch(req) };

// Next.js App Router — app/[[...mcp]]/route.ts
export const GET = (req: Request) => app.fetch(req);
export const POST = (req: Request) => app.fetch(req);
export const OPTIONS = (req: Request) => app.fetch(req);

// Node / Express / Cloud Run
import { asNodeHandler } from "mcp-trellis/node";
export const mcp = asNodeHandler(app, { origin: process.env.MCP_PUBLIC_ORIGIN! });
```

The Node bridge reads the request stream when `req.body` is absent, so raw
`http.createServer` works without a body-parser. Runnable recipe:
[`examples/http-server.ts`](../examples/http-server.ts).

## Advanced: compose the primitives

Skip `createMcpApp` when you want to own the routing. Same behavior, more wiring:

```ts
import { createMcpHandler, createToolRegistry, parseBearer } from "mcp-trellis";
import { createOAuthRouter } from "mcp-trellis/oauth";

type Ctx = { userId: string };
type Env = { OAUTH_CODE_SECRET: string };

const registry = createToolRegistry<Ctx>([
  {
    name: "ping_db",
    description: "Health check",
    inputSchema: { type: "object", properties: {} },
    scope: "read",
    handler: async () => "ok",
  },
]);

const handler = createMcpHandler<Ctx>({
  registry,
  serverInfo: { name: "my-app", version: "1.0.0" },
  instructions: "Tools available to authenticated clients.",
  wwwAuthenticate: (req) => ({
    realm: "my-app",
    resourceMetadataUrl: `${new URL(req.url).origin}/.well-known/oauth-protected-resource/mcp`,
  }),
  ports: {
    authenticate: async (req) => {
      const token = parseBearer(req.headers.get("authorization"));
      if (!token) return null;
      // Reject tokens whose aud ≠ this server's canonical resource.
      return { id: "user-1", scopes: ["read"] };
    },
    context: async (_req, principal) => ({
      userId: principal?.id ?? "",
    }),
  },
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const oauth = createOAuthRouter({
      ports: {
        codeSecret: env.OAUTH_CODE_SECRET,
        resolveUser: async () => ({ id: "user-1" }),
        loginUrl: (req, next) =>
          `${new URL(req.url).origin}/login?next=${encodeURIComponent(next)}`,
        mintAccessToken: async ({ userId, resource }) => ({
          // Embed `resource` as the token audience (RFC 8707).
          accessToken: await issueUserToken(userId, { aud: resource }),
          expiresIn: 3600,
          scope: "mcp",
        }),
      },
    });

    const oauthResponse = await oauth.tryHandle(request);
    if (oauthResponse) return oauthResponse;
    if (new URL(request.url).pathname === "/mcp") return handler.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
```

### Next.js App Router

Delegate Web `Request` straight through — same handler as above:

```ts
// app/mcp/route.ts
import { handler, oauth } from "@/lib/mcp"; // your shared setup

export async function GET(req: Request) {
  const oauthResponse = await oauth.tryHandle(req);
  if (oauthResponse) return oauthResponse;
  return handler.fetch(req);
}

export async function POST(req: Request) {
  const oauthResponse = await oauth.tryHandle(req);
  if (oauthResponse) return oauthResponse;
  return handler.fetch(req);
}

export async function OPTIONS() {
  return handler.fetch(new Request("https://local/mcp", { method: "OPTIONS" }));
}
```

Also mount `.well-known/*` and `/mcp/oauth/*` the same way (or route everything through one catch-all that calls `oauth.tryHandle` first).

### Node HTTP `(req, res)`

Express, Cloud Functions, Cloud Run, `http.createServer` — bridge with
`asNodeHandler`. Runnable recipe: [`examples/http-server.ts`](../examples/http-server.ts)
(`npx tsx examples/http-server.ts`).

## Ports — what you implement

The library stays protocol-shaped. Your app plugs in the seams:

![Ports: library calls into your authenticate, context, resolveUser, mintAccessToken](diagrams/ports.svg)

### App (`createMcpApp`)

| Port | Role |
|------|------|
| `verifyToken(token, req)` | Decode a bearer and return `{ userId, scopes, audience, claims? }`, or `null`. **The library compares `audience` against this server's canonical resource** — you cannot forget the check. Optional `claims` are passed to `context` on `principal` |
| `resolveUser`, `loginUrl`, `mintAccessToken`, `codeSecret` | Same as the OAuth ports below |
| `clientStore?` | Pre-registered clients; required for confidential clients like Gemini |
| `refreshAccessToken?` | If set, metadata advertises `refresh_token` |
| `revokeToken?` | RFC 7009; presence mounts `/revoke` and advertises `revocation_endpoint` |
| `context?`, `audit?` | Same as the MCP ports below; `context` defaults to an empty object. Receives `principal.claims` when `verifyToken` set them |

### MCP (`createMcpHandler`)

The lower-level handler. Here the audience check is **yours** — prefer
`createMcpApp` unless you need the control. See [security.md](security.md).

| Port | Role |
|------|------|
| `authenticate(req, method, tool?)` | Return `{ id, scopes, claims? }`, or `null` → 401 + `WWW-Authenticate`. **Must reject tokens whose audience is not this server's canonical resource** |
| `context(req, principal)` | Build per-request ctx for tools (DB, env, …). Use `principal?.claims` for tenant / plan / role without re-decoding the bearer |
| `audit?(entry)` | Opt-in **metrics hook**: pass any function to receive tool results **and** every denial (bad token, missing scope, query-string token). `entry.method` is `""` for transport-level denials made before parsing. Throwing from this port never fails the request. Omit it and the library stays silent |

Pass any function to get per-request metrics — do what you want with them
(DB, APM, admin UI). The library never writes to stdout or a store on its
own. `consoleAudit` is only a convenience for local / small deploys;
[`examples/audit-store.ts`](../examples/audit-store.ts) shows a ring buffer and
a DB-shaped sketch:

```ts
import { createMcpApp, consoleAudit } from "mcp-trellis";

createMcpApp({ /* … */, audit: consoleAudit });

// Or your own sink:
createMcpApp({
  /* … */,
  audit: (entry) => {
    // entry: { method, tool?, principalId?, ok, error?, durationMs }
    void metrics.record(entry);
  },
});
```

Failures (denials and tool exceptions) go to `console.error` when using
`consoleAudit`; everything else to `console.log`. Entries never carry raw
exceptions or stack traces, so console output is safe. For anything beyond
stdout, write your own `audit` function — that is the intended production path.

`wwwAuthenticate` can be a static object or `(req) => …` when the PRM URL depends on origin.

By default `initialize`, `ping`, and notifications are public. Override `publicMethods` if every method must require Bearer.

### OAuth (`createOAuthRouter`)

| Port | Role |
|------|------|
| `codeSecret` | HMAC secret for signed auth codes (string or `(req) => string`) |
| `resolveUser` | Consenting user, or `null` → redirect to `loginUrl` |
| `loginUrl` | Where unauthenticated authorize requests go |
| `mintAccessToken` | Issue a **user-bound**, **audience-bound** access token (`resource` is the RFC 8707 URI) — never a shared god token |
| `refreshAccessToken?` | If set, metadata advertises `refresh_token`; also receives `resource` |
| `revokeToken?` | If set, mounts `/revoke` and advertises `revocation_endpoint`. Well-formed authenticated revoke → 200 even if the token is unknown; `invalid_request` 400 and `invalid_client` 401 still apply |
| `codeStore?` | Shared single-use jti store for multi-instance (`consume(jti, expMs)`); pruning in-memory default otherwise |
| `clientStore?` | Pre-registered clients: `get(clientId)` returns registered redirect URIs and auth method; `verifySecret(clientId, presented)` authenticates confidential clients. Credentials never enter the library |

Auth codes carry `userId`, `resource`, and the granted `scope`. Clients **must** send `resource` on authorize and token (MCP MUST) — omitting it is a **breaking** requirement vs earlier 0.1.x drafts that ignored the parameter. Advertised grants come only from the handlers you configure. AS metadata sets `resource_parameter_supported: true`.

**Scope is negotiated:** `authorize` validates the requested `scope` against `scopes` (default `["mcp"]`) and rejects anything outside it with `invalid_scope`; an omitted `scope` grants the full advertised set. The auth code carries the grant, and `mintAccessToken` receives it — so `ToolDef.scope` and `principal.scopes` sit on a chain that actually reaches the OAuth layer.

**Client authentication:** unknown `client_id`s are public (PKCE only) unless `allowUnregisteredClients` is `false` — then DCR is unmounted, dropped from metadata, and unrecognized ids are rejected (`unauthorized_client` at authorize, `invalid_client` at token and revoke). `createMcpApp` derives the flag from `clients` via `hasDynamicClient`.

## Tool registry

Schema and handler live in one place — no parallel "defs" and "handlers" lists to keep in sync:

```ts
createToolRegistry(tools, { validateArgs: false }) // default: off, easy adoption
// onToolError?: (exc) => string — default redacts to "Tool execution failed"
```

- Handler may return a `string` or `{ content, isError? }`
- Unknown tools and thrown errors become `isError: true` (not transport errors)
- Thrown exceptions are **redacted** by default (`"Tool execution failed"`); pass `onToolError` to map them. An `onToolError` that itself throws or returns a non-string falls back to the redacted default
- Duplicate tool names throw at registry construction
- Turn `validateArgs: true` once clients send schema-valid args. The evaluated
  subset is `type`, `enum`, `required`, `properties`, `items`, `minimum`,
  `maximum`. Pure metadata (`description`, `title`, `$schema`, `$id`,
  `$comment`, `default`, `examples`, `deprecated`, `readOnly`, `writeOnly`,
  `format`) is allowed and never evaluated. Any other keyword is not
  evaluated — and with `validateArgs: true` `createToolRegistry` throws at
  construction so a schema like `pattern` or `additionalProperties` cannot
  silently look enforced

### Wrapping an API as a tool

`ToolDef` stays the primitive. `defineTool` and `apiTool` are optional sugar for
the common case — turning "I have an API" into "I have an MCP tool" without
hand-rolling arg validation or fetch/error plumbing each time:

```ts
import { apiTool } from "mcp-trellis";

const getWeather = apiTool({
  name: "get_weather",
  description: "Current weather for a city",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
  // any Standard Schema v1 validator (https://standardschema.dev)
  input: citySchema,
  request: (_ctx, { city }) =>
    `https://api.example.com/weather?city=${encodeURIComponent(city)}`,
  respond: async (res) => {
    const data = await res.json();
    return `${data.tempC}°C, ${data.condition}`;
  },
});
```

- **`inputSchema` stays required** — it's what `tools/list` actually advertises to
  clients, and there's no library-agnostic way to derive JSON Schema from an
  arbitrary Standard Schema validator. Keep the two in sync.
- **`input`** (optional) parses and types `args` before your handler runs — any
  [Standard Schema](https://standardschema.dev)-compliant validator works,
  nothing library-specific. A validation failure returns `isError: true` with
  the issues and never calls your handler.
- **`apiTool`** builds on `defineTool`: give it `request` (build the outgoing
  call from typed args) and optionally `respond` (shape a 2xx response;
  default is the body as text). Non-2xx becomes `isError: true` automatically.
  `fetch` is overridable — testing, request signing, a custom agent.
- `defineTool` alone (without `request`/`respond`) is just the typed-args
  layer over a regular `ToolDef` — use it for anything, not only REST calls.

## Multi-tenant (SaaS connectors)

Resource-per-tenant already works with **zero library change**.
`canonicalResource(origin, resourcePath)` is derived per request, and the
audience check in `createMcpApp` rejects a token minted for another origin
before any tool runs. Deploy `acme.mcp.example.com` and
`globex.mcp.example.com` as separate Hosts and cross-tenant token reuse is a
protocol failure, not an application bug.

For the in-tool half, derive the tenant from the request Host (or from the
verified audience after the library check) in your `context` port — that is
the isolation key. Optional `claims` from `verifyToken` (plan, role, …) are
handy metadata on `principal`; they are **not** Host→tenant authorization.
A forged `claims.tenant_id` with a matching audience must not change which
tenant's data a tool can see.

**Host caveat (API requirement).** On Node, multi-tenant needs a Host-derived
origin (`trustProxy: true` without a fixed `origin`). That path **requires**
a non-empty `allowedOrigins` at `asNodeHandler` construction — omit it and
construction throws. Use exact origins and/or `*.example.com` wildcards for
**https** subdomains; the **resolved** origin must match or the request
returns **400** before any OAuth or MCP handling. Loud opt-out:
`allowedOrigins: ["*"]` (admits any Host — only behind a proxy you trust to
strip client `X-Forwarded-*`). A fixed `origin` absent from a non-empty list
fails at construction; with a fixed `origin` the allowlist is optional
defense-in-depth. Absolute-form request targets are rebased onto that
validated origin, so a spoofed URL line cannot override it. A fixed `origin`
is otherwise safe but collapses every tenant onto one resource, so it cannot
do subdomain-per-tenant.

On Cloudflare Workers (or any wildcard route), apply the equivalent
allowlist check on `new URL(req.url).origin` before calling `app.fetch`
(`isAllowedOrigin` from `mcp-trellis/node`, or the same module the Worker
example imports).

Typechecked sketch: [`examples/multi-tenant.ts`](../examples/multi-tenant.ts)
(needs a Host matching `*.mcp.example.com` — loopback alone is rejected).
Shared `codeStore` / revocation shapes: [`examples/stores.ts`](../examples/stores.ts)
(atomic `setIfAbsent` for auth codes; Workers KV alone is not enough).
`audit` metrics sink (ring + DB sketch): [`examples/audit-store.ts`](../examples/audit-store.ts).
Worker mount: [`examples/cloudflare-worker.ts`](../examples/cloudflare-worker.ts)
(typecheck-only in CI — no wrangler).
