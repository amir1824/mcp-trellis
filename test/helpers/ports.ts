import type {
  ClientStore,
  MintAccessTokenInput,
  OAuthPorts,
  RegisteredClient,
} from "../../src/oauth/types.js";

/** Deterministic, harness-wide default secret — long enough to pass Phase 1c's assertCodeSecret. */
export const HARNESS_CODE_SECRET = "harness-code-secret-value-32-characters-long";

export type StubPortsOverrides = Partial<OAuthPorts>;

/** A full `OAuthPorts` with sane, deterministic defaults. Override only what a test cares about. */
export const stubPorts = (overrides: StubPortsOverrides = {}): OAuthPorts => ({
  codeSecret: HARNESS_CODE_SECRET,
  resolveUser: async () => ({ id: "harness-user" }),
  loginUrl: (_req, next) => `/login?next=${encodeURIComponent(next)}`,
  mintAccessToken: async ({ userId, scope }) => ({
    accessToken: `minted-${userId}`,
    expiresIn: 3600,
    scope,
  }),
  ...overrides,
});

export type RegisteredClientSeed = RegisteredClient & { secret?: string };

/** In-memory `ClientStore` seeded from a plain array — no test hand-rolls `get`/`verifySecret`. */
export const memoryClientStore = (clients: RegisteredClientSeed[]): ClientStore => {
  const registered = new Map(
    clients.map(({ secret: _secret, ...client }) => [client.clientId, client]),
  );
  const secrets = new Map(clients.map((c) => [c.clientId, c.secret]));
  return {
    get: async (clientId) => registered.get(clientId) ?? null,
    verifySecret: async (clientId, presented) => secrets.get(clientId) === presented,
  };
};

/**
 * Wraps `stubPorts` so `mintAccessToken` calls are recorded for assertion.
 * The HTTP response alone cannot catch a scope/resource-binding regression —
 * the port input is the ground truth for what was actually granted.
 */
export const recordingPorts = (
  overrides: StubPortsOverrides = {},
): { ports: OAuthPorts; mintCalls: MintAccessTokenInput[] } => {
  const mintCalls: MintAccessTokenInput[] = [];
  const base = stubPorts(overrides);
  return {
    mintCalls,
    ports: {
      ...base,
      mintAccessToken: async (input) => {
        mintCalls.push(input);
        return base.mintAccessToken(input);
      },
    },
  };
};
