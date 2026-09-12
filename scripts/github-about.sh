#!/usr/bin/env bash
set -euo pipefail
gh repo edit amir1824/mcp-trellis \
  --description 'Build secure remote MCP servers for Claude, ChatGPT and Gemini using your existing auth.' \
  --homepage 'https://www.npmjs.com/package/mcp-trellis' \
  --add-topic mcp --add-topic model-context-protocol --add-topic oauth \
  --add-topic typescript --add-topic claude --add-topic chatgpt \
  --add-topic gemini --add-topic codex --add-topic mcp-server
gh repo view amir1824/mcp-trellis --json description,homepageUrl,repositoryTopics
