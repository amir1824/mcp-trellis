import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PROTOCOL_VERSIONS } from "../../../src/mcp/protocol.js";
import * as publicApi from "../../../src/server.js";
import { runGolden } from "./golden-requests.js";
import { buildHandler, send } from "./harness.js";

const golden = JSON.parse(readFileSync(new URL("./golden-legacy.json", import.meta.url), "utf8"));

describe("older protocol versions answer exactly as before the 2026-07-28 change", () => {
  it("R4 M1 2024-11-05: status, headers and body are identical for every request", async () => {
    assert.deepEqual(await runGolden("2024-11-05"), golden["2024-11-05"]);
  });

  it("R4 M1 2025-03-26: status, headers and body are identical for every request", async () => {
    assert.deepEqual(await runGolden("2025-03-26"), golden["2025-03-26"]);
  });

  it("R4 M1 2025-06-18: status, headers and body are identical for every request", async () => {
    assert.deepEqual(await runGolden("2025-06-18"), golden["2025-06-18"]);
  });

  it("R8 the supported older versions and the exported API are unchanged", () => {
    assert.deepEqual([...PROTOCOL_VERSIONS], ["2024-11-05", "2025-03-26", "2025-06-18"]);
    assert.equal(publicApi.DEFAULT_PROTOCOL_VERSION, "2025-06-18");
    assert.equal("MODERN_PROTOCOL_VERSION" in publicApi, false);
  });

  it("R8 the browser preflight now also allows the two 2026-07-28 headers and still the old ones", async () => {
    const res = await send(buildHandler().handler, { body: "", method: "OPTIONS" });
    const allowed = res.headers.get("access-control-allow-headers") ?? "";
    assert.equal(res.status, 204);
    assert.match(allowed, /Content-Type, Authorization, MCP-Protocol-Version/);
    assert.match(allowed, /Mcp-Method, Mcp-Name/);
  });
});
