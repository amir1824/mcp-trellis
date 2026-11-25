import { clipText } from "../../../util/clip.js";
import type { JsonSchema, SchemaValidator } from "../types.js";
import { validateAgainstSchema } from "../validate.js";

const isViolationList = (result: unknown): result is string[] =>
  Array.isArray(result) && result.every((entry) => typeof entry === "string");

/**
 * Violations of `value` against `schema`: the built-in evaluator's, or the host's
 * `validator` when one is given. The host's validator is untrusted code on a
 * trust boundary, so it fails closed: one that throws, or answers anything but an
 * array of strings (a promise included), makes this throw, and the caller
 * rejects the call without showing the client what went wrong. The built-in
 * evaluator never throws.
 */
export const violationsOf = (
  value: unknown,
  schema: JsonSchema,
  validator: SchemaValidator | undefined,
): string[] => {
  if (validator === undefined) return validateAgainstSchema(value, schema);
  const violations: unknown = validator(value, schema);
  if (violations instanceof Promise) violations.catch(() => undefined);
  if (!isViolationList(violations)) {
    throw new Error("schemaValidator must return an array of strings");
  }
  return violations;
};

/** Longest validation message returned — a path in it can carry an attacker-chosen key. */
const MAX_VALIDATION_MESSAGE_LENGTH = 2000;

/** What the client sees when the host's `schemaValidator` fails on the arguments: nothing of why. */
const INVALID_ARGUMENTS = "Invalid arguments";

/** The client-visible rejection of `args`, or `undefined` when they conform. */
export const argsRejection = (
  args: Record<string, unknown>,
  schema: JsonSchema,
  validator: SchemaValidator | undefined,
): string | undefined => {
  try {
    const errors = violationsOf(args, schema, validator);
    if (errors.length === 0) return undefined;
    return clipText(errors.join("; "), MAX_VALIDATION_MESSAGE_LENGTH, "…");
  } catch {
    return INVALID_ARGUMENTS;
  }
};
