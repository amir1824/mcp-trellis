import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolRegistry } from "../../src/mcp/registry.js";
import { apiTool, defineTool, type StandardSchemaV1 } from "../../src/mcp/tools.js";

type Ctx = Record<string, never>;
type WeatherArgs = { city: string };

/**
 * A hand-rolled Standard Schema (https://standardschema.dev) implementation —
 * proves `defineTool`/`apiTool` work with *any* compliant validator, not just
 * a specific library like Zod or Valibot.
 */
const weatherSchema: StandardSchemaV1<unknown, WeatherArgs> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => {
      const city = (value as { city?: unknown } | null)?.city;
      return typeof city === "string" && city.length > 0
        ? { value: { city } }
        : { issues: [{ message: "city is required", path: [{ key: "city" }] }] };
    },
  },
};

/** Same contract, but `validate` resolves asynchronously. */
const asyncWeatherSchema: StandardSchemaV1<unknown, WeatherArgs> = {
  "~standard": {
    version: 1,
    vendor: "test-async",
    validate: async (value) => weatherSchema["~standard"].validate(value),
  },
};

describe("defineTool", () => {
  it("passes raw args through unchanged when input is omitted", async () => {
    const tool = defineTool<Ctx>({
      name: "echo",
      description: "echo",
      inputSchema: { type: "object", properties: {} },
      handler: (_ctx, args) => String((args as { text?: string }).text ?? ""),
    });
    const registry = createToolRegistry<Ctx>([tool]);
    const result = await registry.call("echo", {}, { text: "hi" });
    assert.equal(result.content[0]?.text, "hi");
  });

  it("does not type unvalidated args as Input", () => {
    // @ts-expect-error Input generic requires `input`
    defineTool<Ctx, WeatherArgs>({
      name: "get_weather",
      description: "weather",
      inputSchema: { type: "object", properties: {} },
      handler: (_ctx, args: WeatherArgs) => args.city,
    });
  });

  it("parses and types args via a Standard Schema before calling handler", async () => {
    const tool = defineTool<Ctx, WeatherArgs>({
      name: "get_weather",
      description: "weather",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
      input: weatherSchema,
      handler: (_ctx, args) => `sunny in ${args.city}`,
    });
    const registry = createToolRegistry<Ctx>([tool]);
    const result = await registry.call("get_weather", {}, { city: "Tel Aviv" });
    assert.equal(result.isError, false);
    assert.equal(result.content[0]?.text, "sunny in Tel Aviv");
  });

  it("supports an async validate() the same way", async () => {
    const tool = defineTool<Ctx, WeatherArgs>({
      name: "get_weather",
      description: "weather",
      inputSchema: { type: "object", properties: {} },
      input: asyncWeatherSchema,
      handler: (_ctx, args) => `sunny in ${args.city}`,
    });
    const registry = createToolRegistry<Ctx>([tool]);
    const result = await registry.call("get_weather", {}, { city: "Haifa" });
    assert.equal(result.content[0]?.text, "sunny in Haifa");
  });

  it("returns isError with the issues and never calls handler on invalid args", async () => {
    let called = false;
    const tool = defineTool<Ctx, WeatherArgs>({
      name: "get_weather",
      description: "weather",
      inputSchema: { type: "object", properties: {} },
      input: weatherSchema,
      handler: (_ctx, args) => {
        called = true;
        return `sunny in ${args.city}`;
      },
    });
    const registry = createToolRegistry<Ctx>([tool]);
    const result = await registry.call("get_weather", {}, {});
    assert.equal(result.isError, true);
    assert.equal(result.content[0]?.text, "city: city is required");
    assert.equal(called, false);
  });
});

