# Publish Project desk (operator)

In-repo artifacts are ready. These steps need Cloudflare, npm, and GitHub login.

## 1. Deploy the Worker

From the repository root:

```bash
npx wrangler secret put DEMO_PASSWORD
# value: project-desk-demo

npx wrangler secret put OAUTH_CODE_SECRET
# value: openssl rand -hex 32 (store privately; not the public demo password)

# Optional — pin origin if the Worker URL should not be request-derived:
# npx wrangler secret put PUBLIC_ORIGIN
# value: https://mcp-trellis-project-desk.<subdomain>.workers.dev

npx wrangler deploy
```

Confirm:

- Browser: login as alice with `project-desk-demo`
- `https://mcp-trellis-project-desk.<subdomain>.workers.dev/mcp`
- `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`

If the workers.dev subdomain is not `amir1824`, edit
[`server.json`](server.json) `remotes[0].url` to match before Registry publish.

## 2. Publish the npm companion

```bash
chmod +x examples/project-desk/publish-npm.sh   # once
./examples/project-desk/publish-npm.sh
```

The script copies [`package.npm.json`](package.npm.json) → `package.json` for the
publish only (a permanent nested `package.json` would break monorepo imports of
`mcp-trellis`). Package name: `mcp-trellis-project-desk@1.0.0`.

## 3. Publish to the Official MCP Registry

```bash
# Install once: https://modelcontextprotocol.io/registry/quickstart
mcp-publisher login github
cd examples/project-desk
mcp-publisher publish
```

Verify:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.amir1824/project-desk"
```

Do **not** submit the `mcp-trellis` SDK package to the Registry.
