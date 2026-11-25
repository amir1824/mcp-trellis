# Skills: serve instructions to the model (experimental)

A skill is a folder of text that tells a model how to do a job: a `SKILL.md` plus supporting files. mcp-trellis serves skills with the Skills extension (`io.modelcontextprotocol/skills`). A skill is served text and nothing more: Trellis never runs it, never calls a tool because of it, and it never changes what a caller may do.

## Status

**Experimental, opt-in and off by default.** The `skills` option is `@experimental` and may change in a minor release. An integration that registers no skill answers byte for byte as before: no `skills/*` method, no extension in the capabilities. The code lives in `src/mcp/skills/` and adds no required field to a stable type.

## Pinned specification

| | |
|---|---|
| Extension | `io.modelcontextprotocol/skills`, SEP-2640 |
| Normative text | `specification/beta/skills.mdx` in `modelcontextprotocol/ext-skills` |
| Commit read | `c0705f9071caa539eeb2c9f5f2f77ac16b048ca6` |
| sha256 of `skills.mdx` | `6e33a33762783a02dc4c13c889dda5b8d7c525649012cf77da12d80c04ce6851` |
| Base protocol | `2026-07-28`, and the legacy path too (see below) |
| Skill format | [Agent Skills specification](https://agentskills.io/specification), read 2026-11-25 |

Read on 2026-11-25 from the SEP page, `https://modelcontextprotocol.io/extensions/skills`, the extensions listing and the file above. Where they disagree:

- **Status.** The SEP page says "Final"; the extensions listing says "Beta, destination not yet stated". Trellis pins the text of the commit above and treats the extension as experimental either way.
- **Cache fields on `skills/get`.** The SEP page leaves `ttlMs` and `cacheScope` open; the extension page and `skills.mdx` require them. Trellis follows the stricter text.

Naming (agentskills.io): `name` is 1 to 64 characters, lowercase letters, digits and hyphens, none leading, trailing or doubled; `description` 1 to 1024 characters; `metadata` maps strings to strings. Trellis is stricter in one point: ASCII letters only.

## Setup

```ts
import { createMcpApp, type SkillDef } from "mcp-trellis";

const refunds: SkillDef = {
  name: "refunds",
  description: "Process customer refund requests per company policy",
  instructions: "# Refunds\n\nRead references/policy.md first.\n",
  scope: "mcp",
  allow: (principal) => principal.claims?.team === "billing", // sync, no I/O
  files: [{ path: "references/policy.md", text: "…" }],
};

createMcpApp({ /* serverInfo, auth, … */ tools: [], skills: [refunds] });
```

`createMcpHandler` takes the same `skills` option. On a `createMcpApp` with more than one scope every skill needs an explicit `scope` (or `null`), as a tool does. On a 2026-07-28 request `skills/get` needs an `Mcp-Name` equal to the `uri`, as `resources/read` does.

| Field | Meaning |
|-------|---------|
| `name` | The URI is `skill://<name>/SKILL.md`. Unique. |
| `description`, `instructions` | The frontmatter `description`, and the body of `SKILL.md`. |
| `metadata` | Optional string map. `allowed-tools` and `io.modelcontextprotocol/` keys are refused. |
| `files` | `{ path, text, mimeType? }`, served at `skill://<name>/<path>`. Text only. |
| `scope`, `allow` | As on a [resource](resources.md#a-resource), for the whole skill. |

Trellis writes `SKILL.md`: `name`, `description` and `metadata` as one `key: <JSON value>` line each between `---` lines (valid YAML), a blank line, then `instructions`. The listed `frontmatter` is the object that was written.

Construction throws once, listing every problem, for: a bad or repeated name; a description outside 1 to 1024 characters; control characters in the frontmatter; a file path that is not relative segments of `A-Z a-z 0-9 _ . -` (so no `..`, `.`, empty segment, `%`, backslash, NUL or space), over 200 characters, repeated (any case) or named `SKILL.md`; over 512 files or 16 MiB; a `skill://` URI in `resources`. Nothing partial is served.

## What a client gets

| Method | Answer |
|--------|--------|
| `initialize`, `server/discover` | `extensions["io.modelcontextprotocol/skills"]: {}` next to `resources: {}`, only when a skill exists. No `directoryRead`. |
| `skills/list` | `{ skills }`: per visible skill, `uri`, `frontmatter` and `resources` (every file, `SKILL.md` first, with `uri`, `digest` `sha256:<hex>` and byte `size`). One page. |
| `skills/get` | `{ skill }` for a `SKILL.md` URI; anything else is `-32602 Unknown skill: <uri>`. |
| `resources/list`, `resources/read` | Every file of every visible skill. |

On a 2026-07-28 request results carry `resultType: "complete"`, `ttlMs: 0` and `cacheScope: "private"`; a legacy request gets none of them. Responses are `Cache-Control: no-store`. Digests are hashed once from the static text and kept, the same for every caller.

## Who sees what

Per skill and per request, by the rule of resources, with the same ports.

| Case | Answer |
|------|--------|
| No principal | 401 |
| `skills/list`, `resources/list` | Only skills the principal may read; never 403 |
| `skills/get` or a file read without the scope | 403 `insufficient_scope` naming it |
| The same under `hideToolsOutsideScope: true` or `"strict"` | The unknown answer (`Unknown skill: <uri>` or `Unknown resource: <uri>`), byte for byte |
| Refused by `allow` | Always the unknown answer |
| A URI that is not a declared `skill://<name>/<path>` | The unknown answer (`..`, `.`, `%`, backslash, NUL, case variants, another skill's prefix) |

A skill's `allow` runs once per request for all its files. Calls are audited under their own method, with the denial reasons of resources. A file read builds `context` once.

## Skills and tools

Skill text is untrusted model input. A tool keeps its own `scope` check, Trellis never reads `allowed-tools`, and nothing in a skill causes a tool call: a model told to call `purge_data` is still answered 403 without the tool's scope. What a host does with a loaded skill (approval, execution, name collisions) is the host's duty under the specification.

## Limits

| Limit | Value |
|-------|-------|
| Files per skill, `SKILL.md` included | 512 |
| Bytes per skill | 16 MiB (16,777,216) |

Both are the specification's limits, refused at construction.

## Hosts tested

No Skills host was tested. The tests stub the host: they prove the wiring and the answers, not how a client behaves.

## What is not included

- `"resources": "dynamic"`, binary files, per-request content and nested skills (a path prefix such as `acme/billing/refunds`).
- `resources/directory/read` (`-32601`), and pagination of `skills/list`.
- Running, generating, orchestrating or scheduling skills.

## Migration and rollback

No change is required for an existing integration. To roll back, remove the `skills` option or revert the release: nothing is stored.
