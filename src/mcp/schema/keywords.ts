import { isJsonObject } from "../../util/json.js";

export const JSON_SCHEMA_TYPES = {
  string: "string",
  number: "number",
  integer: "integer",
  boolean: "boolean",
  object: "object",
  array: "array",
  null: "null",
} as const;

/** The only dialect evaluated: the default when `$schema` is absent (MCP 2026-07-28). */
export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/**
 * `$schema` values accepted, each with and without the empty fragment: 2020-12, and the
 * two older drafts that schema generators still emit (zod-to-json-schema writes draft-07).
 * Every one is evaluated as 2020-12: a keyword whose meaning differs between the drafts is
 * rejected at construction (`legacyKeywordReason`), and `$ref` siblings, ignored by draft-07,
 * are evaluated, which can only reject more. MCP: "MUST support at least 2020-12 and SHOULD
 * document which additional dialects they support" (basic/index.md, JSON Schema usage).
 */
const ACCEPTED_DIALECTS: readonly string[] = [
  JSON_SCHEMA_DIALECT,
  "https://json-schema.org/draft/2019-09/schema",
  "http://json-schema.org/draft-07/schema",
];

const DIALECT_URIS: ReadonlySet<unknown> = new Set(
  ACCEPTED_DIALECTS.flatMap((uri) => [uri, `${uri}#`]),
);

export const isSupportedDialect = (value: unknown): boolean => DIALECT_URIS.has(value);

const LEGACY_KEYWORDS: ReadonlyMap<string, string> = new Map([
  ["definitions", "draft-07 style keyword; use $defs"],
  ["dependencies", "draft-07 style keyword; use dependentRequired or dependentSchemas"],
  ["additionalItems", "draft-07 style keyword; use items after prefixItems"],
  ["$recursiveRef", "2019-09 style keyword; use $ref"],
  ["$recursiveAnchor", "2019-09 style keyword; use $anchor"],
]);

const TUPLE_ITEMS = "draft-07 style keyword; use prefixItems for a tuple";

/** Why `keyword: value` is a draft-07 / 2019-09 spelling that 2020-12 reads differently; `undefined` when it is not. */
export const legacyKeywordReason = (keyword: string, value: unknown): string | undefined => {
  if (keyword === "items") return Array.isArray(value) ? TUPLE_ITEMS : undefined;
  return LEGACY_KEYWORDS.get(keyword);
};

export const isSubschema = (value: unknown): boolean =>
  typeof value === "boolean" || isJsonObject(value);
const isSubschemaMap = (value: unknown): boolean =>
  isJsonObject(value) && Object.values(value).every(isSubschema);
const isSubschemaList = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0 && value.every(isSubschema);
const isStringList = (value: unknown): boolean =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");
const isCount = (value: unknown): boolean => Number.isInteger(value) && (value as number) >= 0;
const isFiniteNumber = (value: unknown): boolean => Number.isFinite(value);
const isTypeName = (value: unknown): boolean =>
  typeof value === "string" && Object.hasOwn(JSON_SCHEMA_TYPES, value);

const ANCHOR_SYNTAX = /^[A-Za-z_][-A-Za-z0-9._]*$/;

/** Per evaluated keyword: the value shapes it is evaluated in; any other shape is rejected at construction. */
const KEYWORD_SHAPES: ReadonlyMap<string, (value: unknown) => boolean> = new Map([
  ["type", (v) => isTypeName(v) || (Array.isArray(v) && v.length > 0 && v.every(isTypeName))],
  ["enum", Array.isArray],
  ["const", () => true],
  ["properties", isSubschemaMap],
  ["patternProperties", isSubschemaMap],
  ["additionalProperties", isSubschema],
  ["propertyNames", isSubschema],
  ["required", isStringList],
  ["minProperties", isCount],
  ["maxProperties", isCount],
  ["dependentRequired", (v) => isJsonObject(v) && Object.values(v).every(isStringList)],
  ["dependentSchemas", isSubschemaMap],
  ["items", isSubschema],
  ["prefixItems", isSubschemaList],
  ["contains", isSubschema],
  ["minContains", isCount],
  ["maxContains", isCount],
  ["minItems", isCount],
  ["maxItems", isCount],
  ["uniqueItems", (v) => typeof v === "boolean"],
  ["minimum", isFiniteNumber],
  ["maximum", isFiniteNumber],
  ["exclusiveMinimum", isFiniteNumber],
  ["exclusiveMaximum", isFiniteNumber],
  ["multipleOf", (v) => isFiniteNumber(v) && (v as number) > 0],
  ["minLength", isCount],
  ["maxLength", isCount],
  ["pattern", (v) => typeof v === "string"],
  ["allOf", isSubschemaList],
  ["anyOf", isSubschemaList],
  ["oneOf", isSubschemaList],
  ["not", isSubschema],
  ["if", isSubschema],
  ["then", isSubschema],
  ["else", isSubschema],
  ["$ref", (v) => typeof v === "string"],
  ["$defs", isSubschemaMap],
  ["$anchor", (v) => typeof v === "string" && ANCHOR_SYNTAX.test(v)],
]);

/** Keywords `validateAgainstSchema` actually evaluates (`$defs` and `$anchor` only through `$ref`). */
export const SUPPORTED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set(KEYWORD_SHAPES.keys());

/**
 * Allowed on a schema but never evaluated: annotations. `format` is an
 * annotation, not an assertion, as 2020-12 specifies unless the format-assertion
 * vocabulary is in use; enforce formats in the handler or with a `SchemaValidator`.
 * Any `x-*` key (for example `x-mcp-header`) is an annotation too. Semantically
 * enforcing keywords this evaluator does not implement (`unevaluatedProperties`,
 * `$dynamicRef`, `definitions`, …) are not ignored: with `validateArgs: true`
 * they throw at construction. `$schema` and `$id` are checked, not evaluated.
 */
export const IGNORED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "description",
  "title",
  "$schema",
  "$id",
  "$comment",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "format",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
]);

const EXTENSION_PREFIX = "x-";

/** True when `keyword` is accepted without being evaluated. */
export const isAnnotationKeyword = (keyword: string): boolean =>
  IGNORED_SCHEMA_KEYWORDS.has(keyword) || keyword.startsWith(EXTENSION_PREFIX);

/** True when `value` has a shape the evaluator reads; `undefined` when `keyword` is not evaluated. */
export const hasSupportedShape = (keyword: string, value: unknown): boolean | undefined =>
  KEYWORD_SHAPES.get(keyword)?.(value);
