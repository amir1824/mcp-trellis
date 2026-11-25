import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolDef } from "../../../src/mcp/registry.js";
import { MAX_UI_BLOB_BYTES } from "../../../src/mcp/ui/document.js";
import type { UiResource } from "../../../src/mcp/ui/types.js";
import { type Ctx, makeEnv, readResource, TOKENS } from "./harness.js";

const URI = "ui://x/y";
const HTML = "<!DOCTYPE html><html><body>é</body></html>";
const BLOB = Buffer.from(HTML, "utf8").toString("base64");

const tool: ToolDef<Ctx> = {
  name: "t",
  description: "d",
  inputSchema: { type: "object" },
  scope: null,
  ui: { resourceUri: URI },
  handler: () => "x",
};

const build = (extra: object) => () =>
  makeEnv({ tools: [tool], resources: [{ uri: URI, html: HTML, ...extra } as UiResource] });

const readOf = async (extra: object) => {
  const reply = await readResource(build(extra)(), URI, TOKENS.alice);
  return (reply.body.result as { contents: Array<Record<string, unknown>> }).contents[0];
};

const encode = (bytes: number) => Buffer.alloc(bytes, "a").toString("base64");

const EMITTED: Array<[string, object, object]> = [
  [
    "frameDomains and baseUriDomains",
    {
      csp: { frameDomains: ["https://www.youtube.com"], baseUriDomains: ["https://*.example.com"] },
    },
    {
      csp: { frameDomains: ["https://www.youtube.com"], baseUriDomains: ["https://*.example.com"] },
    },
  ],
  [
    "all four csp keys",
    {
      csp: {
        connectDomains: ["wss://a.example.com"],
        resourceDomains: ["https://b.example.com"],
        frameDomains: ["https://c.example.com"],
        baseUriDomains: ["https://d.example.com"],
      },
    },
    {
      csp: {
        connectDomains: ["wss://a.example.com"],
        resourceDomains: ["https://b.example.com"],
        frameDomains: ["https://c.example.com"],
        baseUriDomains: ["https://d.example.com"],
      },
    },
  ],
  [
    "permissions",
    { permissions: { camera: {}, clipboardWrite: {} } },
    { permissions: { camera: {}, clipboardWrite: {} } },
  ],
  [
    "a domain",
    { domain: "a904794854a047f6.claudemcpcontent.com" },
    { domain: "a904794854a047f6.claudemcpcontent.com" },
  ],
  ["prefersBorder true", { prefersBorder: true }, { prefersBorder: true }],
  ["prefersBorder false", { prefersBorder: false }, { prefersBorder: false }],
];

describe("U1 the new _meta.ui fields are emitted exactly as the spec names them", () => {
  EMITTED.forEach(([label, field, ui]) => {
    it(`U1 ${label}`, async () => {
      const content = await readOf(field);
      assert.deepEqual(content?._meta, { ui });
      assert.equal(content?.text, HTML);
    });
  });

  it("U1 a resource declaring none of them has no _meta and no blob", async () => {
    const content = await readOf({});
    assert.deepEqual(content, { uri: URI, mimeType: "text/html;profile=mcp-app", text: HTML });
  });
});

