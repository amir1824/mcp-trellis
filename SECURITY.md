# Security Policy

mcp-trellis ships an MCP protocol handler **and** a self-hosted OAuth 2.1
authorization server in one zero-dependency package. The authorization
server is the higher-stakes half — please report suspected vulnerabilities
privately rather than in a public issue.

## Supported versions

| Version | Supported |
|---------|-----------|
| Latest `0.x` minor | ✅ |
| Older `0.x` minors | ❌ |

This project is pre-1.0; only the latest published minor version receives
security fixes. Once `1.0.0` ships, this table will track a maintained
major-version window.

## Reporting a vulnerability

**Do not open a public GitHub issue for a suspected vulnerability.**

Report privately via [GitHub Security Advisories](https://github.com/amir1824/mcp-trellis/security/advisories/new)
("Report a vulnerability" on the Security tab). This reaches the maintainer
directly and lets us coordinate a fix before any public disclosure.

Please include:

- The affected version(s) and a minimal reproduction.
- Which component is involved — the authorization server (`src/oauth/*`)
  or the MCP protocol handler (`src/dispatch.ts`, `src/methods.ts`, …).
- The impact you believe is possible (e.g. token forgery, redirect
  hijack, credential leakage).

## Response and disclosure timeline

- **Acknowledgement:** within 5 business days.
- **Initial assessment:** within 10 business days — confirmed, needs more
  information, or not applicable.
- **Disclosure:** we aim to publish a fix and a GitHub Security Advisory
  within **90 days** of a confirmed report. If a fix needs more time, we
  will coordinate an extended timeline with the reporter rather than
  disclose an unpatched vulnerability.

## In scope

- The authorization server (`src/oauth/`) — authorize/token/revoke/consent
  flows, PKCE, redirect and client validation, auth-code and consent-ticket
  sealing, scope handling.
- The MCP protocol handler (`src/dispatch.ts`, `src/methods.ts`,
  `src/registry.ts`, `src/validate.ts`) — request dispatch, tool
  invocation, and schema validation.
- The Node HTTP adapter (`src/adapters/`).

## Out of scope

- **Host-implemented ports** you supply — `resolveUser`, `mintAccessToken`,
  `verifyToken`, `clientStore`, your login page, your token store, and how
  you store credentials. This library never sees or persists plaintext
  credentials; bugs in your implementation of these ports are not
  mcp-trellis vulnerabilities.
- **Missing rate limiting** — by design, documented in
  [docs/security.md](docs/security.md); apply it at your edge or reverse
  proxy.
- **Denial of service via infrastructure** (network flooding, etc.) —
  report to your hosting provider.

For known, accepted risks and the full threat model, see
[docs/security.md](docs/security.md).
