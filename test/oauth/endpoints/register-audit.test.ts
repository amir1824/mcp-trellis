import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OAuthAuditEntry } from "../../../src/oauth/types.js";
import { stubPorts } from "../../helpers/ports.js";
import { createOAuthRouter } from "../../helpers/router.js";
import { DEFAULT_ORIGIN } from "../../helpers/target.js";

const register = async (body: string) => {
  const audits: OAuthAuditEntry[] = [];
  const router = createOAuthRouter({
    allowUnregisteredClients: true,
    ports: stubPorts({ audit: (entry) => void audits.push(entry) }),
  });
  const response = await router.tryHandle(
    new Request(`${DEFAULT_ORIGIN}/mcp/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
  );
  return { status: response?.status, audits };
};

describe("auditing a refused registration", () => {
  it("names the refused redirect URIs without userinfo, query or fragment", async () => {
    const redirectUris = ["https://user:pw@other.test/cb?token=s3cret#frag"];

    const { status, audits } = await register(JSON.stringify({ redirect_uris: redirectUris }));

    assert.equal(status, 400);
    assert.deepEqual(audits, [
      { event: "register_rejected", reason: "no allowed redirect_uris: https://other.test/cb" },
    ]);
  });

  it("records a body that is not a JSON object", async () => {
    const { audits } = await register("not json");

    assert.deepEqual(audits, [
      { event: "register_rejected", reason: "request body must be a JSON object" },
    ]);
  });

  it("lists nothing when no entry is a string", async () => {
    const entry = { toString: 1, valueOf: 1 };

    const { audits } = await register(JSON.stringify({ redirect_uris: [entry] }));

    assert.deepEqual(audits, [{ event: "register_rejected", reason: "no allowed redirect_uris" }]);
  });

  it("records nothing for a registration it accepts", async () => {
    const { status, audits } = await register(
      JSON.stringify({ redirect_uris: ["http://127.0.0.1:4321/cb"] }),
    );

    assert.equal(status, 201);
    assert.deepEqual(audits, []);
  });
});
