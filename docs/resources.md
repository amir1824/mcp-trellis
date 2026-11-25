# Resources: serve application data to the model

A resource is a piece of read-only data with a fixed URI that a client lists and reads, such as a handbook, a policy or a per-tenant summary. Use one when the model should be able to read something without a tool call that does work. Use a tool for anything that changes state or takes arguments. mcp-trellis serves a resource only to an authenticated principal who is allowed to see it, and it reuses the same `authenticate`, `context` and `audit` ports as tools.

Resources are opt-in. An integration that registers none behaves exactly as before.

## Setup

```ts
import { createMcpApp, type ResourceDef } from "mcp-trellis";

type Ctx = { tenantId: string };

const handbook: ResourceDef<Ctx> = {
  uri: "docs://handbook",
  name: "Employee handbook",
  mimeType: "text/markdown",
  scope: "mcp",
  read: () => "# Handbook\n…",
};

const summary: ResourceDef<Ctx> = {
  uri: "docs://tenant/summary",
  name: "Tenant summary",
  scope: "mcp",
  allow: (principal) => principal.id !== "guest", // sync, no I/O
  read: async (ctx) => ({ text: await loadSummary(ctx.tenantId) }), // ctx is built per read
};

createMcpApp<Ctx>({
  // ...serverInfo, auth, context
  tools: [],
  resources: [handbook, summary],
});
```

`createMcpHandler` takes the same `resources` option.

## A resource

| Field | Meaning |
|-------|---------|
| `uri` | Fixed, unique, ASCII, at most 512 characters, with a lowercase scheme (`docs://handbook`). `ui://` is reserved for MCP Apps documents (see [mcp-apps.md](mcp-apps.md)). |
| `name`, `description` | What `resources/list` shows. |
| `mimeType` | Shown by `resources/list`; default `text/plain`. `text/html;profile=mcp-app` is reserved for MCP Apps documents. |
| `scope` | Same meaning as a tool's `scope`: the principal needs it; `null` or omitted means any authenticated principal. |
| `allow(principal)` | Optional synchronous rule on top of `scope`, for a claim or tenant rule that must hold for listing and reading. It must be pure: no I/O, and it must not change the principal it is given. If it throws or does not return exactly `true`, the answer is "denied". |
| `read(ctx)` | Returns a string or `{ text, mimeType? }`. Text only. |

A bad or duplicate URI, a reserved URI or MIME type, or a missing function throws once, at construction, with every problem listed.

## Who sees what

| Case | Answer |
|------|--------|
| No principal | 401, even if `resources/list` or `resources/read` is in `publicMethods` |
| `resources/list` | Only the resources the principal may read; it never answers 403 |
| Read without the scope | 403 `insufficient_scope` naming the scope |
| Read without the scope, `hideToolsOutsideScope: true` or `"strict"` | The same answer as an unknown URI (`-32602`, `Unknown resource: <uri>`), byte for byte |
| Read refused by `allow` | Always the unknown-URI answer: there is no scope to ask for |
| Unknown URI, or a `uri` that is not a string | `-32602` |
| `read` throws, or returns something that is not a string or `{ text }` | `-32603 Resource read failed`; the exception text goes to neither the caller nor the audit entry |

Every list and read is audited with `method`, `resource` (the URI, clipped to 200 characters), `principalId`, `ok`, `error` and `durationMs`. The denial reasons are `missing_scope`, `unknown_resource`, `invalid_params`, `unauthorized` and, new with resources, `resource_failed`. A host that switches on the audit `error` value should handle `resource_failed`.

## Context and tenants

`context` is built for a read only after the principal passed the scope and `allow` checks, and only for a general resource: never for a listing, an anonymous call, a denied or unknown read, or a `ui://` document. Derive the tenant from `context`, never from the URI.

Trellis keeps nothing between calls: no cache, no memo, nothing keyed by principal. The response is `Cache-Control: no-store`, and for a 2026-07-28 request `resources/list` and `resources/read` carry `ttlMs: 0` and `cacheScope: "private"`. A `read` that returns another tenant's data is a bug in your data layer that the library cannot detect; see [security.md](security.md) for the boundary.

## What is not included

- No templates: `resources/templates/list` answers `-32601`. Per-entity URIs such as `invoice://123` are not served; register fixed URIs, or return the data from a tool. Templates can be added later without a breaking change.
- No `resources/subscribe`, no `notifications/resources/list_changed`, no `completion/complete` (all `-32601`) and no pagination.
- No binary bodies (`blob`): text only.
- No timeout and no size cap on `read`, the same as tools. A slow provider holds the request, and the duration is audited. Set your own limits inside `read`.
- A `read` should have no side effects: a client may repeat it, and each attempt is audited.
- The `resources` capability says that the server has resources, never which ones.

## Migration and rollback

No change is required for an existing integration. To roll back, remove the `resources` option or revert the release: nothing is stored.
