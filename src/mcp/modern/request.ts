/** Which requests are 2026-07-28 ones, and the checks a request must pass before any method runs. */

import { isJsonObject } from "../../util/json.js";
import { ownValue } from "../../util/own.js";
import type { JsonRpcId, JsonRpcRequest } from "../jsonrpc.js";
import { MODERN_PROTOCOL_VERSION, PROTOCOL_VERSIONS } from "../protocol.js";
import { headerMismatch, invalidMeta, unsupportedVersion } from "./errors.js";
import { type ClientContext, clientContextOf } from "./extensions.js";

const PROTOCOL_VERSION_HEADER = "MCP-Protocol-Version";
const METHOD_HEADER = "Mcp-Method";
const NAME_HEADER = "Mcp-Name";
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

/** What a request that carries the modern header may call anonymously unless the host chose its own list. */
const MODERN_DEFAULT_PUBLIC_METHODS: readonly string[] = ["server/discover"];

/** The legacy handshake and keep-alive: removed in 2026-07-28, so never anonymous under it. */
const NEVER_ANONYMOUS_WHEN_MODERN: ReadonlySet<string> = new Set(["initialize", "ping"]);

/** Methods whose body names a target that `Mcp-Name` must repeat, and the `params` key that holds it. */
const NAME_HEADER_PARAMS: Readonly<Record<string, string>> = {
  "tools/call": "name",
  "resources/read": "uri",
  "skills/get": "uri",
};

const BASE64_WRAPPED_VALUE = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/;

export const resolveModernPublicMethods = (hostList: Set<string> | undefined): Set<string> =>
  new Set(
    (hostList ? [...hostList] : MODERN_DEFAULT_PUBLIC_METHODS).filter(
      (method) => !NEVER_ANONYMOUS_WHEN_MODERN.has(method),
    ),
  );

/** The header decides, and it is known before the body is read: the spec requires it on every POST. */
export const isModernRequest = (request: Request): boolean =>
  request.headers.get(PROTOCOL_VERSION_HEADER) === MODERN_PROTOCOL_VERSION;

const idOf = (envelope: JsonRpcRequest): JsonRpcId => envelope.id ?? null;

const metaOf = (envelope: JsonRpcRequest): Record<string, unknown> => {
  const meta = envelope.params?._meta;
  return isJsonObject(meta) ? meta : {};
};

/**
 * A header value, with the spec's `=?base64?...?=` form for non-ASCII text decoded; `undefined` if it does not decode.
 * `strict` (the `Mcp-Param-*` check) also refuses non-canonical base64 and keeps a leading BOM, so the header and a
 * strict gateway read the same text.
 */
export const decodeHeaderValue = (value: string, strict = false): string | undefined => {
  const match = BASE64_WRAPPED_VALUE.exec(value);
  if (!match) return value;
  try {
    const encoded = match[1] ?? "";
    const binary = atob(encoded);
    if (strict && btoa(binary) !== encoded) return undefined;
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: strict }).decode(bytes);
  } catch {
    return undefined;
  }
};

const standardHeaderError = (request: Request, envelope: JsonRpcRequest): Response | null => {
  const id = idOf(envelope);
  if (request.headers.get(METHOD_HEADER) !== envelope.method) {
    return headerMismatch(id, `${METHOD_HEADER} header does not match the request body`);
  }
  const param = ownValue(NAME_HEADER_PARAMS, envelope.method ?? "");
  const named = param === undefined ? undefined : envelope.params?.[param];
  if (typeof named !== "string") return null;
  const header = request.headers.get(NAME_HEADER);
  if (header === null || decodeHeaderValue(header) !== named) {
    return headerMismatch(id, `${NAME_HEADER} header does not match the request body`);
  }
  return null;
};

/**
 * Null when a request that carries the modern header may be dispatched. Runs before any method, so a
 * header that disagrees with the body can never reach a handler.
 */
export const modernRequestError = (request: Request, envelope: JsonRpcRequest): Response | null => {
  const id = idOf(envelope);
  const meta = metaOf(envelope);
  const version = meta[META_PROTOCOL_VERSION];
  if (typeof version !== "string") {
    return invalidMeta(id, `Missing required _meta field: ${META_PROTOCOL_VERSION}`);
  }
  if (!isJsonObject(meta[META_CLIENT_CAPABILITIES])) {
    return invalidMeta(id, `Missing required _meta field: ${META_CLIENT_CAPABILITIES}`);
  }
  if (version !== MODERN_PROTOCOL_VERSION) {
    return headerMismatch(
      id,
      "MCP-Protocol-Version header does not match the _meta protocol version",
    );
  }
  return standardHeaderError(request, envelope);
};

/** The declared extensions of a request `modernRequestError` accepted; malformed ones are left out. */
export const modernClientOf = (envelope: JsonRpcRequest): ClientContext => {
  const capabilities = metaOf(envelope)[META_CLIENT_CAPABILITIES];
  return clientContextOf(isJsonObject(capabilities) ? capabilities : {});
};

/**
 * A request whose header and `_meta` both name a version this server lacks gets `-32022`, except
 * `initialize`, which has always ignored the header. Only a client that sends the 2026-07-28 `_meta` key
 * can hit this; every other request with an unknown version header keeps the older answer.
 */
export const unsupportedModernVersionError = (
  request: Request,
  envelope: JsonRpcRequest,
): Response | null => {
  const header = request.headers.get(PROTOCOL_VERSION_HEADER);
  if (header === null || header === MODERN_PROTOCOL_VERSION || PROTOCOL_VERSIONS.has(header)) {
    return null;
  }
  if (envelope.method === "initialize") return null;
  return metaOf(envelope)[META_PROTOCOL_VERSION] === header
    ? unsupportedVersion(idOf(envelope), header)
    : null;
};
