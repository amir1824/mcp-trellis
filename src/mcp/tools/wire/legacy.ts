/**
 * What a client on a protocol version before 2026-07-28 may receive of a tool's result and listing.
 * Those versions define `structuredContent` and `outputSchema` as objects only (2025-06-18; the
 * earlier two have neither), so a value outside that is left out and `content` is the whole answer.
 */

import { isJsonObject } from "../../../util/json.js";

const OBJECT_TYPE = "object";

/** A `tools/call` result without a `structuredContent` that is not a plain object. */
export const legacyToolCallResult = (result: object): object => {
  if (!("structuredContent" in result) || isJsonObject(result.structuredContent)) return result;
  const { structuredContent: _notAnObject, ...rest } = result;
  return rest;
};

const legacyToolEntry = (entry: unknown): unknown => {
  if (!isJsonObject(entry) || !isJsonObject(entry.outputSchema)) return entry;
  if (entry.outputSchema.type === OBJECT_TYPE) return entry;
  const { outputSchema: _notAnObject, ...rest } = entry;
  return rest;
};

/** A `tools/list` result without any `outputSchema` whose root type is not exactly `"object"`. */
export const legacyToolsListResult = (result: object): object =>
  "tools" in result && Array.isArray(result.tools)
    ? { ...result, tools: result.tools.map(legacyToolEntry) }
    : result;
