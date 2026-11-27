import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expectOAuthError } from "../../helpers/http.js";
import { stubPorts } from "../../helpers/ports.js";
import { createOAuthRouter } from "../../helpers/router.js";
import { DEFAULT_ORIGIN } from "../../helpers/target.js";

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
