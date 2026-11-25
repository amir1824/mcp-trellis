/**
 * The requests whose answers must not change for 2024-11-05, 2025-03-26 and 2025-06-18. The expected
 * answers in `golden-legacy.json` were captured by running this same list against the commit before
 * the 2026-07-28 change; `golden.test.ts` replays it against the current code.
 */

import {
  buildHandler,
  type Call,
  type Captured,
  capture,
  INGEST_TOKEN,
  oversizedBody,
  READ_TOKEN,
  rpc,
  send,
} from "./harness.js";

export const LEGACY_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"] as const;

const withVersion = (version: string, call: Call): Call => ({
  ...call,
  headers: { "MCP-Protocol-Version": version, ...call.headers },
});

const calls = (version: string): Array<[string, Call]> =>
  [
    ["initialize", { body: rpc("initialize", { protocolVersion: version }) }],
    ["initialize asks 2026-07-28", { body: rpc("initialize", { protocolVersion: "2026-07-28" }) }],
    ["ping", { body: rpc("ping") }],
    ["tools/list", { body: rpc("tools/list"), token: READ_TOKEN }],
    ["tools/list anonymous", { body: rpc("tools/list") }],
    [
      "tools/call ok",
      { body: rpc("tools/call", { name: "echo", arguments: { text: "hi" } }), token: READ_TOKEN },
    ],
    ["tools/call unknown", { body: rpc("tools/call", { name: "nope" }), token: READ_TOKEN }],
    [
      "tools/call missing scope",
      { body: rpc("tools/call", { name: "secret_write" }), token: READ_TOKEN },
    ],
    [
      "tools/call bad arguments",
      { body: rpc("tools/call", { name: "echo", arguments: 5 }), token: READ_TOKEN },
    ],
    ["server/discover anonymous", { body: rpc("server/discover") }],
    ["server/discover authenticated", { body: rpc("server/discover"), token: READ_TOKEN }],
    ["unknown method", { body: rpc("nope/nope"), token: READ_TOKEN }],
    ["notification", { body: { jsonrpc: "2.0", method: "notifications/initialized" } }],
    ["bad envelope", { body: { id: 1, method: "ping" } }],
    ["batch", { body: [rpc("ping")] }],
    ["malformed json", { body: "{not-json" }],
    [
      "oversized body",
      { body: oversizedBody(), headers: { "Content-Length": String(oversizedBody().length) } },
    ],
    [
      "unknown version header",
      {
        body: rpc("tools/list"),
        token: READ_TOKEN,
        headers: { "MCP-Protocol-Version": "1999-01-01" },
      },
    ],
    [
      "modern-looking meta, older header",
      {
        body: rpc("tools/list", {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        }),
        token: READ_TOKEN,
      },
    ],
    [
      "initialize, unknown header, matching meta",
      {
        body: rpc("initialize", {
          protocolVersion: "2025-06-18",
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "1999-01-01",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        }),
        headers: { "MCP-Protocol-Version": "1999-01-01" },
      },
    ],
    ["query-string token", { body: rpc("tools/list"), headers: { "x-test": "q" } }],
    ["get anonymous", { body: "", method: "GET" }],
    ["get authenticated", { body: "", method: "GET", token: READ_TOKEN }],
  ].map(([name, call]) => [name as string, withVersion(version, call as Call)]);

const uiCalls = (version: string): Array<[string, Call]> =>
  (
    [
      ["resources/list ingest", { body: rpc("resources/list"), token: INGEST_TOKEN }],
      ["resources/list read", { body: rpc("resources/list"), token: READ_TOKEN }],
      ["resources/list anonymous", { body: rpc("resources/list") }],
      [
        "resources/read ok",
        { body: rpc("resources/read", { uri: "ui://test/view" }), token: INGEST_TOKEN },
      ],
      [
        "resources/read denied",
        { body: rpc("resources/read", { uri: "ui://test/view" }), token: READ_TOKEN },
      ],
      [
        "resources/read unknown",
        { body: rpc("resources/read", { uri: "ui://test/none" }), token: INGEST_TOKEN },
      ],
      ["tools/list ui", { body: rpc("tools/list"), token: READ_TOKEN }],
    ] as Array<[string, Call]>
  ).map(([name, call]) => [name, withVersion(version, call)]);

const queryTokenRequest = (handler: ReturnType<typeof buildHandler>["handler"]) =>
  handler.fetch(
    new Request("https://example.test/mcp?access_token=read-tok", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rpc("tools/list")),
    }),
  );

/** Every answer for one older version, keyed by request name. */
export const runGolden = async (version: string): Promise<Record<string, Captured>> => {
  const answers: Record<string, Captured> = {};
  const plain = buildHandler().handler;
  const hidden = buildHandler({ hideToolsOutsideScope: true }, true).handler;
  const custom = buildHandler({
    publicMethods: new Set(["initialize", "ping", "tools/list"]),
  }).handler;
  for (const [name, call] of calls(version)) {
    answers[name] =
      name === "query-string token"
        ? await capture(await queryTokenRequest(plain))
        : await capture(await send(plain, call));
  }
  for (const [name, call] of uiCalls(version)) {
    answers[`hide+ui ${name}`] = await capture(await send(hidden, call));
  }
  answers["custom publicMethods tools/list anonymous"] = await capture(
    await send(custom, withVersion(version, { body: rpc("tools/list") })),
  );
  answers["custom publicMethods discover anonymous"] = await capture(
    await send(custom, withVersion(version, { body: rpc("server/discover") })),
  );
  return answers;
};
