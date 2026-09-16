#!/usr/bin/env bash
set -euo pipefail
gh repo edit amir1824/mcp-trellis \
  --description 'Add authenticated Claude, ChatGPT and Gemini connectors to your existing TypeScript SaaS — self-hosted MCP + OAuth, BYO auth.' \
  --homepage 'https://www.npmjs.com/package/mcp-trellis' \
  --enable-discussions \
  --add-topic mcp \
  --add-topic model-context-protocol \
  --add-topic mcp-server \
  --add-topic oauth \
  --add-topic oauth2 \
  --add-topic typescript \
  --add-topic claude \
  --add-topic chatgpt \
  --add-topic gemini \
  --add-topic ai-connectors \
  --add-topic saas \
  --add-topic authentication \
  --add-topic authorization \
  --add-topic remote-mcp
gh repo view amir1824/mcp-trellis --json description,homepageUrl,repositoryTopics,hasDiscussionsEnabled
