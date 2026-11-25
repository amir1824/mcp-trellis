# Skills: serve instructions to the model (experimental)

A skill is a folder of text that tells a model how to do a job: a `SKILL.md` plus supporting files. mcp-trellis serves skills through the Skills extension (`io.modelcontextprotocol/skills`). A skill is served text and nothing more. The library never runs it, never calls a tool because of it, and it never changes what a caller may do.

## Status

**Experimental and opt-in.** The `skills` option is `@experimental` and may change in a minor release. A server that registers no skill has no `skills/*` method and no extension in its capabilities.

The code follows `specification/beta/skills.mdx` of `modelcontextprotocol/ext-skills` (SEP-2640, commit `c0705f9071caa539eeb2c9f5f2f77ac16b048ca6`) and the [Agent Skills specification](https://agentskills.io/specification). It works on 2026-07-28 requests and on the older protocol versions.

## Setup

```ts
import { createMcpApp, signedTokenAuth, type SkillDef } from "mcp-trellis";

const refunds: SkillDef = {
  name: "refunds",
  description: "Process customer refund requests per company policy",
  instructions: "# Refunds\n\nRead references/policy.md first.\n",
  scope: "mcp",
  allow: (principal) => principal.id === "alice", // synchronous, no I/O
  files: [{ path: "references/policy.md", text: "Refunds within 30 days." }],
};

const auth = signedTokenAuth({
  secret: process.env.OAUTH_CODE_SECRET as string, // 32+ characters
  resolveUser: async () => ({ id: "alice" }), // placeholder: use your session lookup
  loginUrl: (_req, next) => `/login?next=${encodeURIComponent(next)}`,
});

export const app = createMcpApp({
  serverInfo: { name: "skills-server", version: "1.0.0" },
  auth,
  allowInMemoryCodeStore: true, // single process only; pass a shared codeStore in production
  tools: [],
  skills: [refunds],
});
```

`createMcpHandler` takes the same `skills` option. With more than one scope, every skill needs an explicit `scope` (or `null`), as a tool does.

| Field | Meaning |
|-------|---------|
| `name` | 1 to 64 characters: lowercase letters, digits and single hyphens, none at either end. Unique. The URI is `skill://<name>/SKILL.md`. |
| `description` | 1 to 1024 characters, no control characters. |
| `instructions` | The body of `SKILL.md`. |
| `metadata` | Optional string map. Keys `allowed-tools` and `io.modelcontextprotocol/...` are refused. |
| `files` | `{ path, text, mimeType? }`, served at `skill://<name>/<path>`. Text only. `mimeType` defaults to `text/markdown` for `.md`, else `text/plain`. |
| `scope`, `allow` | As on a [resource](resources.md#a-resource), for the whole skill. |

The library writes `SKILL.md` itself: `name`, `description` and `metadata` as one `key: <JSON value>` line each between `---` lines, a blank line, then `instructions`.

Construction throws once, listing every problem, for: a bad or repeated name; a bad description or metadata; a file path that is not relative segments of `A-Z a-z 0-9 _ . -` (none starting with `.` or `-`), is over 200 characters, repeats another path in any case, or is `SKILL.md`; more than 512 files or 16 MiB in one skill; a `skill://` URI in `resources`. Nothing partial is served.

## What a client gets

| Method | Answer |
|--------|--------|
| `initialize`, `server/discover` | `extensions["io.modelcontextprotocol/skills"]: {}` next to `resources: {}`, only when a skill exists |
| `skills/list` | `{ skills }`: per visible skill, `uri`, `frontmatter` and `resources` (every file, `SKILL.md` first, each with `uri`, `digest` `sha256:<hex>` and byte `size`). One page |
| `skills/get` | `{ skill }` for a `SKILL.md` URI. Any other URI is `-32602 Unknown skill: <uri>` |
| `resources/list`, `resources/read` | Every file of every visible skill |

On a 2026-07-28 request, `skills/get` needs an `Mcp-Name` header equal to the `uri`, and results carry `resultType: "complete"`, `ttlMs: 0` and `cacheScope: "private"`. Older requests get none of these. Responses are `Cache-Control: no-store`. Digests are computed once from the static text and are the same for every caller.

## Who sees what

Same rules as [resources](resources.md#who-sees-what), decided once per skill and request for all its files.

| Case | Answer |
|------|--------|
| No principal | 401 |
| `skills/list`, `resources/list` | Only skills the principal may read. Never 403 |
| `skills/get` or a file read without the scope | 403 `insufficient_scope` naming it |
| Same, with `hideToolsOutsideScope: true` or `"strict"` | `Unknown skill: <uri>` or `Unknown resource: <uri>` |
| Refused by `allow` | Always the unknown answer |
| A URI that is not a declared `skill://<name>/<path>` | The unknown answer |

Calls are audited under their own method with the same `error` values as resources.

## Skills and tools

Skill text is untrusted model input. A tool keeps its own `scope` check, the library never reads `allowed-tools`, and nothing in a skill causes a tool call: a model told to call `purge_data` still gets 403 without that tool's scope. What a host does with a loaded skill (approval, execution, name collisions) is the host's job.

## Limits

| Limit | Value |
|-------|-------|
| Files per skill, `SKILL.md` included | 512 |
| Bytes per skill | 16 MiB (16,777,216) |

Both are refused at construction. No Skills host has been tested; the tests stub the host, so they prove the answers, not how a client behaves.

## What is not included

- `"resources": "dynamic"`, binary files, per-request content, and nested skills (a name such as `acme/billing/refunds`).
- `resources/directory/read` (`-32601`) and pagination of `skills/list`.
- Running, generating or scheduling skills.

## Migration and rollback

No change is required for an existing integration. To roll back, remove the `skills` option. Nothing is stored.
