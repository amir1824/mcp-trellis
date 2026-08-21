import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BodyTooLargeError, readBoundedNodeBody, readBoundedText } from "../../src/body.js";

/** A ReadableStream body with no Content-Length — the chunked-transfer case. */
const chunkedRequest = (chunks: string[]): Request =>
  new Request("https://example.test/x", {
    method: "POST",
    // @ts-expect-error -- Node's fetch Request requires duplex for a stream body.
    duplex: "half",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }),
  });

describe("readBoundedText", () => {
  it("returns the body when it's within the cap", async () => {
    const req = new Request("https://example.test/x", { method: "POST", body: "hello" });
    assert.equal(await readBoundedText(req, 1024), "hello");
  });

  it("rejects on an honest Content-Length over the cap before reading anything", async () => {
    const req = new Request("https://example.test/x", {
      method: "POST",
      headers: { "Content-Length": "1000" },
      body: "x".repeat(10),
    });
    await assert.rejects(readBoundedText(req, 5), BodyTooLargeError);
  });

  it("aborts a chunked body (no Content-Length) once it exceeds the cap", async () => {
    const req = chunkedRequest(["a".repeat(10), "b".repeat(10)]);
    assert.equal(req.headers.get("content-length"), null);
    await assert.rejects(readBoundedText(req, 15), BodyTooLargeError);
  });

  it("accepts a chunked body that stays within the cap", async () => {
    const req = chunkedRequest(["ab", "cd"]);
    assert.equal(await readBoundedText(req, 10), "abcd");
  });

  it("enforces the cap on the request.text() fallback path when body is null", async () => {
    const req = new Request("https://example.test/x", { method: "GET" });
    assert.equal(req.body, null);
    assert.equal(await readBoundedText(req, 10), "");
  });
});

describe("readBoundedNodeBody", () => {
  const asyncChunks = async function* (chunks: string[]) {
    for (const chunk of chunks) yield chunk;
  };

  it("concatenates chunks within the cap", async () => {
    const bytes = await readBoundedNodeBody(asyncChunks(["ab", "cd"]), 10);
    assert.equal(new TextDecoder().decode(bytes), "abcd");
  });

  it("rejects an honest oversized Content-Length before reading any chunk", async () => {
    let yielded = false;
    await assert.rejects(
      readBoundedNodeBody(
        (async function* () {
          yielded = true;
          yield "x";
        })(),
        5,
        { contentLength: "1000" },
      ),
      BodyTooLargeError,
    );
    assert.equal(yielded, false);
  });

  it("aborts mid-stream past the cap without consuming further chunks", async () => {
    let third = false;
    await assert.rejects(
      readBoundedNodeBody(
        (async function* () {
          yield "a".repeat(10);
          yield "b".repeat(10);
          third = true;
          yield "c".repeat(10);
        })(),
        15,
      ),
      BodyTooLargeError,
    );
    assert.equal(third, false);
  });

  it("event-readable path pauses and rejects past the cap without needing destroy", async () => {
    type Listener = (...args: never[]) => void;
    const listeners: Record<string, Listener[]> = { data: [], end: [], error: [] };
    let paused = false;
    const stream = {
      on(event: "data" | "end" | "error", listener: Listener) {
        listeners[event]?.push(listener);
      },
      pause() {
        paused = true;
      },
      removeListener(event: string, listener: Listener) {
        listeners[event] = (listeners[event] ?? []).filter((l) => l !== listener);
      },
    };

    const pending = readBoundedNodeBody(stream, 15);
    for (const listener of listeners.data ?? []) {
      (listener as (chunk: string) => void)("a".repeat(10));
    }
    for (const listener of listeners.data ?? []) {
      (listener as (chunk: string) => void)("b".repeat(10));
    }
    await assert.rejects(pending, BodyTooLargeError);
    assert.equal(paused, true);
    assert.equal((listeners.data ?? []).length, 0);
  });
});
