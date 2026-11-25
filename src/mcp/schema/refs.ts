import { MAX_SCHEMA_DEPTH, MAX_SCHEMA_NODES } from "./limits.js";
import { isLocalRef } from "./node-info.js";
import { childrenOf, type SchemaNode } from "./subschema.js";
import type { JsonSchema } from "./types.js";

/** Every subschema of one schema document and the local `$ref` targets inside it. */
export type RefIndex = {
  /** Pre-order: parents before children. */
  nodes: readonly SchemaNode[];
  byPointer: ReadonlyMap<string, JsonSchema>;
  anchors: ReadonlyMap<string, string>;
  duplicateAnchors: readonly SchemaNode[];
  /** Set when the walk stopped early; `at` is the first subschema left unvisited. */
  limit?: { kind: "depth" | "nodes"; at: SchemaNode };
};

const escapeStep = (step: string): string => step.replaceAll("~", "~0").replaceAll("/", "~1");

/** RFC 6901 pointer of a node; the root is the empty string. */
export const pointerOf = (segments: readonly string[]): string =>
  segments.map((step) => `/${escapeStep(step)}`).join("");

type Collected = { nodes: SchemaNode[]; limit?: RefIndex["limit"] };

const collect = (node: SchemaNode, depth: number, out: Collected): void => {
  if (out.limit) return;
  if (depth > MAX_SCHEMA_DEPTH) {
    out.limit = { kind: "depth", at: node };
    return;
  }
  if (out.nodes.length >= MAX_SCHEMA_NODES) {
    out.limit = { kind: "nodes", at: node };
    return;
  }
  out.nodes.push(node);
  for (const child of childrenOf(node)) collect(child, depth + 1, out);
};

const buildIndex = (root: JsonSchema): RefIndex => {
  const collected: Collected = { nodes: [] };
  collect({ schema: root, segments: [] }, 0, collected);
  const byPointer = new Map<string, JsonSchema>();
  const anchors = new Map<string, string>();
  const duplicateAnchors: SchemaNode[] = [];
  for (const node of collected.nodes) {
    const pointer = pointerOf(node.segments);
    byPointer.set(pointer, node.schema);
    const anchor = node.schema.$anchor;
    if (typeof anchor !== "string") continue;
    if (anchors.has(anchor)) duplicateAnchors.push(node);
    else anchors.set(anchor, pointer);
  }
  return {
    nodes: collected.nodes,
    byPointer,
    anchors,
    duplicateAnchors,
    ...(collected.limit ? { limit: collected.limit } : {}),
  };
};

const INDEXES = new WeakMap<JsonSchema, RefIndex>();

/** The index of a schema document, built once per root object (schemas are immutable once registered). */
export const refIndexFor = (root: JsonSchema): RefIndex => {
  const known = INDEXES.get(root);
  if (known) return known;
  const index = buildIndex(root);
  INDEXES.set(root, index);
  return index;
};

const decodeFragment = (fragment: string): string | undefined => {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return undefined;
  }
};

/**
 * The subschema a local `$ref` names, or `undefined` when it is not local, not a
 * subschema position, or absent. Targets come from a `Map` of real subschema
 * positions, so `#/constructor` or `#/enum/0` never resolve through the prototype
 * chain or into non-schema data.
 */
export const resolveRef = (index: RefIndex, ref: string): JsonSchema | undefined => {
  if (!isLocalRef(ref)) return undefined;
  const fragment = ref.slice(1);
  if (fragment !== "" && !fragment.startsWith("/")) {
    const pointer = index.anchors.get(fragment);
    return pointer === undefined ? undefined : index.byPointer.get(pointer);
  }
  const pointer = decodeFragment(fragment);
  return pointer === undefined ? undefined : index.byPointer.get(pointer);
};
