import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MintAccessTokenInput } from "../../../src/oauth/types.js";
import { authorizeCode, redeem } from "../../helpers/oauth.js";
import { stubPorts } from "../../helpers/ports.js";
import { createOAuthRouter } from "../../helpers/router.js";

const REDIRECT_URI = "http://127.0.0.1:5999/other/cb";

describe("what mintAccessToken is told about a grant", () => {
  it("receives the redirect URI the auth code was bound to", async () => {
    const inputs: MintAccessTokenInput[] = [];
    const router = createOAuthRouter({
      allowUnregisteredClients: true,
      ports: stubPorts({
        mintAccessToken: async (input) => {
          inputs.push(input);
          return { accessToken: "minted", expiresIn: 3600 };
        },
      }),
    });

    await redeem(router, await authorizeCode(router, { redirectUri: REDIRECT_URI }));

    assert.deepEqual(
      inputs.map((input) => input.redirectUri),
      [REDIRECT_URI],
    );
  });
});
