import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CimdDocument } from "../../../src/oauth/cimd/types.js";
import {
  describeClient,
  sanitizeClientName,
} from "../../../src/oauth/endpoints/consent/client-identity.js";
import { renderBuiltInConsent } from "../../../src/oauth/endpoints/consent/page.js";
import { CHATGPT_CALLBACK, CLAUDE_CALLBACK } from "../../../src/oauth/policy/redirect.js";
import type { ConsentRequest } from "../../../src/oauth/types.js";
import { VALID_S256_CHALLENGE } from "../../helpers/oauth.js";
import { stubPorts } from "../../helpers/ports.js";
import { createOAuthRouter } from "../../helpers/router.js";
import { DEFAULT_ORIGIN } from "../../helpers/target.js";

// Invisible and look-alike characters are built from code points so no editor or
// formatter can silently strip them from this file.
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const BRAILLE_BLANK = String.fromCodePoint(0x2800);
const HANGUL_FILLER = String.fromCodePoint(0x3164);
const COMBINING_ACUTE = String.fromCodePoint(0x0301);
const A_ACUTE = String.fromCodePoint(0x00e1);
const U_UMLAUT = String.fromCodePoint(0x00fc);
const CYRILLIC_ES = String.fromCodePoint(0x0421);
const CJK_EXTENSION_B_LETTER = String.fromCodePoint(0x20000);
const LATIN_SMALL_ALPHA = String.fromCodePoint(0x0251);
const LATIN_SCRIPT_G = String.fromCodePoint(0x0261);
const LATIN_SMALL_CAPS_CLAUDE = String.fromCodePoint(
  0x1d04,
  0x029f,
  0x1d00,
  0x1d1c,
  0x1d05,
  0x1d07,
);
// Shin, dagesh, shin dot, qamats: four code points that belong on one Hebrew letter.
const POINTED_HEBREW_SHIN = String.fromCodePoint(0x05e9, 0x05bc, 0x05c1, 0x05b8);

const ORIGIN = DEFAULT_ORIGIN;
const CIMD_CLIENT_ID = "https://clients.example/app.json";
const CLAUDE_CLIENT_ID = "https://claude.ai/client.json";
const CHATGPT_CLIENT_ID = "https://chatgpt.com/client.json";
const OTHER_APP_CALLBACK = "https://app.example/cb";
const CHATGPT_PER_CONNECTOR_CALLBACK = "https://chatgpt.com/connector/oauth/abc_123";

const cimdDoc = (clientName: string, clientId = CIMD_CLIENT_ID): CimdDocument => ({
  client_id: clientId,
  redirect_uris: [OTHER_APP_CALLBACK, CLAUDE_CALLBACK, CHATGPT_CALLBACK],
  client_name: clientName,
});

/** What the consent screen would say about a CIMD client with this name, document URL and redirect. */
const identityOf = (clientName: string, redirectUri: string, clientId = CIMD_CLIENT_ID) =>
  describeClient({ clientId, redirectUri, cimdDoc: cimdDoc(clientName, clientId) });

const consentRequest = (overrides: Partial<ConsentRequest> = {}): ConsentRequest => ({
  clientId: "client-id",
  registeredClient: null,
  redirectUri: OTHER_APP_CALLBACK,
  scope: ["mcp"],
  resource: `${ORIGIN}/mcp`,
  user: { id: "u1" },
  ticket: "ticket",
  oauthPath: "/mcp/oauth",
  ...overrides,
});

describe("sanitizeClientName", () => {
  it("strips bidi override and zero-width characters", () => {
    const raw = `Acme${RIGHT_TO_LEFT_OVERRIDE} App${ZERO_WIDTH_SPACE}`;

    assert.equal(sanitizeClientName(raw), "Acme App");
  });

  it("turns an injected newline into a space", () => {
    assert.equal(sanitizeClientName("Line one\nLine two"), "Line one Line two");
  });

  it("collapses the double space left by an invisible character between spaces", () => {
    assert.equal(sanitizeClientName(`a ${ZERO_WIDTH_SPACE} b`), "a b");
  });

  it("caps the name at 64 characters", () => {
    assert.equal(sanitizeClientName("a".repeat(10_000))?.length, 64);
  });

  it("caps the name at 64 code points, not 64 UTF-16 units", () => {
    const capped = sanitizeClientName(CJK_EXTENSION_B_LETTER.repeat(100)) ?? "";

    assert.equal(Array.from(capped).length, 64);
  });

  it("returns undefined when nothing visible is left", () => {
    assert.equal(sanitizeClientName(`${ZERO_WIDTH_SPACE}${RIGHT_TO_LEFT_OVERRIDE}`), undefined);
  });

  it("returns undefined for a name made only of braille blanks", () => {
    assert.equal(sanitizeClientName(BRAILLE_BLANK.repeat(3)), undefined);
  });

  it("returns undefined for a name made only of hangul fillers", () => {
    assert.equal(sanitizeClientName(HANGUL_FILLER.repeat(3)), undefined);
  });

  it("limits stacked combining marks to four", () => {
    // "x" has no precomposed form with an acute, so NFKC leaves every mark separate.
    const stacked = `x${COMBINING_ACUTE.repeat(50)}`;

    assert.equal(sanitizeClientName(stacked), `x${COMBINING_ACUTE.repeat(4)}`);
  });

  it("keeps all the marks of a pointed Hebrew letter", () => {
    assert.equal(sanitizeClientName(POINTED_HEBREW_SHIN), POINTED_HEBREW_SHIN.normalize("NFKC"));
  });

  it("leaves markup as text for the page to escape", () => {
    assert.equal(sanitizeClientName("<script>x</script>"), "<script>x</script>");
  });
});

