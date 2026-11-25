import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { corsHeaders, optionsResponse } from "../../src/http/http.js";

describe("CORS headers", () => {
  it("a preflight allows the 2026-07-28 request headers next to the older ones", () => {
    const allowed = optionsResponse().headers.get("Access-Control-Allow-Headers");
    assert.equal(
      allowed,
      "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
    );
  });

  it("an ordinary response keeps the older list, unchanged", () => {
    assert.equal(
      corsHeaders()["Access-Control-Allow-Headers"],
      "Content-Type, Authorization, MCP-Protocol-Version",
    );
  });

  it("a preflight with cors off carries no CORS headers", () => {
    assert.equal(
      optionsResponse({ cors: false }).headers.get("Access-Control-Allow-Headers"),
      null,
    );
  });
});
