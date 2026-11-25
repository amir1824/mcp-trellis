import { clipText } from "../../../util/clip.js";
import {
  CHARS_PER_STEP,
  MAX_ECHOED_TEXT_LENGTH,
  MAX_EVALUATION_STEPS,
  MAX_PATTERN_INPUT_LENGTH,
} from "../limits.js";
import { nodeInfo } from "../node-info.js";
import { matchCost, matchesProgram } from "../regex/run.js";
import type { JsonSchema } from "../types.js";

/** One subschema about to be evaluated against one value. */
export type Visit = {
  value: unknown;
  schema: JsonSchema;
  /** Where the value sits in the arguments, e.g. `args.tags[2]`. */
  path: string;
  /** Recursion depth: every schema step, instance step and `$ref` hop counts. */
  depth: number;
  /** `$ref` hops currently active on the stack. */
  refDepth: number;
};

/** State of one `validateAgainstSchema` call. */
export type Run = {
  root: JsonSchema;
  /**
   * Counts down as errors are collected. A walk stops as soon as it is spent:
   * collecting every violation of a 500k-element array against `items: {type:
   * "string"}` would answer a 1 MB request with a ~24 MB error message, after
   * seconds of CPU.
   */
  errors: { remaining: number };
  /** Shared by every probe of the call. `abort` is sticky: once set, the call fails closed. */
  counters: { steps: number; abort: string | undefined };
};

/** Keeps the errors that still fit the budget and spends it. */
export const spend = (run: Run, errors: string[]): string[] => {
  const kept = errors.slice(0, Math.max(0, run.errors.remaining));
  run.errors.remaining -= kept.length;
  return kept;
};

/** True when walking on can no longer change the outcome. */
export const isSpent = (run: Run): boolean =>
  run.errors.remaining <= 0 || run.counters.abort !== undefined;

/**
 * Records that the value could not be evaluated (a bound was hit). Not an
 * ordinary violation: `not`, `oneOf` and `if` would turn a local violation into
 * a pass, so the whole call is answered with this message instead.
 */
export const abort = (run: Run, message: string): string[] => {
  run.counters.abort ??= message;
  return [];
};

/** Counts `units` of work; `false` (and the call aborted) once `MAX_EVALUATION_STEPS` is spent. */
export const charge = (run: Run, path: string, units = 1): boolean => {
  run.counters.steps += units;
  if (run.counters.steps <= MAX_EVALUATION_STEPS) return true;
  abort(run, `${path}: validation stopped after ${MAX_EVALUATION_STEPS} steps`);
  return false;
};

/** Charges the scan of client text: one unit per `CHARS_PER_STEP` characters, at least one. */
export const chargeText = (run: Run, path: string, text: string): boolean =>
  charge(run, path, Math.max(1, Math.ceil(text.length / CHARS_PER_STEP)));

/** A run that stops at its first violation and shares the step counter: for `not`, `anyOf`, `contains`, … */
export const probe = (run: Run): Run => ({ ...run, errors: { remaining: 1 } });

/** The next visit one level down. */
export const descend = (visit: Visit, value: unknown, schema: JsonSchema, path: string): Visit => ({
  ...visit,
  value,
  schema,
  path,
  depth: visit.depth + 1,
});

const CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029]/gu;

/** Client-chosen text (a property name), clipped and stripped of control characters to put in a message. */
export const echo = (text: string): string =>
  clipText(text, MAX_ECHOED_TEXT_LENGTH, "…").replace(CONTROL_CHARACTERS, "?");

/** A `pattern` / `patternProperties` match request against text of the client's choosing. */
export type PatternTest = { schema: JsonSchema; path: string; source: string; text: string };

/**
 * `true` when the text matches the pattern compiled for `schema`. Text longer than
 * `MAX_PATTERN_INPUT_LENGTH` is never matched, and a match is charged to the step budget by
 * its worst-case work (`matchCost`): either way the call aborts instead of burning CPU.
 */
export const matchesPattern = (run: Run, test: PatternTest): boolean => {
  if (test.text.length > MAX_PATTERN_INPUT_LENGTH) {
    abort(
      run,
      `${test.path}: string longer than ${MAX_PATTERN_INPUT_LENGTH} code units cannot be matched against a pattern`,
    );
    return true;
  }
  const program = nodeInfo(test.schema).patterns.get(test.source);
  if (program === undefined) {
    abort(run, `${test.path}: pattern was not compiled, so it cannot be matched`);
    return true;
  }
  if (!charge(run, test.path, matchCost(program, test.text.length))) return true;
  return matchesProgram(program, test.text);
};

/** One keyword family: evaluates the keywords of `visit.schema` that apply to `visit.value`. */
export type Check = (visit: Visit, run: Run) => string[];
