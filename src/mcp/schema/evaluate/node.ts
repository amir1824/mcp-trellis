import { MAX_EVALUATION_DEPTH } from "../limits.js";
import { nodeInfo } from "../node-info.js";
import { FALSE_SCHEMA, toSchema } from "../subschema.js";
import type { JsonSchema } from "../types.js";
import { applicatorChecks } from "./applicator.js";
import { arrayChecks } from "./array.js";
import { objectChecks } from "./object.js";
import {
  abort,
  type Check,
  charge,
  descend,
  echo,
  isSpent,
  probe,
  type Run,
  spend,
  type Visit,
} from "./run.js";
import { enumAndConst, numberChecks, stringChecks, typeMismatch } from "./scalar.js";

/** A value to check against a subschema position, and the path it is reported under. */
export type Child = { value: unknown; schema: JsonSchema | boolean; path: string };

const CHECKS: readonly Check[] = [
  enumAndConst,
  numberChecks,
  stringChecks,
  objectChecks,
  arrayChecks,
  applicatorChecks,
];

/**
 * Violations of `visit.value` against `visit.schema`, at most what is left of
 * the error budget. A bound hit (depth, steps, an unevaluable node) calls `abort`
 * and returns nothing: the caller then answers with the abort message alone.
 */
export const evaluate = (visit: Visit, run: Run): string[] => {
  if (run.counters.abort !== undefined) return [];
  if (visit.depth > MAX_EVALUATION_DEPTH) {
    return abort(run, `${visit.path}: nested deeper than ${MAX_EVALUATION_DEPTH} levels`);
  }
  if (!charge(run, visit.path)) return [];
  if (visit.schema === FALSE_SCHEMA) return spend(run, [`${visit.path}: no value is allowed`]);
  const [problem] = nodeInfo(visit.schema).problems;
  if (problem) {
    const reason = problem.reason === undefined ? "" : ` (${problem.reason})`;
    return abort(
      run,
      `${visit.path}: schema keyword ${echo(problem.keyword)}${reason} is not supported`,
    );
  }
  // A type mismatch alone answers the node: the other keywords would only add noise.
  const typeErrors = typeMismatch(visit);
  if (typeErrors.length > 0) return spend(run, typeErrors);
  const errors: string[] = [];
  for (const check of CHECKS) {
    if (isSpent(run)) break;
    errors.push(...check(visit, run));
  }
  return errors;
};

/** Violations of a child value against a subschema, one level deeper. */
export const evaluateChild = (visit: Visit, child: Child, run: Run): string[] =>
  evaluate(descend(visit, child.value, toSchema(child.schema), child.path), run);

/** Whether the child is valid; stops at its first violation and reports nothing. */
export const isValid = (visit: Visit, child: Child, run: Run): boolean =>
  evaluateChild(visit, child, probe(run)).length === 0;
