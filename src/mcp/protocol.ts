export const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);

/**
 * Answered on `initialize` when the client's requested version is missing or unrecognized.
 * ponytail: the spec says this SHOULD be the latest supported version; it stays one behind so
 * those answers do not change for existing hosts. Move it to 2025-11-25 in a release that says so.
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

/**
 * The 2026-07-28 revision is selected per request by its `MCP-Protocol-Version` header, never by
 * `initialize`, so it stays out of `PROTOCOL_VERSIONS` (exported, and what `initialize` negotiates).
 */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";

export const PROTOCOL_VERSION_HEADER = "MCP-Protocol-Version";
