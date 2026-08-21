export const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

/**
 * Answered on `initialize` when the client's requested version is missing
 * or unrecognized. The spec's guidance is to respond with a version the
 * server supports, preferring the latest — not the oldest one, which is
 * what this constant did before.
 */
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/**
 * The assumed protocol version for a request that omits the
 * `MCP-Protocol-Version` header — distinct from `DEFAULT_PROTOCOL_VERSION`
 * above. This is the 2025-06-18 spec's own backwards-compatibility rule
 * for the header specifically (introduced in that revision, so a header-less
 * request predates it), not a "pick the newest" preference.
 */
export const ASSUMED_HEADER_PROTOCOL_VERSION = "2025-03-26";

export const pickProtocolVersion = (params?: Record<string, unknown>): string => {
  const requested = params?.protocolVersion;
  if (typeof requested === "string" && PROTOCOL_VERSIONS.has(requested)) {
    return requested;
  }
  return DEFAULT_PROTOCOL_VERSION;
};
