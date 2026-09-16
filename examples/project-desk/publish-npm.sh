#!/usr/bin/env bash
# Publish mcp-trellis-project-desk to npm without leaving a nested
# package.json in the monorepo (that breaks root `mcp-trellis` self-resolve).
set -euo pipefail
cd "$(dirname "$0")"
cp package.npm.json package.json
cleanup() {
  rm -f package.json package-lock.json
  rm -rf node_modules dist
}
trap cleanup EXIT
npm install
npm run build
npm publish --access public "$@"
