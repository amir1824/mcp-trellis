import { MAX_REF_DEPTH } from "../limits.js";
import { refIndexFor, resolveRef } from "../refs.js";
import type { JsonSchema } from "../types.js";
import { evaluate, evaluateChild, isValid } from "./node.js";
import { abort, type Check, descend, echo, isSpent, spend, type Visit } from "./run.js";

type Branches = Array<JsonSchema | boolean>;

/** The same value against each subschema, reported at the same path. */
const sameValue = (visit: Visit, schema: JsonSchema | boolean) => ({
  value: visit.value,
  schema,
  path: visit.path,
});

const allOfCheck: Check = (visit, run) => {
  const errors: string[] = [];
  for (const branch of visit.schema.allOf ?? []) {
    if (isSpent(run)) break;
    errors.push(...evaluateChild(visit, sameValue(visit, branch), run));
  }
  return errors;
};

const anyOfCheck: Check = (visit, run) => {
  const branches: Branches | undefined = visit.schema.anyOf;
  if (branches === undefined) return [];
  const matched = branches.some((branch) => isValid(visit, sameValue(visit, branch), run));
  return matched ? [] : spend(run, [`${visit.path}: does not match any schema in anyOf`]);
};

const oneOfCheck: Check = (visit, run) => {
  const branches: Branches | undefined = visit.schema.oneOf;
  if (branches === undefined) return [];
  let matches = 0;
  for (const branch of branches) {
    if (matches > 1 || isSpent(run)) break;
    if (isValid(visit, sameValue(visit, branch), run)) matches += 1;
  }
  if (matches === 1) return [];
  const reason =
    matches === 0 ? "does not match any schema in oneOf" : "matches more than one schema in oneOf";
  return spend(run, [`${visit.path}: ${reason}`]);
};

const notCheck: Check = (visit, run) => {
  const { not } = visit.schema;
  if (not === undefined || !isValid(visit, sameValue(visit, not), run)) return [];
  return spend(run, [`${visit.path}: must not match the schema in not`]);
};

/** `then` / `else` without `if` do nothing; the chosen branch reports its own violations. */
const conditionalCheck: Check = (visit, run) => {
  const { if: condition, then, else: otherwise } = visit.schema;
  if (condition === undefined) return [];
  const branch = isValid(visit, sameValue(visit, condition), run) ? then : otherwise;
  return branch === undefined ? [] : evaluateChild(visit, sameValue(visit, branch), run);
};

/** `$ref` is local only; siblings of `$ref` are still evaluated (2020-12). */
const refCheck: Check = (visit, run) => {
  const { $ref: ref } = visit.schema;
  if (ref === undefined) return [];
  if (visit.refDepth >= MAX_REF_DEPTH) {
    return abort(run, `${visit.path}: $ref nested deeper than ${MAX_REF_DEPTH} levels`);
  }
  const target = resolveRef(refIndexFor(run.root), ref);
  if (target === undefined) return abort(run, `${visit.path}: unresolved $ref ${echo(ref)}`);
  const next = descend(visit, visit.value, target, visit.path);
  return evaluate({ ...next, refDepth: visit.refDepth + 1 }, run);
};

const APPLICATOR_CHECKS: readonly Check[] = [
  allOfCheck,
  anyOfCheck,
  oneOfCheck,
  notCheck,
  conditionalCheck,
  refCheck,
];

export const applicatorChecks: Check = (visit, run) => {
  const errors: string[] = [];
  for (const check of APPLICATOR_CHECKS) {
    if (isSpent(run)) break;
    errors.push(...check(visit, run));
  }
  return errors;
};
