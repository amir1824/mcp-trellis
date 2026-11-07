#!/usr/bin/env bash
set -euo pipefail
gh repo edit amir1824/mcp-trellis \
  --description 'Add user-scoped MCP to your existing TypeScript SaaS. Keep your login. Own your OAuth. Self-hosted OAuth 2.1 server plus MCP handler, zero runtime dependencies.' \
  --homepage 'https://www.npmjs.com/package/mcp-trellis' \
  --add-topic mcp \
  --add-topic model-context-protocol \
  --add-topic mcp-server \
  --add-topic remote-mcp \
  --add-topic oauth \
  --add-topic oauth2 \
  --add-topic typescript \
  --add-topic nextjs \
  --add-topic cloudflare-workers \
  --add-topic ai-agents \
  --add-topic claude \
  --add-topic chatgpt \
  --add-topic saas \
  --add-topic authentication \
  --add-topic authorization
gh repo view amir1824/mcp-trellis --json description,homepageUrl,repositoryTopics,hasDiscussionsEnabled