describe("describeClient: the host line", () => {
  it("names the host the CIMD document was served from, plus the client's own name", () => {
    assert.deepEqual(identityOf("Acme", OTHER_APP_CALLBACK), {
      clientHost: "clients.example",
      clientName: "Acme",
    });
  });

  it("uses the redirect host and no name for a client without a CIMD document", () => {
    const identity = describeClient({
      clientId: "dcr-client",
      redirectUri: OTHER_APP_CALLBACK,
    });

    assert.deepEqual(identity, { clientHost: "app.example" });
  });

  it("calls an IPv4 loopback redirect an app on this device, with its port", () => {
    const identity = describeClient({
      clientId: "c",
      redirectUri: "http://127.0.0.1:9111/cb",
    });

    assert.equal(identity.clientHost, "An app on this device (port 9111)");
  });

  it("calls an IPv6 loopback redirect an app on this device, with its port", () => {
    const identity = describeClient({
      clientId: "c",
      redirectUri: "http://[::1]:8443/cb",
    });

    assert.equal(identity.clientHost, "An app on this device (port 8443)");
  });

  it("calls a loopback redirect without a port an app on this device", () => {
    const identity = describeClient({
      clientId: "c",
      redirectUri: "http://127.0.0.1/cb",
    });

    assert.equal(identity.clientHost, "An app on this device");
  });

  it("does not treat a host that merely starts with a loopback address as loopback", () => {
    const identity = describeClient({
      clientId: "c",
      redirectUri: "https://127.0.0.1.evil.example/cb",
    });

    assert.equal(identity.clientHost, "127.0.0.1.evil.example");
  });

  it("names the scheme of a custom-scheme redirect", () => {
    const identity = describeClient({ clientId: "c", redirectUri: "myapp://cb" });

    assert.equal(identity.clientHost, "An app using myapp:");
  });

  it("shows an internationalised host in its ASCII form", () => {
    const identity = describeClient({
      clientId: "c",
      redirectUri: `https://b${U_UMLAUT}cher.example/cb`,
    });

    assert.equal(identity.clientHost, "xn--bcher-kva.example");
  });

  it("returns no host for a redirect URI that does not parse", () => {
    const identity = describeClient({ clientId: "c", redirectUri: "not a url" });

    assert.deepEqual(identity, {});
  });

  it("takes the host from the request's client_id, not from the document", () => {
    const poisonedDoc = cimdDoc("Claude", CLAUDE_CLIENT_ID);
    const identity = describeClient({
      clientId: CIMD_CLIENT_ID,
      redirectUri: CLAUDE_CALLBACK,
      cimdDoc: poisonedDoc,
    });

    assert.deepEqual(identity, { clientHost: "clients.example" });
  });
});

