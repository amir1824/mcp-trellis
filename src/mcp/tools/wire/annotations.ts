/** `ToolDef.annotations`: the five hint fields MCP defines, checked once when the registry is built. */

import { isJsonObject } from "../../../util/json.js";

/**
 * Hints about a tool, advertised in `tools/list` as MCP defines them.
 *
 * These are hints only. A client MUST treat them as untrusted unless the server
 * is trusted, and this library NEVER reads them to authorize a call or to decide
 * a scope: use `ToolDef.scope` for that. A tool marked `readOnlyHint: true` that
 * writes is still allowed to write.
 */
export type ToolAnnotations = {
  /** A human-readable title for the tool. */
  title?: string;
  /** The tool does not modify its environment. Default (when absent) is `false`. */
  readOnlyHint?: boolean;
  /** The tool may perform destructive updates; meaningful only when not read-only. */
  destructiveHint?: boolean;
  /** Calling it again with the same arguments has no further effect; meaningful only when not read-only. */
  idempotentHint?: boolean;
  /** The tool may interact with an open world of external entities (the web), not a closed domain. */
  openWorldHint?: boolean;
};

const ANNOTATION_TYPES: Readonly<Record<keyof ToolAnnotations, "string" | "boolean">> = {
  title: "string",
  readOnlyHint: "boolean",
  destructiveHint: "boolean",
  idempotentHint: "boolean",
  openWorldHint: "boolean",
};

const fieldViolations = (tool: string, annotations: Record<string, unknown>): string[] =>
  Object.entries(annotations).flatMap(([field, value]) => {
    const expected = Object.hasOwn(ANNOTATION_TYPES, field)
      ? ANNOTATION_TYPES[field as keyof ToolAnnotations]
      : undefined;
    if (expected === undefined)
      return [`${tool}: annotations.${field} is not an MCP tool annotation`];
    if (value === undefined || typeof value === expected) return [];
    return [`${tool}: annotations.${field} must be a ${expected}, got ${typeof value}`];
  });

/** One message per wrong annotation across all tools; empty when every tool's annotations are well-formed. */
export const annotationViolations = (
  tools: ReadonlyArray<{ name: string; annotations?: ToolAnnotations | undefined }>,
): string[] =>
  tools.flatMap(({ name, annotations }) => {
    if (annotations === undefined) return [];
    if (!isJsonObject(annotations)) return [`${name}: annotations must be an object`];
    return fieldViolations(name, annotations);
  });