const REJECTED: Array<[string, object, RegExp]> = [
  [
    "a semicolon in frameDomains",
    { csp: { frameDomains: ["https://a.example.com;x"] } },
    /csp\.frameDomains/,
  ],
  [
    "whitespace in baseUriDomains",
    { csp: { baseUriDomains: ["https://a.example.com evil.com"] } },
    /csp\.baseUriDomains/,
  ],
  [
    "a quote in frameDomains",
    { csp: { frameDomains: ["https://a.example.com'"] } },
    /csp\.frameDomains/,
  ],
  [
    "a comma in baseUriDomains",
    { csp: { baseUriDomains: ["https://a.example.com,https://b.com"] } },
    /csp\.baseUriDomains/,
  ],
  ["a bare wildcard in frameDomains", { csp: { frameDomains: ["*"] } }, /csp\.frameDomains/],
  [
    "an http origin in frameDomains",
    { csp: { frameDomains: ["http://a.example.com"] } },
    /csp\.frameDomains/,
  ],
  [
    "a path in baseUriDomains",
    { csp: { baseUriDomains: ["https://a.example.com/x"] } },
    /csp\.baseUriDomains/,
  ],
  [
    "a non-array frameDomains",
    { csp: { frameDomains: "https://a.example.com" } },
    /csp\.frameDomains/,
  ],
  ["an unknown permission", { permissions: { usb: {} } }, /permissions has unsupported keys: usb/],
  ["a boolean permission", { permissions: { camera: true } }, /permissions\.camera/],
  ["a non-empty permission", { permissions: { camera: { x: 1 } } }, /permissions\.camera/],
  ["a non-object permissions", { permissions: ["camera"] }, /permissions must be an object/],
  ["a scheme in domain", { domain: "https://a.example.com" }, /domain/],
  ["a semicolon in domain", { domain: "a.example.com;script-src *" }, /domain/],
  ["whitespace in domain", { domain: "a.example.com evil.com" }, /domain/],
  ["a quote in domain", { domain: "a.example.com'" }, /domain/],
  ["a comma in domain", { domain: "a.example.com,b.com" }, /domain/],
  ["a wildcard in domain", { domain: "*.example.com" }, /domain/],
  ["userinfo in domain", { domain: "user@a.example.com" }, /domain/],
  ["a path in domain", { domain: "a.example.com/x" }, /domain/],
  ["an upper-case domain", { domain: "A.example.com" }, /domain/],
  ["an empty domain", { domain: "" }, /domain/],
  ["a non-string domain", { domain: 5 }, /domain/],
  ["a string prefersBorder", { prefersBorder: "yes" }, /prefersBorder must be a boolean/],
  ["a numeric prefersBorder", { prefersBorder: 1 }, /prefersBorder must be a boolean/],
  ["a null prefersBorder", { prefersBorder: null }, /prefersBorder must be a boolean/],
];

describe("U2 an invalid shape fails at construction and names the resource", () => {
  REJECTED.forEach(([label, field, message]) => {
    it(`U2 ${label}`, () => {
      assert.throws(build(field), message);
      assert.throws(build(field), /uiResources ui:\/\/x\/y:/);
    });
  });
});

const BAD_DOCUMENTS: Array<[string, object, RegExp]> = [
  ["html and blob together", { blob: BLOB }, /html or blob, not both/],
  ["neither html nor blob", { html: undefined }, /html must be a non-empty string/],
  ["a blank blob", { html: undefined, blob: "" }, /non-empty html/],
  ["a non-string blob", { html: undefined, blob: 5 }, /blob must be a base64 string/],
  [
    "a base64 alphabet violation",
    { html: undefined, blob: "PGh0bWw+!!!=" },
    /standard padded base64/,
  ],
  ["unpadded base64", { html: undefined, blob: "PGh0bWw" }, /standard padded base64/],
  ["base64url characters", { html: undefined, blob: "PGh0-_w=" }, /standard padded base64/],
  ["whitespace inside base64", { html: undefined, blob: "PGh0 bWw+" }, /standard padded base64/],
  ["stray trailing bits", { html: undefined, blob: "PGh0bWx=" }, /canonical base64/],
  ["bytes that are not UTF-8", { html: undefined, blob: "/w==" }, /canonical base64 of UTF-8/],
  [
    "whitespace-only content",
    { html: undefined, blob: Buffer.from("  \n").toString("base64") },
    /non-empty html/,
  ],
  [
    "a decoded size over the cap",
    { html: undefined, blob: encode(MAX_UI_BLOB_BYTES + 1) },
    /over the 16777216-byte limit/,
  ],
];

describe("U3 a blob is a strict base64 document with a decoded size cap", () => {
  BAD_DOCUMENTS.forEach(([label, field, message]) => {
    it(`U3 ${label}`, () => {
      assert.throws(build(field), message);
      assert.throws(build(field), /uiResources ui:\/\/x\/y:/);
    });
  });

  it("U3 a blob is served as blob, never as text, with the same _meta", async () => {
    const content = await readOf({ html: undefined, blob: BLOB, prefersBorder: true });
    assert.deepEqual(content, {
      uri: URI,
      mimeType: "text/html;profile=mcp-app",
      blob: BLOB,
      _meta: { ui: { prefersBorder: true } },
    });
  });

  it("U3 a blob decoding to exactly the cap builds, because the cap counts decoded bytes", () => {
    assert.doesNotThrow(build({ html: undefined, blob: encode(MAX_UI_BLOB_BYTES) }));
  });
});
