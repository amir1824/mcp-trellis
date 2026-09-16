#!/usr/bin/env node
/**
 * Project desk — Node entry for local / self-host runs.
 *
 *   DEMO_PASSWORD=project-desk-demo \
 *   OAUTH_CODE_SECRET="$(openssl rand -hex 32)" \
 *   npx tsx examples/project-desk/server.ts
 *
 * Published package: `npx mcp-trellis-project-desk` (same env vars).
 */
import http from "node:http";
import { asNodeHandler } from "mcp-trellis/node";
import { createDemo } from "./src/app.js";

const port = Number(process.env.PORT ?? 8787);
const origin = process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`;
const password = process.env.DEMO_PASSWORD;
const codeSecret = process.env.OAUTH_CODE_SECRET;
if (!password || !codeSecret) {
  throw new Error("Set DEMO_PASSWORD and OAUTH_CODE_SECRET; see README.md");
}
const app = createDemo({ origin, password, codeSecret });
http.createServer(asNodeHandler(app, { origin })).listen(port, "127.0.0.1", () => {
  process.stdout.write(`Project desk: http://127.0.0.1:${port}\nMCP URL: ${origin}/mcp\n`);
});
