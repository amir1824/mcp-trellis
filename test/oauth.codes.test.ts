import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  issueAuthCode,
  consumeAuthCode,
} from "../src/oauth/codes.js";
import { CLAUDE_CALLBACK } from "../src/oauth/redirect.js";

describe("HMAC auth codes", () => {
  const secret = "test-hmac-secret-key";

  it("issues and consumes a valid code", async () => {
    const code = await issueAuthCode(secret, {
      clientId: "c1",
      redirectUri: CLAUDE_CALLBACK,
      codeChallenge: "challenge",
      userId: "user-1",
    });
    const record = await consumeAuthCode(secret, code);
    assert.ok(record);
    assert.equal(record.userId, "user-1");
    assert.equal(record.clientId, "c1");
  });

  it("rejects tampered code", async () => {
    const code = await issueAuthCode(secret, {
      clientId: "c1",
      redirectUri: CLAUDE_CALLBACK,
      codeChallenge: "challenge",
      userId: "user-1",
    });
    const tampered = code.slice(0, -4) + "xxxx";
    assert.equal(await consumeAuthCode(secret, tampered), null);
  });

  it("rejects expired code", async () => {
    const code = await issueAuthCode(
      secret,
      {
        clientId: "c1",
        redirectUri: CLAUDE_CALLBACK,
        codeChallenge: "challenge",
        userId: "user-1",
      },
      Date.now() - 700_000,
    );
    assert.equal(await consumeAuthCode(secret, code), null);
  });

  it("enforces single-use via codeStore", async () => {
    const used = new Set<string>();
    const codeStore = {
      consume: (jti: string, _expMs: number) => {
        if (used.has(jti)) return false;
        used.add(jti);
        return true;
      },
    };
    const code = await issueAuthCode(secret, {
      clientId: "c1",
      redirectUri: CLAUDE_CALLBACK,
      codeChallenge: "challenge",
      userId: "user-1",
    });
    assert.ok(await consumeAuthCode(secret, code, { codeStore }));
    assert.equal(await consumeAuthCode(secret, code, { codeStore }), null);
  });

  it("enforces single-use by default without codeStore", async () => {
    const code = await issueAuthCode(secret, {
      clientId: "c1",
      redirectUri: CLAUDE_CALLBACK,
      codeChallenge: "challenge",
      userId: "user-1",
    });
    assert.ok(await consumeAuthCode(secret, code));
    assert.equal(await consumeAuthCode(secret, code), null);
  });
});