describe("describeClient: a name that could pass for a vendor", () => {
  it("hides the name Claude behind a redirect that is not Claude's", () => {
    assert.equal(identityOf("Claude", OTHER_APP_CALLBACK).clientName, undefined);
  });

  it("hides the name Claude on Claude's callback when the document is served from another host", () => {
    assert.equal(identityOf("Claude", CLAUDE_CALLBACK).clientName, undefined);
  });

  it("shows the name Claude only when the redirect and the document host are both Claude's", () => {
    assert.equal(identityOf("Claude", CLAUDE_CALLBACK, CLAUDE_CLIENT_ID).clientName, "Claude");
  });

  it("hides a name that hides Claude behind a zero-width character", () => {
    assert.equal(identityOf(`Cl${ZERO_WIDTH_SPACE}aude`, OTHER_APP_CALLBACK).clientName, undefined);
  });

  it("hides a name that spells Claude with an accented letter", () => {
    assert.equal(identityOf(`Cl${A_ACUTE}ude`, OTHER_APP_CALLBACK).clientName, undefined);
  });

  it("hides a name that spells Claude with a combining accent", () => {
    assert.equal(identityOf(`Cla${COMBINING_ACUTE}ude`, OTHER_APP_CALLBACK).clientName, undefined);
  });

  it("hides a name that swaps a letter for a digit", () => {
    assert.equal(identityOf("Cl4ude", OTHER_APP_CALLBACK).clientName, undefined);
  });

  it("hides OpenAI spelled with a zero", () => {
    assert.equal(identityOf("0penAI", OTHER_APP_CALLBACK).clientName, undefined);
  });

  it("hides Claude spelled with a capital I for the l", () => {
    assert.equal(identityOf("CIaude", OTHER_APP_CALLBACK).clientName, undefined);
  });

  it("hides OpenAI spelled with an l for the I", () => {
    assert.equal(identityOf("OpenAl", OTHER_APP_CALLBACK).clientName, undefined);
  });

  it("hides Gemini spelled with rn for the m", () => {
    assert.equal(identityOf("Gernini", OTHER_APP_CALLBACK).clientName, undefined);
  });

  it("hides a name that mixes Latin with a Cyrillic look-alike", () => {
    assert.equal(identityOf(`${CYRILLIC_ES}laude`, OTHER_APP_CALLBACK).clientName, undefined);
  });

  it("hides Claude spelled with a Latin small alpha", () => {
    assert.equal(identityOf(`Cl${LATIN_SMALL_ALPHA}ude`, OTHER_APP_CALLBACK).clientName, undefined);
  });

  it("hides ChatGPT spelled with a Latin script g", () => {
    assert.equal(identityOf(`chat${LATIN_SCRIPT_G}pt`, OTHER_APP_CALLBACK).clientName, undefined);
  });

  it("hides Claude spelled in Latin small capitals", () => {
    assert.equal(identityOf(LATIN_SMALL_CAPS_CLAUDE, OTHER_APP_CALLBACK).clientName, undefined);
  });

  it("hides the name Claude when the document is served from a subdomain of claude.ai", () => {
    const identity = identityOf("Claude", CLAUDE_CALLBACK, "https://pages.claude.ai/client.json");

    assert.equal(identity.clientName, undefined);
  });

  it("hides a name that adds words around ChatGPT", () => {
    assert.equal(identityOf("Official ChatGPT", OTHER_APP_CALLBACK).clientName, undefined);
  });

  it("shows the name ChatGPT on ChatGPT's own callback and host", () => {
    const identity = identityOf("ChatGPT", CHATGPT_CALLBACK, CHATGPT_CLIENT_ID);

    assert.equal(identity.clientName, "ChatGPT");
  });

  it("shows the name ChatGPT on a per-connector callback served from ChatGPT's host", () => {
    const identity = identityOf("ChatGPT", CHATGPT_PER_CONNECTOR_CALLBACK, CHATGPT_CLIENT_ID);

    assert.equal(identity.clientName, "ChatGPT");
  });

  it("never shows the name Gemini, whose client is pre-registered", () => {
    assert.equal(identityOf("Gemini", CLAUDE_CALLBACK, CLAUDE_CLIENT_ID).clientName, undefined);
  });

  it("shows no name, and does not throw, when a cached document carries a non-string name", () => {
    const poisoned = { ...cimdDoc("x"), client_name: 42 as unknown as string };
    const identity = describeClient({
      clientId: CIMD_CLIENT_ID,
      redirectUri: OTHER_APP_CALLBACK,
      cimdDoc: poisoned,
    });

    assert.deepEqual(identity, { clientHost: "clients.example" });
  });
});

