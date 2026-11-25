/**
 * Resource bounds of the JSON Schema evaluator. MCP 2026-07-28 only says
 * implementations SHOULD bound "a maximum schema depth, a cap on the total
 * number of subschemas, or a per-validation time budget" and names no numbers;
 * these values are this library's choice. Exceeding a bound at validation time
 * is a violation (the call is rejected), never a throw and never a pass.
 */

/** Errors reported for one value before validation stops looking for more. */
export const MAX_VALIDATION_ERRORS = 20;

/** Deepest static nesting of subschemas in one schema; deeper is rejected at construction. */
export const MAX_SCHEMA_DEPTH = 64;

/** Most subschemas one schema may hold; more is rejected at construction (schema bomb). */
export const MAX_SCHEMA_NODES = 10_000;

/**
 * Deepest recursion while validating one value: counts every schema and instance
 * step plus every `$ref` hop, so a recursive `$ref` against a deeply nested
 * value ends here instead of overflowing the stack.
 */
export const MAX_EVALUATION_DEPTH = 256;

/** Longest chain of `$ref` hops active at once while validating one value. */
export const MAX_REF_DEPTH = 32;

/**
 * Work units allowed per validation (schema bomb: `allOf` of two `$ref`s, nested).
 * One unit per subschema-against-value evaluation, plus the size of the work a
 * visit does on client data (object keys, text scanned). Sized so a flat array
 * filling the 1 MiB request body (about 524k elements) passes against a one-unit
 * item schema; an item schema that costs more units per element (a `$ref`, a
 * pattern) lowers that ceiling accordingly.
 */
export const MAX_EVALUATION_STEPS = 1_000_000;

/** Characters of client text scanned (`pattern`, length counting) per work unit. */
export const CHARS_PER_STEP = 64;

/**
 * Longest string (UTF-16 code units) matched against any `pattern` /
 * `patternProperties`. The matcher is linear, so this bounds time, not safety: the worst
 * accepted program (about 2000 instructions, every thread live) takes 49 ms on 4096
 * characters (Node 22, arm64), 28 ms on 2048 and 12 ms on 1024. Longer text is a violation.
 */
export const MAX_PATTERN_INPUT_LENGTH = 4096;

/** Most array items compared for `uniqueItems`; larger arrays are a violation. */
export const MAX_UNIQUE_ITEMS = 10_000;

/** Longest property name or schema pattern echoed in a message. */
export const MAX_ECHOED_TEXT_LENGTH = 64;

/** Float quotient slack for `multipleOf` (`0.3 / 0.1` is `2.9999999999999996`), in epsilons. */
export const MULTIPLE_OF_EPSILONS = 8;

/** Absolute cap on that slack, so huge quotients do not accept non-multiples. */
export const MULTIPLE_OF_MAX_SLACK = 1e-6;
