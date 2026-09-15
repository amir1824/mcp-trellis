import { isJsonObject } from "../../util/json.js";
import { MAX_CLIENT_REDIRECT_URIS } from "../constants.js";
import { isLoopbackHostname } from "./cimd-ssrf.js";
import type { CimdDocument } from "./types.js";

const DEFAULT_CACHE_SECONDS = 300;
const MAX_CACHE_SECONDS = 3600;

export const parseCacheMaxAge = (header: string | null): number => {
  const maxAge = header ? /(?:^|,)\s*max-age=(\d+)/i.exec(header)?.[1] : undefined;
  return maxAge === undefined ? DEFAULT_CACHE_SECONDS : Math.min(Number(maxAge), MAX_CACHE_SECONDS);
};

const assertHttpRedirectUri = (uri: string): void => {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("CIMD redirect_uris entries must be absolute URLs");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error("CIMD redirect_uris must not carry credentials or a fragment");
  }
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:") {
    if (!isLoopbackHostname(parsed.hostname)) {
      throw new Error("CIMD http redirect_uris must be loopback (127.0.0.1 / ::1)");
    }
    return;
  }
  throw new Error("CIMD redirect_uris must be http(s)");
};

const parseRedirectUris = (rawUris: unknown): string[] => {
  if (!Array.isArray(rawUris) || rawUris.length === 0) {
    throw new Error("CIMD document must include a non-empty redirect_uris array");
  }
  if (rawUris.length > MAX_CLIENT_REDIRECT_URIS) {
    throw new Error(`CIMD redirect_uris must have at most ${MAX_CLIENT_REDIRECT_URIS} entries`);
  }
  return rawUris.map((u) => {
    if (typeof u !== "string" || !u) throw new Error("CIMD redirect_uris entries must be strings");
    assertHttpRedirectUri(u);
    return u;
  });
};

export const parseDocument = (clientId: string, text: string): CimdDocument => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("CIMD document is not JSON");
  }
  if (!isJsonObject(parsed)) throw new Error("CIMD document must be a JSON object");
  const record = parsed;
  if (record.client_id !== clientId) {
    throw new Error("CIMD document client_id must equal the request URL exactly");
  }
  const authMethod = record.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== "none") {
    throw new Error("CIMD clients must be public (token_endpoint_auth_method none)");
  }
  return {
    client_id: clientId,
    redirect_uris: parseRedirectUris(record.redirect_uris),
    ...(typeof record.client_name === "string" ? { client_name: record.client_name } : {}),
    token_endpoint_auth_method: "none",
  };
};
