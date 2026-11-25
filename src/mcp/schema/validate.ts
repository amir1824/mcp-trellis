import { evaluate } from "./evaluate/node.js";
import type { Run } from "./evaluate/run.js";
import { MAX_VALIDATION_ERRORS } from "./limits.js";
import type { JsonSchema } from "./types.js";

/**
 * Evaluates `value` against a JSON Schema 2020-12 `schema` (an MCP tool
 * `inputSchema`). Empty = valid. Pure and synchronous; never throws and never
 * fetches anything.
 *
 * - Reports at most `MAX_VALIDATION_ERRORS` violations, each `args.path: reason`,
 *   never echoing the value itself.
 * - Local `$ref` only (`#`, `#/$defs/x`, `#anchor`). Run `unsupportedKeywords` first
 *   (the tool registry does): it rejects what this cannot evaluate. A schema that
 *   was not checked fails closed here with one message instead.
 * - Bounds (see `limits.ts`) turn into a violation, never a pass: a schema or value
 *   that would exceed them is answered with the single bound message.
 * - `format` is an annotation, as in 2020-12 without the format-assertion vocabulary.
 * - `pattern` / `patternProperties` run on the library's own non-backtracking matcher
 *   (`regex/`), an unanchored search over code points like `RegExp(source, "u")`, on strings
 *   of at most `MAX_PATTERN_INPUT_LENGTH` code units. Its work is charged to the step budget,
 *   so no pattern can hang the call. Syntax outside its subset is refused by `unsupportedKeywords`.
 * - `$schema` may name 2020-12, 2019-09 or draft-07; all are evaluated as 2020-12.
 * - Schemas are treated as immutable once passed in (compiled patterns and the `$ref`
 *   index are cached per object).
 */
export const validateAgainstSchema = (value: unknown, schema: JsonSchema): string[] => {
  const run: Run = {
    root: schema,
    errors: { remaining: MAX_VALIDATION_ERRORS },
    counters: { steps: 0, abort: undefined },
  };
  const errors = evaluate({ value, schema, path: "args", depth: 0, refDepth: 0 }, run);
  if (run.counters.abort !== undefined) return [run.counters.abort];
  // A spent budget means the walk stopped early: say so, so a caller does not
  // read the list as complete and loop on "fix these, find more".
  return run.errors.remaining <= 0
    ? [...errors, `(stopped after ${MAX_VALIDATION_ERRORS} errors; more may follow)`]
    : errors;
};
