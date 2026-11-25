/** `x-mcp-header` on an inputSchema property: where it may appear, and the properties it mirrors into `Mcp-Param-*` headers. */

import { isJsonObject } from "../../../util/json.js";
import type { JsonSchema } from "../../schema/types.js";

const ANNOTATION = "x-mcp-header";
/** RFC 9110 `tchar`: the characters a header field name may hold. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const PRIMITIVE_TYPES: ReadonlySet<string> = new Set(["integer", "string", "boolean"]);
/** Keywords whose value is data, not a subschema: an `x-mcp-header` key inside one is not an annotation. */
const DATA_KEYWORDS: ReadonlySet<string> = new Set(["enum", "const", "default", "examples"]);

/** More annotated properties than this cannot be mirrored: a request would carry more headers than servers accept. */
const MAX_PARAM_HEADERS_PER_TOOL = 16;

export type ParamHeader = { name: string; path: string[] };

type Found = { value: unknown; path: string[]; reachable: boolean; node: Record<string, unknown> };

/** Every annotation, with whether a chain of `properties` keys alone leads to it from the root. */
const walk = (node: unknown, path: string[], reachable: boolean): Found[] => {
  if (Array.isArray(node)) return node.flatMap((item) => walk(item, path, false));
  if (!isJsonObject(node)) return [];
  return Object.entries(node).flatMap(([key, value]) => {
    if (key === ANNOTATION) return [{ value, path, reachable: reachable && path.length > 0, node }];
    if (DATA_KEYWORDS.has(key)) return [];
    if (key === "properties" && reachable && isJsonObject(value)) {
      return Object.entries(value).flatMap(([property, child]) =>
        walk(child, [...path, property], true),
      );
    }
    return walk(value, path, false);
  });
};

const typesOf = (node: Record<string, unknown>): string[] => {
  const { type } = node;
  if (typeof type === "string") return [type];
  return Array.isArray(type)
    ? type.filter((entry): entry is string => typeof entry === "string")
    : [];
};

const primitiveOnly = (node: Record<string, unknown>): boolean => {
  const types = typesOf(node).filter((type) => type !== "null");
  return types.length > 0 && types.every((type) => PRIMITIVE_TYPES.has(type));
};

const where = (path: string[]): string => (path.length > 0 ? path.join(".") : "(schema root)");

const violationOf = ({ value, path, reachable, node }: Found): string | undefined => {
  if (!reachable)
    return `${where(path)}: x-mcp-header is only allowed on a property reached through "properties" alone`;
  if (typeof value !== "string" || !TOKEN.test(value)) {
    return `${where(path)}: x-mcp-header must be a non-empty header token without control characters`;
  }
  if (!primitiveOnly(node))
    return `${where(path)}: x-mcp-header requires type integer, string or boolean`;
  return undefined;
};

/** Every violation of the `x-mcp-header` rules in one tool's inputSchema, each naming the property path. */
const schemaViolations = (schema: JsonSchema): string[] => {
  const found = walk(schema, [], true);
  const seen = new Map<string, string[]>();
  const duplicates = found.flatMap(({ value, path }) => {
    if (typeof value !== "string") return [];
    const key = value.toLowerCase();
    const first = seen.get(key);
    seen.set(key, first ?? path);
    return first
      ? [
          `${where(path)}: x-mcp-header repeats the one at ${where(first)} (names compare case-insensitively)`,
        ]
      : [];
  });
  const tooMany =
    found.length > MAX_PARAM_HEADERS_PER_TOOL
      ? [
          `x-mcp-header is used ${found.length} times, at most ${MAX_PARAM_HEADERS_PER_TOOL} are allowed`,
        ]
      : [];
  return [
    ...found.map(violationOf).filter((text): text is string => text !== undefined),
    ...duplicates,
    ...tooMany,
  ];
};

/** The annotations of a schema that has no violation: header name part and property path. */
export const paramHeadersOf = (schema: JsonSchema): ParamHeader[] =>
  walk(schema, [], true).flatMap(({ value, path }) =>
    typeof value === "string" ? [{ name: value, path }] : [],
  );

/** `schemaViolations` for every tool, each line led by the tool's name. */
export const paramHeaderViolations = (
  tools: ReadonlyArray<{ name: string; inputSchema: JsonSchema }>,
): string[] =>
  tools.flatMap((tool) =>
    schemaViolations(tool.inputSchema).map((line) => `${tool.name}: ${line}`),
  );
