# Security Policy

mcp-trellis ships an MCP protocol handler **and** a self-hosted OAuth 2.1
authorization server in one zero-dependency package. The authorization
server is the higher-stakes half — please report suspected vulnerabilities
privately rather than in a public issue.

## Supported versions

| Version | Supported |
|---------|-----------|
| Latest `2.x` minor | ✅ |
| Older `2.x` minors | ❌ |
| `1.x` | ❌ |
| `0.x` | ❌ |

Only the latest published `2.x` minor receives security fixes.

> **Note on 1.0.0:** the live `1.0.0` on npm (published 2026-08-21) was cut
> manually without npm provenance. From `2.0.0` onward, releases go through
> GitHub Actions OIDC trusted publishing with provenance attached. Do not
> treat `1.0.0` as a supported baseline.

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
  once a patched release is available. Coordinated disclosure preferred;
  please do not publish exploit details before a fix ships.

## Security model (short)

Host ports own login, token mint/verify/revoke, and data ACLs. The library
owns OAuth protocol surfaces, audience checks under `createMcpApp`, consent,
sealed codes, and MCP transport hardening. See [docs/security.md](docs/security.md)
for the full threat model.