describe("apiTool", () => {
  const fakeFetch =
    (response: Response): typeof fetch =>
    async () =>
      response;

  it("keeps binary response bytes intact for respond", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x80]);
    const tool = apiTool<Ctx>({
      name: "get_image",
      description: "image",
      inputSchema: { type: "object", properties: {} },
      request: () => "https://api.example.test/image",
      fetch: fakeFetch(
        new Response(bytes, {
          status: 200,
          headers: { "Content-Type": "image/jpeg", "Content-Length": "5" },
        }),
      ),
      respond: async (res) => Array.from(new Uint8Array(await res.arrayBuffer())).join(","),
    });
    const registry = createToolRegistry<Ctx>([tool]);
    const result = await registry.call("get_image", {}, {});
    assert.equal(result.content[0]?.text, "255,216,255,0,128");
  });

  it("returns the response body as text by default", async () => {
    const tool = apiTool<Ctx, WeatherArgs>({
      name: "get_weather",
      description: "weather",
      inputSchema: { type: "object", properties: {} },
      input: weatherSchema,
      request: (_ctx, args) => `https://api.example.test/weather?city=${args.city}`,
      fetch: fakeFetch(new Response("22C and sunny", { status: 200 })),
    });
    const registry = createToolRegistry<Ctx>([tool]);
    const result = await registry.call("get_weather", {}, { city: "Eilat" });
    assert.equal(result.isError, false);
    assert.equal(result.content[0]?.text, "22C and sunny");
  });

  it("shapes a successful response via respond", async () => {
    const tool = apiTool<Ctx, WeatherArgs>({
      name: "get_weather",
      description: "weather",
      inputSchema: { type: "object", properties: {} },
      input: weatherSchema,
      request: (_ctx, args) => `https://api.example.test/weather?city=${args.city}`,
      respond: async (res) => {
        const data = (await res.json()) as { tempC: number };
        return `${data.tempC}°C`;
      },
      fetch: fakeFetch(
        new Response(JSON.stringify({ tempC: 19 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    });
    const registry = createToolRegistry<Ctx>([tool]);
    const result = await registry.call("get_weather", {}, { city: "Eilat" });
    assert.equal(result.content[0]?.text, "19°C");
  });

  it("turns a non-2xx response into isError with status only, never the upstream body", async () => {
    const tool = apiTool<Ctx, WeatherArgs>({
      name: "get_weather",
      description: "weather",
      inputSchema: { type: "object", properties: {} },
      input: weatherSchema,
      request: (_ctx, args) => `https://api.example.test/weather?city=${args.city}`,
      fetch: fakeFetch(
        new Response("internal error: user secret-token-abc leaked in this body", {
          status: 404,
          statusText: "Not Found",
        }),
      ),
    });
    const registry = createToolRegistry<Ctx>([tool]);
    const result = await registry.call("get_weather", {}, { city: "Nowhere" });
    assert.equal(result.isError, true);
    assert.equal(result.content[0]?.text, "Request failed: 404 Not Found");
    assert.doesNotMatch(result.content[0]?.text ?? "", /secret-token/);
  });

  it("routes a non-2xx response through onError when supplied, instead of the default", async () => {
    const seen: number[] = [];
    const tool = apiTool<Ctx, WeatherArgs>({
      name: "get_weather",
      description: "weather",
      inputSchema: { type: "object", properties: {} },
      input: weatherSchema,
      request: (_ctx, args) => `https://api.example.test/weather?city=${args.city}`,
      fetch: fakeFetch(new Response("upstream detail", { status: 503, statusText: "Unavailable" })),
      onError: async (res) => {
        seen.push(res.status);
        return { content: [{ type: "text", text: `custom: ${await res.text()}` }], isError: true };
      },
    });
    const registry = createToolRegistry<Ctx>([tool]);
    const result = await registry.call("get_weather", {}, { city: "Nowhere" });
    assert.deepEqual(seen, [503]);
    assert.equal(result.isError, true);
    assert.equal(result.content[0]?.text, "custom: upstream detail");
  });

  it("never calls fetch when input validation fails", async () => {
    let fetchCalled = false;
    const tool = apiTool<Ctx, WeatherArgs>({
      name: "get_weather",
      description: "weather",
      inputSchema: { type: "object", properties: {} },
      input: weatherSchema,
      request: (_ctx, args) => `https://api.example.test/weather?city=${args.city}`,
      fetch: (async () => {
        fetchCalled = true;
        return new Response("unreachable");
      }) as typeof fetch,
    });
    const registry = createToolRegistry<Ctx>([tool]);
    const result = await registry.call("get_weather", {}, {});
    assert.equal(result.isError, true);
    assert.equal(fetchCalled, false);
  });

  it("passes an AbortSignal.timeout to fetch by default", async () => {
    let sawSignal: AbortSignal | undefined;
    const tool = apiTool<Ctx, WeatherArgs>({
      name: "get_weather",
      description: "weather",
      inputSchema: { type: "object", properties: {} },
      input: weatherSchema,
      request: (_ctx, args) => `https://api.example.test/weather?city=${args.city}`,
      fetch: (async (_input, init) => {
        sawSignal = init?.signal ?? undefined;
        return new Response("22C");
      }) as typeof fetch,
    });
    const registry = createToolRegistry<Ctx>([tool]);
    await registry.call("get_weather", {}, { city: "Eilat" });
    assert.ok(sawSignal instanceof AbortSignal);
  });

  it("does not pass a signal when timeoutMs: false", async () => {
    let sawInit: RequestInit | undefined;
    const tool = apiTool<Ctx, WeatherArgs>({
      name: "get_weather",
      description: "weather",
      inputSchema: { type: "object", properties: {} },
      input: weatherSchema,
      request: (_ctx, args) => `https://api.example.test/weather?city=${args.city}`,
      timeoutMs: false,
      fetch: (async (_input, init) => {
        sawInit = init;
        return new Response("22C");
      }) as typeof fetch,
    });
    const registry = createToolRegistry<Ctx>([tool]);
    await registry.call("get_weather", {}, { city: "Eilat" });
    assert.equal(sawInit, undefined);
  });

  it("returns isError: true with a clear message when the upstream request times out", async () => {
    // Faithful to what a real `fetch` throws when an AbortSignal.timeout()
    // signal fires (a TimeoutError DOMException) — simulated directly
    // rather than racing a real timer, so the test is deterministic.
    const tool = apiTool<Ctx, WeatherArgs>({
      name: "get_weather",
      description: "weather",
      inputSchema: { type: "object", properties: {} },
      input: weatherSchema,
      request: (_ctx, args) => `https://api.example.test/weather?city=${args.city}`,
      timeoutMs: 5,
      fetch: (async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }) as typeof fetch,
    });
    const registry = createToolRegistry<Ctx>([tool]);
    const result = await registry.call("get_weather", {}, { city: "Eilat" });
    assert.equal(result.isError, true);
    assert.equal(result.content[0]?.text, "Request timed out after 5ms");
  });

  it("actually aborts a real fetch call once timeoutMs elapses", async () => {
    // End-to-end with real AbortSignal.timeout + a fetch stub that honors
    // the signal like a real implementation would — the previous test
    // covers the DOMException handling in isolation; this one proves the
    // signal is actually wired through to fetchImpl.
    const tool = apiTool<Ctx, WeatherArgs>({
      name: "get_weather",
      description: "weather",
      inputSchema: { type: "object", properties: {} },
      input: weatherSchema,
      request: (_ctx, args) => `https://api.example.test/weather?city=${args.city}`,
      timeoutMs: 5,
      fetch: ((_input, init) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response("too slow")), 10_000);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(init.signal?.reason);
          });
        })) as typeof fetch,
    });
    const registry = createToolRegistry<Ctx>([tool]);
    const result = await registry.call("get_weather", {}, { city: "Eilat" });
    assert.equal(result.isError, true);
    assert.equal(result.content[0]?.text, "Request timed out after 5ms");
  });

  it("reports a timeout that fires while the response body is still streaming", async () => {
    // Headers arrive at once; the body stalls past timeoutMs. A real fetch
    // errors the body stream with the signal's TimeoutError, which must not
    // fall through to the redacted "Tool execution failed".
    const tool = apiTool<Ctx, WeatherArgs>({
      name: "get_weather",
      description: "weather",
      inputSchema: { type: "object", properties: {} },
      input: weatherSchema,
      request: (_ctx, args) => `https://api.example.test/weather?city=${args.city}`,
      timeoutMs: 5,
      fetch: (async (_input, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              controller.enqueue(new TextEncoder().encode("partial"));
              // Stands in for the open socket: AbortSignal.timeout's timer is
              // unref'd and would not keep the event loop alive by itself.
              const socket = setTimeout(() => controller.close(), 10_000);
              init?.signal?.addEventListener("abort", () => {
                clearTimeout(socket);
                controller.error(init.signal?.reason);
              });
            },
          }),
        )) as typeof fetch,
    });
    const registry = createToolRegistry<Ctx>([tool]);
    const result = await registry.call("get_weather", {}, { city: "Eilat" });
    assert.equal(result.isError, true);
    assert.equal(result.content[0]?.text, "Request timed out after 5ms");
  });

  it("caps the response body at maxResponseBytes, surfacing isError: true instead of a thrown exception", async () => {
    const tool = apiTool<Ctx, WeatherArgs>({
      name: "get_weather",
      description: "weather",
      inputSchema: { type: "object", properties: {} },
      input: weatherSchema,
      request: (_ctx, args) => `https://api.example.test/weather?city=${args.city}`,
      maxResponseBytes: 8,
      fetch: fakeFetch(new Response("this response is way over the byte cap", { status: 200 })),
    });
    const registry = createToolRegistry<Ctx>([tool]);
    const result = await registry.call("get_weather", {}, { city: "Eilat" });
    assert.equal(result.isError, true);
    assert.equal(result.content[0]?.text, "Response exceeded 8 bytes");
  });

  it("still delivers a response within maxResponseBytes normally", async () => {
    const tool = apiTool<Ctx, WeatherArgs>({
      name: "get_weather",
      description: "weather",
      inputSchema: { type: "object", properties: {} },
      input: weatherSchema,
      request: (_ctx, args) => `https://api.example.test/weather?city=${args.city}`,
      maxResponseBytes: 1024,
      fetch: fakeFetch(new Response("22C and sunny", { status: 200 })),
    });
    const registry = createToolRegistry<Ctx>([tool]);
    const result = await registry.call("get_weather", {}, { city: "Eilat" });
    assert.equal(result.isError, false);
    assert.equal(result.content[0]?.text, "22C and sunny");
  });

  it("still forwards status/headers correctly to respond/onError after the size-capped rebuild", async () => {
    const tool = apiTool<Ctx, WeatherArgs>({
      name: "get_weather",
      description: "weather",
      inputSchema: { type: "object", properties: {} },
      input: weatherSchema,
      request: (_ctx, args) => `https://api.example.test/weather?city=${args.city}`,
      respond: async (res) => {
        assert.equal(res.headers.get("content-type"), "application/json");
        const data = (await res.json()) as { tempC: number };
        return `${data.tempC}°C`;
      },
      fetch: fakeFetch(
        new Response(JSON.stringify({ tempC: 19 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    });
    const registry = createToolRegistry<Ctx>([tool]);
    const result = await registry.call("get_weather", {}, { city: "Eilat" });
    assert.equal(result.content[0]?.text, "19°C");
  });
});
