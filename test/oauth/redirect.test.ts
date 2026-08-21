import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLAUDE_CALLBACK, isAllowedRedirectUri } from "../../src/oauth/redirect.js";

describe("redirect allowlist — baseline", () => {
  it("allows Claude callback and loopback", () => {
    assert.equal(isAllowedRedirectUri(CLAUDE_CALLBACK), true);
    assert.equal(isAllowedRedirectUri("http://127.0.0.1:8787/cb"), true);
    assert.equal(isAllowedRedirectUri("https://evil.example/cb"), false);
  });
});

/**
 * Hostile-URI table. Every row is a redirect_uri an attacker might present
 * hoping the allowlist mistakes it for a legitimate loopback or the Claude
 * callback. `expected: false` means "must never be admitted"; `true` rows
 * pin the genuinely-safe cases (including WHATWG normalization) so a future
 * change can't silently widen the allowlist without a failing test.
 */
const HOSTILE_URIS: Array<{ uri: string; expected: boolean; note: string }> = [
  { uri: "http://127.0.0.1:8787/cb", expected: true, note: "loopback IPv4" },
  { uri: "http://[::1]:8787/cb", expected: true, note: "loopback IPv6" },
  {
    uri: "http://localhost:8787/cb",
    expected: false,
    note: "RFC 8252 §8.3 — localhost is DNS-resolvable, not a loopback guarantee",
  },
  {
    uri: "https://127.0.0.1:8787/cb",
    expected: false,
    note: "RFC 8252 native-app loopback redirects are http: only",
  },
  { uri: "https://claude.ai.evil.com/cb", expected: false, note: "subdomain confusion" },
  { uri: "https://claude.ai@evil.com/cb", expected: false, note: "userinfo confusion" },
  { uri: "https://claude.ai%40evil.com/cb", expected: false, note: "encoded userinfo" },
  {
    uri: "https://claude.ai/api/mcp/auth_callback/../../evil",
    expected: false,
    note: "path traversal",
  },
  {
    uri: "https://CLAUDE.AI/api/mcp/auth_callback",
    expected: false,
    note: "case variation is not an exact match",
  },
  {
    uri: "https://claude.ai/api/mcp/auth_callback#frag",
    expected: false,
    note: "fragment appended to a valid callback",
  },
  { uri: "http://127.0.0.1.evil.com/cb", expected: false, note: "IP-looking subdomain" },
  { uri: "http://0.0.0.0/cb", expected: false, note: "not loopback" },
  {
    uri: "http://127.1/cb",
    expected: true,
    note: "WHATWG normalizes shorthand IPv4 to 127.0.0.1 — genuinely loopback",
  },
  {
    uri: "http://2130706433/cb",
    expected: true,
    note: "WHATWG normalizes decimal IPv4 to 127.0.0.1 — genuinely loopback",
  },
  { uri: "javascript:alert(1)", expected: false, note: "javascript: scheme" },
  { uri: "data:text/html,<script>alert(1)</script>", expected: false, note: "data: scheme" },
  { uri: "//evil.com/cb", expected: false, note: "schemeless — not a valid absolute URL" },
  {
    uri: "http://localhost/cb",
    expected: false,
    note: "localhost dropped, no explicit port either",
  },
  { uri: "ftp://127.0.0.1/cb", expected: false, note: "non-http(s) scheme on loopback host" },
  { uri: "http://EXAMPLE.com/cb", expected: false, note: "arbitrary host, never allowed" },
  { uri: "not a url at all", expected: false, note: "unparsable" },
  {
    uri: "http://127.0.0.1:8787/cb#frag",
    expected: false,
    note: "RFC 6749 forbids a fragment in redirect_uri, even on an otherwise-valid loopback",
  },
  {
    uri: "http://user:pass@127.0.0.1:8787/cb",
    expected: false,
    note: "embedded credentials are never legitimate, even on an otherwise-valid loopback",
  },
  {
    uri: `${CLAUDE_CALLBACK}#frag`,
    expected: false,
    note: "fragment rejected even on the exact-match Claude callback",
  },
];

describe("redirect allowlist — hostile URI table", () => {
  for (const { uri, expected, note } of HOSTILE_URIS) {
    it(`${expected ? "allows" : "rejects"} ${JSON.stringify(uri)} (${note})`, () => {
      assert.equal(isAllowedRedirectUri(uri), expected);
    });
  }
});

describe("redirect allowlist options", () => {
  it("extra exact-match entries are honored", () => {
    assert.equal(
      isAllowedRedirectUri("https://gemini.test/callback", {
        extra: ["https://gemini.test/callback"],
      }),
      true,
    );
    assert.equal(isAllowedRedirectUri("https://gemini.test/callback", { extra: [] }), false);
  });

  it("allowLoopback: false rejects loopback", () => {
    assert.equal(isAllowedRedirectUri("http://127.0.0.1:4000/cb", { allowLoopback: false }), false);
  });

  it("allowClaude: false rejects the Claude callback", () => {
    assert.equal(isAllowedRedirectUri(CLAUDE_CALLBACK, { allowClaude: false }), false);
  });
});
