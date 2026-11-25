/** Checks the `Mcp-Param-{Name}` headers of a 2026-07-28 `tools/call` against the arguments in its body. */

import { decodeHeaderValue } from "../../modern/request.js";
import type { JsonSchema } from "../../schema/types.js";
import { type ParamHeader, paramHeadersOf } from "./param-schema.js";

const HEADER_PREFIX = "Mcp-Param-";
/** What RFC 9110 lets a plain header value hold: visible ASCII, space and tab. */
const PLAIN_VALUE = /^[\x20-\x7E\t]*$/;
/** Longest header value looked at, in characters. Anything longer is a mismatch before any decoding. */
export const MAX_PARAM_HEADER_VALUE_LENGTH = 8192;
/**
 * Canonical decimal integer text: `0`, or an optional minus and digits without a leading zero; the
 * spec's `42.0` (equal to `42`) is allowed as a `.0` suffix. No plus sign, no `-0`, no `042`, no `42.000`.
 */
const INTEGER_TEXT = /^(?:0|-?[1-9]\d*)(?:\.0)?$/;
/** A value that starts and ends like the Base64 sentinel; a plain one must have been encoded. */
const SENTINEL_SHAPE = /^=\?base64\?.*\?=$/;

export type ParamHeaderFault = { header: string; reason: "mismatch" | "invalid_characters" };

const valueAt = (args: Record<string, unknown>, path: string[]): unknown =>
  path.reduce<unknown>(
    (node, key) =>
      typeof node === "object" && node !== null && Object.hasOwn(node, key)
        ? (node as Record<string, unknown>)[key]
        : undefined,
    args,
  );

/**
 * The text of a header value after decoding. A value shaped like the sentinel whose inside is not strict
 * Base64 is neither plain nor encoded, so it does not decode: `decodeHeaderValue` hands such a value
 * back unchanged, which is what gives it away.
 */
const decodeParam = (sent: string): string | undefined => {
  const decoded = decodeHeaderValue(sent, true);
  return SENTINEL_SHAPE.test(sent) && decoded === sent ? undefined : decoded;
};

/**
 * Strings are compared exactly and booleans must be lowercase `true`/`false`. An integer must be inside
 * the safe range (the spec: -2^53+1 to 2^53-1) and is compared numerically, never through `Number(text)`
 * alone, which would accept `0x2A`, `1e1` or an empty text.
 */
const matches = (decoded: string, body: unknown): boolean => {
  if (typeof body === "string") return decoded === body;
  if (typeof body === "boolean") return decoded === String(body);
  return (
    typeof body === "number" &&
    Number.isSafeInteger(body) &&
    INTEGER_TEXT.test(decoded) &&
    Number(decoded) === body
  );
};

/** A schema is not changed after the registry is built, so its annotations are found once. */
const PARAMS_BY_SCHEMA = new WeakMap<JsonSchema, ParamHeader[]>();

const cachedParamHeaders = (schema: JsonSchema): ParamHeader[] => {
  const known = PARAMS_BY_SCHEMA.get(schema);
  if (known !== undefined) return known;
  const found = paramHeadersOf(schema);
  PARAMS_BY_SCHEMA.set(schema, found);
  return found;
};

const faultOf = (request: Request, args: Record<string, unknown>, param: ParamHeader) => {
  const header = `${HEADER_PREFIX}${param.name}`;
  const sent = request.headers.get(header);
  const body = valueAt(args, param.path);
  const absent = body === undefined || body === null;
  if (sent === null) return absent ? undefined : { header, reason: "mismatch" as const };
  if (sent.length > MAX_PARAM_HEADER_VALUE_LENGTH) return { header, reason: "mismatch" as const };
  if (!PLAIN_VALUE.test(sent)) return { header, reason: "invalid_characters" as const };
  const decoded = decodeParam(sent);
  return decoded !== undefined && !absent && matches(decoded, body)
    ? undefined
    : { header, reason: "mismatch" as const };
};

/**
 * The first annotated parameter whose header is missing, malformed or different from the body. A value
 * that is null or absent in the body expects no header and must have none. A `Mcp-Param-*` header for a
 * property that is not annotated is never looked at: the spec has intermediaries forward and ignore it.
 * The fault names the header (a name the server chose), never a value from the request.
 *
 * Limitation: `Request.headers.get` joins a header sent twice into `a, b`, so a value that itself holds
 * `, ` cannot be told from two headers. The Node adapter closes this (`toWebRequest` refuses a repeated
 * `Mcp-Param-*`); a host that builds the `Request` itself must reject repeated headers before this runs.
 */
export const paramHeaderFault = (
  request: Request,
  inputSchema: JsonSchema,
  args: Record<string, unknown>,
): ParamHeaderFault | undefined =>
  cachedParamHeaders(inputSchema)
    .map((param) => faultOf(request, args, param))
    .find((fault) => fault !== undefined);

/** The `Mcp-Param-*` names every tool of `tools` can send, once each: what a browser preflight must allow. */
export const paramHeaderNames = (tools: ReadonlyArray<{ inputSchema: JsonSchema }>): string[] => [
  ...new Map(
    tools
      .flatMap((tool) => paramHeadersOf(tool.inputSchema))
      .map(({ name }) => [name.toLowerCase(), `${HEADER_PREFIX}${name}`] as const),
  ).values(),
];
