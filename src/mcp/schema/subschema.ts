import { isJsonObject } from "../../util/json.js";
import { isSubschema } from "./keywords.js";
import type { JsonSchema } from "./types.js";

/** The schema `true`: accepts everything. */
export const TRUE_SCHEMA: JsonSchema = Object.freeze({});

/** The schema `false`: accepts nothing. Compared by identity to give a clear message. */
export const FALSE_SCHEMA: JsonSchema = Object.freeze({ not: TRUE_SCHEMA });

/** A subschema position's value as a schema object (`true` / `false` become shared constants). */
export const toSchema = (subschema: JsonSchema | boolean): JsonSchema => {
  if (subschema === true) return TRUE_SCHEMA;
  return subschema === false ? FALSE_SCHEMA : subschema;
};

/** A schema and where it sits: the keyword / key / index steps from the root. */
export type SchemaNode = { schema: JsonSchema; segments: readonly string[] };

const SINGLE_KEYWORDS = [
  "items",
  "additionalProperties",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
];
const LIST_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"];
const MAP_KEYWORDS = ["properties", "patternProperties", "dependentSchemas", "$defs"];

const nodeAt = (value: unknown, parent: SchemaNode, steps: string[]): SchemaNode[] =>
  isSubschema(value)
    ? [
        {
          schema: toSchema(value as JsonSchema | boolean),
          segments: [...parent.segments, ...steps],
        },
      ]
    : [];

/**
 * The direct subschemas of a node, in every position 2020-12 evaluates (the
 * one table both the construction check and `$ref` indexing walk). Malformed
 * positions are skipped here; `nodeInfo` reports them on their own node.
 */
export const childrenOf = (node: SchemaNode): SchemaNode[] => {
  const { schema } = node;
  const single = SINGLE_KEYWORDS.flatMap((key) => nodeAt(schema[key], node, [key]));
  const lists = LIST_KEYWORDS.flatMap((key) => {
    const list = schema[key];
    return Array.isArray(list)
      ? list.flatMap((entry, index) => nodeAt(entry, node, [key, String(index)]))
      : [];
  });
  const maps = MAP_KEYWORDS.flatMap((key) => {
    const map = schema[key];
    return isJsonObject(map)
      ? Object.entries(map).flatMap(([name, entry]) => nodeAt(entry, node, [key, name]))
      : [];
  });
  return [...single, ...lists, ...maps];
};
