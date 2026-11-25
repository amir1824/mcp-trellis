# Resources: serve read-only data to the model

A resource is read-only data with a fixed URI that a client lists and reads: a handbook, a policy, a per-tenant summary. Use a resource when the model only needs to read something. Use a tool when a call takes arguments or changes state.

Resources are opt-in. A server that registers none behaves as before. They use the same `authenticate`, `context` and `audit` ports as tools.

## Setup

```ts
import { createMcpApp, signedTokenAuth, type ResourceDef } from "mcp-trellis";

type Ctx = { tenantId: string };

const TENANTS: Record<string, string> = { alice: "acme", bob: "globex" };

const handbook: ResourceDef<Ctx> = {
  uri: "docs://handbook",
  name: "Employee handbook",
  mimeType: "text/markdown",
  scope: "mcp",
  read: () => "# Handbook\nBe kind.",
};

const summary: ResourceDef<Ctx> = {
  uri: "docs://tenant/summary",
  name: "Tenant summary",
  scope: "mcp",
  allow: (principal) => principal.id !== "guest", // synchronous, no I/O
  read: (ctx) => ({ text: `Summary for ${ctx.tenantId}` }), // ctx is built per read
};

const auth = signedTokenAuth({
  secret: process.env.OAUTH_CODE_SECRET as string, // 32+ characters
  resolveUser: async () => ({ id: "alice" }), // placeholder: use your session lookup
  loginUrl: (_req, next) => `/login?next=${encodeURIComponent(next)}`,
});

export const app = createMcpApp<Ctx>({
  serverInfo: { name: "docs-server", version: "1.0.0" },
  auth,
  allowInMemoryCodeStore: true, // single process only; pass a shared codeStore in production
  context: (_req, principal) => ({ tenantId: TENANTS[principal?.id ?? ""] ?? "none" }),
  tools: [],
  resources: [handbook, summary],
});
```

`createMcpHandler` takes the same `resources` option. A runnable version is `examples/resources-app.ts`.

## A resource

| Field | Meaning |
|-------|---------|
| `uri` | Fixed and unique. ASCII, at most 512 characters, lowercase scheme (`docs://handbook`). `ui://` belongs to [MCP Apps](mcp-apps.md) and `skill://` to [skills](skills.md). |
| `name`, `description` | Shown by `resources/list`. `name` is required. |
| `mimeType` | Shown by `resources/list`. Default `text/plain`. `text/html;profile=mcp-app` is reserved for MCP Apps. |
| `scope` | Same as a tool's `scope`. `null`, `""` or omitted means any authenticated principal. |
| `allow(principal)` | Optional synchronous rule on top of `scope`, for a claim or tenant rule. It must be pure. Only a return value of exactly `true` allows; a throw, a promise or anything else denies. |
| `read(ctx)` | Returns a string or `{ text, mimeType? }`. Text only. |

A bad or duplicate URI, a reserved URI or MIME type, or a missing function throws at construction, with every problem listed.

## Who sees what

| Case | Answer |
|------|--------|
| No principal | 401, even if `resources/list` or `resources/read` is in `publicMethods` |
| `resources/list` | Only the resources the principal may read. Never 403 |
| Read without the scope | 403 `insufficient_scope` naming the scope |
| Same, with `hideToolsOutsideScope: true` or `"strict"` | The unknown-URI answer (`-32602`, `Unknown resource: <uri>`) |
| Read refused by `allow` | Always the unknown-URI answer |
| Unknown URI, or `uri` not a string | `-32602` |
| `read` throws or returns a bad shape | `-32603 Resource read failed`. The exception text goes to neither the caller nor the audit entry |

Every list and read is audited with `method`, `resource` (the URI, clipped to 200 characters), `principalId`, `ok`, `error` and `durationMs`. The `error` values are `unauthorized`, `invalid_params`, `unknown_resource`, `missing_scope`, `rule_denied` (`allow` returned something other than `true`), `rule_failed` (`allow` threw) and `resource_failed` (`read` threw or returned a bad shape). The caller sees the unknown-resource answer for `rule_denied` and `rule_failed`.

## Context and tenants

`context` is built for a read only after the scope and `allow` checks pass. It is not built for a list, an anonymous call, a denied or unknown read, or a `ui://` document. Derive the tenant from `context`, never from the URI.

The library keeps nothing between calls: no cache, nothing keyed by principal. Responses are `Cache-Control: no-store`. On a 2026-07-28 request, `resources/list` and `resources/read` carry `ttlMs: 0` and `cacheScope: "private"`. A `read` that returns another tenant's data is a bug in your data layer; see [security.md](security.md#tenant-isolation-what-trellis-does-and-what-the-application-does).

## What is not included

- Templates (`resources/templates/list`), `resources/subscribe`, `notifications/resources/list_changed`, `completion/complete` and pagination: all answer `-32601` or do not exist. For per-entity data such as `invoice://123`, register fixed URIs or use a tool.
- Binary bodies (`blob`). Text only.
- A timeout or size cap on `read`, as with tools. Set your own limits inside `read`.
- Side effects in `read`: a client may repeat it, and each call is audited.

The `resources` capability says the server has resources, never which ones.

## Migration and rollback

No change is required for an existing integration. To roll back, remove the `resources` option. Nothing is stored.
