import { JSON_SCHEMA_TYPES } from "./keywords.js";
import { MAX_SCHEMA_DEPTH, MAX_SCHEMA_NODES } from "./limits.js";
import { isLocalRef, nodeInfo } from "./node-info.js";
import { type RefIndex, refIndexFor, resolveRef } from "./refs.js";
import type { SchemaNode } from "./subschema.js";
import type { JsonSchema } from "./types.js";

const labelOf = (path: string, segments: readonly string[], keyword?: string): string =>
  [path, ...segments, ...(keyword === undefined ? [] : [keyword])].join(".");

const withReason = (label: string, reason?: string): string =>
  reason === undefined ? label : `${label} (${reason})`;

const nodeViolations = (node: SchemaNode, index: RefIndex, path: string): string[] => {
  const { schema, segments } = node;
  const own = nodeInfo(schema).problems.map(({ keyword, reason }) =>
    withReason(labelOf(path, segments, keyword), reason),
  );
  const nestedId =
    segments.length > 0 && schema.$id !== undefined
      ? [withReason(labelOf(path, segments, "$id"), "embedded schema resources are not supported")]
      : [];
  const ref = schema.$ref;
  const unresolved =
    typeof ref === "string" && isLocalRef(ref) && resolveRef(index, ref) === undefined
      ? [withReason(labelOf(path, segments, "$ref"), "unresolved $ref")]
      : [];
  return [...own, ...nestedId, ...unresolved];
};

const limitViolation = (index: RefIndex, path: string): string[] => {
  if (!index.limit) return [];
  const { kind, at } = index.limit;
  const reason =
    kind === "depth"
      ? `schema nested deeper than ${MAX_SCHEMA_DEPTH} levels`
      : `schema has more than ${MAX_SCHEMA_NODES} subschemas`;
  return [withReason(labelOf(path, at.segments), reason)];
};

/**
 * Everything that makes a schema unusable by this evaluator, as paths such as
 * `args.properties.code.pattern`, each optionally followed by a short reason in
 * parentheses: unknown keywords (anything outside the evaluated set that is not
 * an annotation or `x-*`), a keyword value of the wrong shape, a `pattern` or
 * `patternProperties` key outside the supported regex subset (invalid, or a backreference,
 * lookaround, `\p{..}`, inline flag or a program over its size bound), a `$schema` other than 2020-12, 2019-09 or
 * draft-07, a draft-07 style keyword whose meaning differs in 2020-12 (`definitions`,
 * `dependencies`, array-form `items`, `$recursiveRef`), a non-local or unresolvable
 * `$ref` (never fetched), a nested `$id`, a duplicate `$anchor`, and a schema over
 * the depth or subschema bounds. Empty means the schema can be evaluated.
 */
export const unsupportedKeywords = (schema: JsonSchema, path = "args"): string[] => {
  const index = refIndexFor(schema);
  return [
    ...index.nodes.flatMap((node) => nodeViolations(node, index, path)),
    ...index.duplicateAnchors.map((node) =>
      withReason(labelOf(path, node.segments, "$anchor"), "duplicate $anchor"),
    ),
    ...limitViolation(index, path),
  ];
};

/** `schema.type` as an array either way — a single type is a union of one. */
const declaredTypesOf = (schema: JsonSchema): string[] =>
  schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];

/** True for a path made only of `properties/<key>` and `items` steps. */
const isPropertiesAndItemsPath = (segments: readonly string[]): boolean => {
  for (let step = 0; step < segments.length; ) {
    if (segments[step] === "properties") step += 2;
    else if (segments[step] === "items") step += 1;
    else return false;
  }
  return true;
};

/**
 * Paths where `properties`/`required` implies an object shape but `type`
 * doesn't say so — absent, or a type/union without `"object"`. Such a
 * schema would otherwise accept any input, `{}` included. Under
 * `validateArgs: true` this throws at construction. Only `properties` and
 * `items` positions are inspected: inside `allOf`, `if`, `$defs` and the like,
 * a bare `required` or `properties` is a normal idiom.
 */
export const missingObjectType = (schema: JsonSchema, path = "args"): string[] =>
  refIndexFor(schema)
    .nodes.filter(({ schema: node, segments }) => {
      if (!isPropertiesAndItemsPath(segments)) return false;
      const impliesObject = node.properties !== undefined || node.required !== undefined;
      return impliesObject && !declaredTypesOf(node).includes(JSON_SCHEMA_TYPES.object);
    })
    .map(({ segments }) => labelOf(path, segments));
