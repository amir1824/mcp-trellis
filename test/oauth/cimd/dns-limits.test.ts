/**
 * The default CIMD resolver is bounded: each lookup runs under a timeout and only a few
 * run at once, because `/authorize` reaches it before any session check.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLimitedLookup } from "../../../src/oauth/cimd/dns.js";
import { CimdError } from "../../../src/oauth/cimd/failure.js";

const PUBLIC_ADDRESS = "203.0.113.10";
const NEVER_ANSWERS = (): Promise<string[]> => new Promise(() => undefined);

type Pending = { answer: Promise<string[]>; finish: () => void };

const pendingLookup = (): Pending => {
  let finish = () => {};
  const answer = new Promise<string[]>((resolve) => {
    finish = () => resolve([PUBLIC_ADDRESS]);
  });
  return { answer, finish };
};

const dnsFailure = (message: string) => (caught: unknown) =>
  caught instanceof CimdError && caught.code === "dns_failed" && caught.message === message;

describe("createLimitedLookup", () => {
  it("returns the resolver's addresses", async () => {
    const lookup = createLimitedLookup(async () => [PUBLIC_ADDRESS], {
      maxConcurrent: 2,
      timeoutMs: 1000,
    });

    assert.deepEqual(await lookup("clients.example"), [PUBLIC_ADDRESS]);
  });

  it("gives up on a resolver that never answers", async () => {
    const lookup = createLimitedLookup(NEVER_ANSWERS, { maxConcurrent: 2, timeoutMs: 20 });

    await assert.rejects(lookup("slow.example"), dnsFailure("DNS resolution timed out (ETIMEOUT)"));
  });

  it("refuses a new lookup at once when the limit is reached", async () => {
    const running = pendingLookup();
    const lookup = createLimitedLookup(() => running.answer, { maxConcurrent: 1, timeoutMs: 1000 });
    const first = lookup("a.example");

    await assert.rejects(lookup("b.example"), dnsFailure("DNS resolution busy (EBUSY)"));

    running.finish();
    await first;
  });

  it("admits a new lookup once the running one has finished", async () => {
    const running = pendingLookup();
    const lookup = createLimitedLookup(() => running.answer, { maxConcurrent: 1, timeoutMs: 1000 });
    const first = lookup("a.example");
    running.finish();
    await first;

    assert.deepEqual(await lookup("b.example"), [PUBLIC_ADDRESS]);
  });

  it("frees its slot when the resolver fails", async () => {
    const lookup = createLimitedLookup(
      async () => {
        throw new CimdError("dns_failed", "DNS resolution failed (ENOTFOUND)");
      },
      { maxConcurrent: 1, timeoutMs: 1000 },
    );
    await assert.rejects(lookup("a.example"));

    await assert.rejects(lookup("b.example"), dnsFailure("DNS resolution failed (ENOTFOUND)"));
  });

  it("frees its slot after a timeout", async () => {
    const lookup = createLimitedLookup(NEVER_ANSWERS, { maxConcurrent: 1, timeoutMs: 10 });
    await assert.rejects(lookup("a.example"));

    await assert.rejects(lookup("b.example"), dnsFailure("DNS resolution timed out (ETIMEOUT)"));
  });
});
