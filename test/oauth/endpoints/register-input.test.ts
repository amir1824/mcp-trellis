import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seal } from "../../../src/oauth/crypto/sealed.js";
import { expectOAuthError } from "../../helpers/http.js";
import { authorizeCode, redeem } from "../../helpers/oauth.js";
import { stubPorts } from "../../helpers/ports.js";
import { createOAuthRouter } from "../../helpers/router.js";
import { DEFAULT_ORIGIN } from "../../helpers/target.js";

const SECRET = "register-input-secret-value-32-characters!";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const register = async (redirectUris: unknown[]) => {
  const router = createOAuthRouter({ ports: stubPorts() });
  const response = await router.tryHandle(
    new Request(`${DEFAULT_ORIGIN}/mcp/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: redirectUris }),
    }),
  );
  assert.ok(response);
  return response;
};

const authorize = async (
  clientId: string,
  redirectUri: string,
  ports = stubPorts({ codeSecret: SECRET }),
) => {
  const router = createOAuthRouter({ ports });
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    resource: `${DEFAULT_ORIGIN}/mcp`,
  });
  const response = await router.tryHandle(
    new Request(`${DEFAULT_ORIGIN}/mcp/oauth/authorize?${query}`),
  );
  assert.ok(response);
  return response;
};

describe("/register with redirect_uris entries that are not strings", () => {
  it("answers 400, not 500, to an entry that cannot be turned into text", async () => {
    const response = await register([{ toString: 1, valueOf: 1 }]);

    await expectOAuthError(response, 400, "invalid_redirect_uri");
  });

  it("does not register a URI wrapped in a nested array", async () => {
    const response = await register([["http://127.0.0.1:9111/cb"]]);

    await expectOAuthError(response, 400, "invalid_redirect_uri");
  });
});

describe("a redirect URI holding a plain space", () => {
  const spaced = "http://127.0.0.1:9111/c b";

  it("is still registered as sent", async () => {
    const response = await register([spaced]);

    assert.equal(response.status, 201);
  });

  it("still gets through authorize, consent and token", async () => {
    const router = createOAuthRouter({ allowUnregisteredClients: true, ports: stubPorts() });

    const response = await redeem(router, await authorizeCode(router, { redirectUri: spaced }));

    assert.equal(response.status, 200);
  });
});

describe("redirect URIs holding control or invisible characters", () => {
  it("does not register one with a line break", async () => {
    const response = await register(["http://127.0.0.1:9111/cb\r\nverified"]);

    await expectOAuthError(response, 400, "invalid_redirect_uri");
  });

  it("does not register one with a bidi override", async () => {
    const response = await register(["http://127.0.0.1:9111/cb‮"]);

    await expectOAuthError(response, 400, "invalid_redirect_uri");
  });

  it("does not authorize one that is on the loopback allowlist", async () => {
    const response = await authorize("unbound-client", "http://127.0.0.1:9111/c\tb");

    await expectOAuthError(response, 400, "invalid_request");
  });

  it("does not authorize one that clientStore lists", async () => {
    const redirectUri = "https://app.test/cb\tverified";
    const ports = stubPorts({
      clientStore: {
        get: async (clientId) => ({
          clientId,
          redirectUris: [redirectUri],
          tokenEndpointAuthMethod: "none",
        }),
      },
    });

    const response = await authorize("stored-client", redirectUri, ports);

    await expectOAuthError(response, 400, "invalid_request");
  });

  it("does not authorize one already sealed into a client_id", async () => {
    const redirectUri = "http://127.0.0.1:9111/cb\nverified";
    const clientId = await seal(SECRET, "client", { redirectUris: [redirectUri] });

    const response = await authorize(clientId, redirectUri);

    await expectOAuthError(response, 400, "invalid_request");
  });
});
