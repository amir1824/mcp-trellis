/** `ToolDef.outputSchema`: checked when the registry is built, and every successful result against it. */

import { isJsonObject } from "../../../util/json.js";
import { missingObjectType, unsupportedKeywords } from "../../schema/check.js";
import { violationsOf } from "../../schema/custom/run.js";
import type { JsonSchema, SchemaValidator } from "../../schema/types.js";
import type { ToolResult } from "../content.js";
import { errorResult, INVALID_TOOL_RESULT } from "./outcome.js";

const OUTPUT_SCHEMA_PATH = "outputSchema";
const STRUCTURED_CONTENT_PATH = "structuredContent";
const MISSING_STRUCTURED_CONTENT = "structuredContent is missing";
const VALIDATOR_FAILED = "schemaValidator threw or did not return an array of strings";

type WithOutputSchema = { name: string; outputSchema?: JsonSchema | undefined };

/**
 * Not a schema object, or one the built-in evaluator would silently skip parts of. Empty when
 * sound. `builtIn: false` (the host brings a `schemaValidator`) checks only that it is an object.
 */
export const outputSchemaViolations = (
  tools: readonly WithOutputSchema[],
  builtIn = true,
): string[] =>
  tools.flatMap(({ name, outputSchema }) => {
    if (outputSchema === undefined) return [];
    if (!isJsonObject(outputSchema)) return [`${name}: outputSchema must be a JSON Schema object`];
    if (!builtIn) return [];
    return [
      ...unsupportedKeywords(outputSchema, OUTPUT_SCHEMA_PATH).map(
        (path) => `${name}: unsupported JSON Schema keyword at ${path}`,
      ),
      ...missingObjectType(outputSchema, OUTPUT_SCHEMA_PATH).map(
        (path) => `${name}: ${path} uses properties/required without type: "object"`,
      ),
    ];
  });

/** The validator reports paths from `args`; for a result the root is `structuredContent`. */
const rootedAtResult = (violation: string): string =>
  violation.replace(/^args/, STRUCTURED_CONTENT_PATH);

/**
 * How a non-error result breaks its tool's `outputSchema`: a missing `structuredContent`, or a
 * value the schema rejects. For the developer's log only: the text can hold the result's data.
 */
export const outputViolations = (
  result: ToolResult,
  schema: JsonSchema,
  validator?: SchemaValidator,
): string[] => {
  if (result.structuredContent === undefined) return [MISSING_STRUCTURED_CONTENT];
  try {
    return violationsOf(result.structuredContent, schema, validator).map(rootedAtResult);
  } catch {
    return [VALIDATOR_FAILED];
  }
};

/** Tells the developer why a result was rejected. A throwing or rejecting hook never fails the call. */
const reportViolations = (
  hook: ((tool: string, violations: string[]) => void) | undefined,
  tool: string,
  violations: string[],
): void => {
  try {
    Promise.resolve(hook?.(tool, violations)).catch(() => undefined);
  } catch {
    // a logging hook must never turn a rejected result into a transport failure
  }
};

/**
 * The result itself when it meets the tool's `outputSchema` (or the tool has none, or the result
 * is an error), otherwise the generic error, with the violations handed to `onViolation` only.
 */
export const checkedOutput = (
  tool: { name: string; outputSchema?: JsonSchema | undefined },
  result: ToolResult,
  onViolation: ((tool: string, violations: string[]) => void) | undefined,
  validator?: SchemaValidator,
): ToolResult => {
  if (!tool.outputSchema || result.isError) return result;
  const violations = outputViolations(result, tool.outputSchema, validator);
  if (violations.length === 0) return result;
  reportViolations(onViolation, tool.name, violations);
  return errorResult(INVALID_TOOL_RESULT);
};
