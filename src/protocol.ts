export const PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
]);

export const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

export const pickProtocolVersion = (
  params?: Record<string, unknown>,
): string => {
  const requested = params?.protocolVersion;
  if (typeof requested === "string" && PROTOCOL_VERSIONS.has(requested)) {
    return requested;
  }
  return DEFAULT_PROTOCOL_VERSION;
};
