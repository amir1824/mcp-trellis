/**
 * Request-body size limits. Nothing upstream caps body size on its own —
 * `request.json()` / `request.text()` and a raw `http.createServer` stream
 * both buffer the whole body in memory first, so an uncapped read is a
 * straightforward memory-exhaustion DoS.
 */

export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/** Default cap for `/mcp` — JSON-RPC payloads, generally small but tool args can be text-heavy. */
export const DEFAULT_MCP_BODY_LIMIT = 1_048_576; // 1 MiB

/** Default cap for OAuth endpoints (`/token`, `/revoke`, `/register`, `/consent`) — tiny form/JSON. */
export const DEFAULT_OAUTH_BODY_LIMIT = 65_536; // 64 KiB

const declaredContentLength = (headers: {
  get: (name: string) => string | null;
}): number | null => {
  const header = headers.get("content-length");
  if (!header) return null;
  const declared = Number(header);
  return Number.isFinite(declared) ? declared : null;
};

const concatBytes = (chunks: Uint8Array[], total: number): Uint8Array => {
  const combined = new Uint8Array(total);
  chunks.reduce((offset, chunk) => {
    combined.set(chunk, offset);
    return offset + chunk.byteLength;
  }, 0);
  return combined;
};

const toBytes = (chunk: Uint8Array | string): Uint8Array =>
  typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;

/**
 * Reads a Web `Request` body as text, rejecting early on an honest
 * oversized `Content-Length`, then aborting mid-stream — before the whole
 * body is buffered — if a chunked body (no `Content-Length`) exceeds
 * `maxBytes`. Falls back to `request.text()` when `request.body` is null
 * (some runtimes don't expose a streaming body), still enforcing the cap.
 */
export const readBoundedText = async (request: Request, maxBytes: number): Promise<string> => {
  const declared = declaredContentLength(request.headers);
  if (declared !== null && declared > maxBytes) {
    throw new BodyTooLargeError(maxBytes);
  }

  const reader = request.body?.getReader();
  if (!reader) {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new BodyTooLargeError(maxBytes);
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // ponytail: one oversized chunk can briefly allocate maxBytes + highWaterMark
      // (~64 KiB on Node) before reject — fine for 1 MiB / 64 KiB caps.
      total += value.byteLength;
      if (total > maxBytes) throw new BodyTooLargeError(maxBytes);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return new TextDecoder().decode(concatBytes(chunks, total));
};

export type BoundedNodeBodyOptions = {
  /** Declared `Content-Length` header value, checked before reading anything. */
  contentLength?: string | undefined;
};

/**
 * Node `IncomingMessage`-shaped readable: event listeners + pause.
 * Prefer this over `for await` — throwing out of `for await` on an
 * IncomingMessage runs the async iterator's `return()`, which **destroys**
 * the request before the caller can write a 413.
 */
export type NodeReadableLike = {
  on(event: "data", listener: (chunk: Uint8Array | string) => void): void;
  on(event: "end", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  pause(): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
};

export const isNodeReadable = (value: unknown): value is NodeReadableLike =>
  typeof (value as { on?: unknown } | null)?.on === "function" &&
  typeof (value as { pause?: unknown } | null)?.pause === "function" &&
  typeof (value as { removeListener?: unknown } | null)?.removeListener === "function";

const readFromEvents = (stream: NodeReadableLike, maxBytes: number): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const collected: Uint8Array[] = [];
    let total = 0;
    let settled = false;

    const onData = (chunk: Uint8Array | string): void => {
      const bytes = toBytes(chunk);
      total += bytes.byteLength;
      if (total > maxBytes) {
        fail(new BodyTooLargeError(maxBytes));
        return;
      }
      collected.push(bytes);
    };

    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(concatBytes(collected, total));
    };

    const onError = (err: Error): void => {
      fail(err);
    };

    const cleanup = (): void => {
      stream.removeListener("data", onData as (...args: unknown[]) => void);
      stream.removeListener("end", onEnd as (...args: unknown[]) => void);
      stream.removeListener("error", onError as (...args: unknown[]) => void);
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      stream.pause();
      cleanup();
      reject(err);
    };

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });

const readFromAsyncIterable = async (
  chunks: AsyncIterable<Uint8Array | string>,
  maxBytes: number,
): Promise<Uint8Array> => {
  const collected: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    const bytes = toBytes(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) throw new BodyTooLargeError(maxBytes);
    collected.push(bytes);
  }
  return concatBytes(collected, total);
};

/**
 * Same contract as `readBoundedText` for a raw Node request stream.
 * Does **not** destroy the socket — that races a 413 response into EPIPE.
 * On overflow the event path pauses and drops listeners; the caller writes
 * 413 then tears down after flush.
 */
export const readBoundedNodeBody = async (
  source: NodeReadableLike | AsyncIterable<Uint8Array | string>,
  maxBytes: number,
  options: BoundedNodeBodyOptions = {},
): Promise<Uint8Array> => {
  const declared = options.contentLength ? Number(options.contentLength) : NaN;
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyTooLargeError(maxBytes);
  }

  if (isNodeReadable(source)) return readFromEvents(source, maxBytes);
  return readFromAsyncIterable(source, maxBytes);
};