describe("built-in consent page", () => {
  const render = (request: ConsentRequest, options = {}): Promise<string> =>
    renderBuiltInConsent(request, options).text();

  it("leads with the server-controlled host, not the client_id", async () => {
    const html = await render(consentRequest({ clientHost: "clients.example", clientId: "blob" }));

    assert.match(html, /<strong>clients\.example<\/strong> is requesting access to your account\./);
  });

  it("limits form-action to 'self' for a redirect URI that does not parse", () => {
    const response = renderBuiltInConsent(consentRequest({ redirectUri: "not a url" }));

    assert.match(
      response.headers.get("Content-Security-Policy") ?? "",
      /; form-action 'self'; frame-ancestors 'none'$/,
    );
  });

  it("leads with the client_id of a client resolved from clientStore", async () => {
    const registeredClient = {
      clientId: "gemini-enterprise",
      redirectUris: [OTHER_APP_CALLBACK],
      tokenEndpointAuthMethod: "client_secret_basic" as const,
    };
    const html = await render(
      consentRequest({
        clientId: "gemini-enterprise",
        clientHost: "app.example",
        registeredClient,
      }),
    );

    assert.match(html, /<strong>gemini-enterprise<\/strong> is requesting access/);
  });

  it("falls back to a neutral subject when no host is known", async () => {
    const html = await render(consentRequest());

    assert.match(html, /<strong>An application<\/strong>/);
  });

  it("labels the client's name as not verified and escapes it", async () => {
    const html = await render(consentRequest({ clientName: "<b>Acme</b>" }));

    assert.match(html, /<bdi>&lt;b&gt;Acme&lt;\/b&gt;<\/bdi> \(name not verified\)/);
    assert.doesNotMatch(html, /<b>Acme<\/b>/);
  });

  it("shows no name line when the client has no name to show", async () => {
    const html = await render(consentRequest());

    assert.doesNotMatch(html, /name not verified/);
  });

  it("cuts a long client_id to its first 48 characters", async () => {
    const html = await render(consentRequest({ clientId: "A".repeat(500) }));

    assert.match(html, new RegExp(`<dd>${"A".repeat(48)}…</dd>`));
  });

  it("cuts a client_id by code points, never inside a surrogate pair", async () => {
    const html = await render(consentRequest({ clientId: CJK_EXTENSION_B_LETTER.repeat(100) }));

    assert.match(html, new RegExp(`<dd>${CJK_EXTENSION_B_LETTER.repeat(48)}…</dd>`, "u"));
  });

  it("drops bidi and zero-width characters from the displayed client_id", async () => {
    const html = await render(
      consentRequest({ clientId: `id${RIGHT_TO_LEFT_OVERRIDE}${ZERO_WIDTH_SPACE}tail` }),
    );

    assert.match(html, /<dd>idtail<\/dd>/);
  });

  it("names the app and describes the scope when the host configures them", async () => {
    const html = await render(consentRequest(), {
      appName: "Project Desk",
      scopeDescriptions: { mcp: "Read your projects" },
    });

    assert.match(html, /requesting access to Project Desk\./);
    assert.match(html, /<li>mcp — Read your projects<\/li>/);
  });

  it("shows a scope without a description by its name alone", async () => {
    const html = await render(consentRequest({ scope: ["mcp", "write"] }), {
      scopeDescriptions: { mcp: "Read your projects" },
    });

    assert.match(html, /<li>write<\/li>/);
  });

  it("escapes the host-configured app name and scope description", async () => {
    const html = await render(consentRequest(), {
      appName: "<i>Desk</i>",
      scopeDescriptions: { mcp: "<u>all</u>" },
    });

    assert.doesNotMatch(html, /<i>Desk<\/i>|<u>all<\/u>/);
  });
});

describe("consent identity through /authorize", () => {
  const authorize = (
    options: { render?: (input: ConsentRequest) => Response } = {},
    doc: CimdDocument = cimdDoc("Acme"),
  ): Promise<Response | null> => {
    const router = createOAuthRouter({
      cimd: true,
      cimdCache: { get: async () => doc, set: async () => undefined },
      ports: stubPorts(),
      consent: options,
    });
    const url = new URL(`${ORIGIN}/mcp/oauth/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: CIMD_CLIENT_ID,
      redirect_uri: OTHER_APP_CALLBACK,
      code_challenge: VALID_S256_CHALLENGE,
      code_challenge_method: "S256",
      resource: `${ORIGIN}/mcp`,
    }).toString();
    return router.tryHandle(new Request(url, { method: "GET" }));
  };

  it("shows a CIMD client's host first and its name as not verified", async () => {
    const res = await authorize();

    assert.ok(res);
    const html = await res.text();
    assert.match(html, /<strong>clients\.example<\/strong>/);
    assert.match(html, /<bdi>Acme<\/bdi> \(name not verified\)/);
  });

  it("hands a custom render the cleaned name and the host, never the raw name", async () => {
    let seen: { host: string | undefined; name: string | undefined } | undefined;
    const res = await authorize(
      {
        render: (input) => {
          seen = { host: input.clientHost, name: input.clientName };
          return new Response("custom");
        },
      },
      cimdDoc(`Evil${RIGHT_TO_LEFT_OVERRIDE}${ZERO_WIDTH_SPACE} App`),
    );

    assert.ok(res);
    assert.deepEqual(seen, { host: "clients.example", name: "Evil App" });
  });

  it("still renders the consent screen, without the name, when the name claims Claude", async () => {
    const res = await authorize({}, cimdDoc("Claude"));

    assert.ok(res);
    const html = await res.text();
    assert.match(html, /Authorize access/);
    assert.doesNotMatch(html, /name not verified/);
  });
});
