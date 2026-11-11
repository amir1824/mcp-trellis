/** The upstream call behind `apiTool`: a bounded, abortable fetch and a capped response body. */

import { BodyReadAbortedError, BodyTooLargeError, readBoundedBytes } from "../../http/body.js";
import type { ToolResult } from "../registry.js";
import { anySignal, NOOP } from "./abort-signal.js";

export type ApiRequest = string | URL | Request;

/** See `ApiExtra.redirect`. */
export type RedirectMode = "manual" | "error" | "follow";

const isTimeoutError = (caught: unknown): boolean => {
  if (caught instanceof BodyReadAbortedError) return true;
  return (
    caught instanceof Error && (caught.name === "TimeoutError" || caught.name === "AbortError")
  );
};

const timedOutResult = (timeoutMs: number | false): ToolResult => ({
  content: [
    {
      type: "text",
      text: timeoutMs === false ? "Request timed out" : `Request timed out after ${timeoutMs}ms`,
    },
  ],
  isError: true,
});

const cancelledResult = (): ToolResult => ({
  content: [{ type: "text", text: "Request was cancelled" }],
  isError: true,
});

/**
 * The `ToolResult` for a caller abort or a timeout, or `null` for any other
 * error. A caller abort is checked first and by signal state, not by error
 * shape: `fetch` rejects with the abort *reason*, which is whatever the
 * caller passed to `abort(...)` — not necessarily an `AbortError`.
 */
const abortResult = (
  caught: unknown,
  timeoutMs: number | false,
  callerSignal: AbortSignal | undefined,
): ToolResult | null => {
  if (callerSignal?.aborted) return cancelledResult();
  return isTimeoutError(caught) ? timedOutResult(timeoutMs) : null;
};

export type Fetched = {
  response: Response;
  /** Aborts on the timeout *or* the caller's own signal — governs the body read too. */
  signal?: AbortSignal | undefined;
  callerSignal?: AbortSignal | undefined;
  dispose: () => void;
};

type FetchPlan = {
  fetchImpl: typeof fetch;
  input: ApiRequest;
  timeoutMs: number | false;
  redirect: RedirectMode;
};

/** An aborted or timed-out fetch becomes a `ToolResult`; every other throw still propagates. */
export const fetchWithTimeout = async ({
  fetchImpl,
  input,
  timeoutMs,
  redirect,
}: FetchPlan): Promise<Fetched | ToolResult> => {
  const callerSignal = input instanceof Request ? input.signal : undefined;
  if (timeoutMs === false) {
    // Nothing to combine: `fetch` keeps the `Request`'s own signal, and the
    // same signal is handed to the body read so a later abort stops it too.
    try {
      return {
        response: await fetchImpl(input, { redirect }),
        signal: callerSignal,
        callerSignal,
        dispose: NOOP,
      };
    } catch (caught) {
      const aborted = abortResult(caught, timeoutMs, callerSignal);
      if (aborted) return aborted;
      throw caught;
    }
  }
  // `init.signal` replaces a `Request`'s own signal — combine both so a
  // caller's abort still cancels the call.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = callerSignal
    ? anySignal([timeoutSignal, callerSignal])
    : { signal: timeoutSignal, dispose: NOOP };
  try {
    return {
      response: await fetchImpl(input, { signal: combined.signal, redirect }),
      signal: combined.signal,
      callerSignal,
      dispose: combined.dispose,
    };
  } catch (caught) {
    combined.dispose();
    const aborted = abortResult(caught, timeoutMs, callerSignal);
    if (aborted) return aborted;
    throw caught;
  }
};

/**
 * Capped before `respond`/`onError` ever see it — an unbounded res.text()
 * on the upstream body is the same memory-exhaustion shape an unbounded
 * *incoming* body is (see body.ts). Rebuilt as a fresh Response from the
 * raw bytes — not decoded text — so `respond`/`onError` can still call
 * res.arrayBuffer()/res.blob() on binary bodies as well as res.text()/
 * res.json(), exactly as if they'd read the original response themselves.
 * An oversized body, or the timeout or caller signal firing mid-body, becomes
 * a `ToolResult`; every other throw still propagates.
 */
export const boundResponse = async (
  res: Response,
  maxResponseBytes: number,
  timeoutMs: number | false,
  { signal, callerSignal }: Pick<Fetched, "signal" | "callerSignal">,
): Promise<Response | ToolResult> => {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = (await readBoundedBytes(res, maxResponseBytes, signal)) as Uint8Array<ArrayBuffer>;
  } catch (caught) {
    if (caught instanceof BodyTooLargeError) {
      return {
        content: [{ type: "text", text: `Response exceeded ${maxResponseBytes} bytes` }],
        isError: true,
      };
    }
    const aborted = abortResult(caught, timeoutMs, callerSignal);
    if (aborted) return aborted;
    throw caught;
  }
  // The buffered body is already decoded and re-framed — the upstream
  // encoding/length headers no longer describe it.
  const headers = new Headers(res.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(bytes, { status: res.status, statusText: res.statusText, headers });
};
