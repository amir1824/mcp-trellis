import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolRegistry } from "../src/registry.js";
import { apiTool, defineTool, type StandardSchemaV1 } from "../src/tools.js";

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
});
