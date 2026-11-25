import { isJsonObject } from "../../../util/json.js";
import { MAX_EVALUATION_DEPTH, MAX_UNIQUE_ITEMS } from "../limits.js";
import { evaluateChild, isValid } from "./node.js";
import { abort, type Check, charge, isSpent, type Run, spend, type Visit } from "./run.js";

type ArrayCheck = (visit: Visit, run: Run, items: unknown[]) => string[];

const sizeCheck: ArrayCheck = ({ schema, path }, run, items) =>
  spend(run, [
    ...(schema.minItems !== undefined && items.length < schema.minItems
      ? [`${path}: fewer than ${schema.minItems} items`]
      : []),
    ...(schema.maxItems !== undefined && items.length > schema.maxItems
      ? [`${path}: more than ${schema.maxItems} items`]
      : []),
  ]);

/** `prefixItems` for the leading positions, `items` for the rest. */
const positionalCheck: ArrayCheck = (visit, run, items) => {
  const prefix = visit.schema.prefixItems ?? [];
  // Without `items` only the prefix positions have a subschema: do not walk the rest.
  const end =
    visit.schema.items === undefined ? Math.min(prefix.length, items.length) : items.length;
  const errors: string[] = [];
  for (let index = 0; index < end && !isSpent(run); index += 1) {
    const subschema = index < prefix.length ? prefix[index] : visit.schema.items;
    if (subschema === undefined) continue;
    const child = { value: items[index], schema: subschema, path: `${visit.path}[${index}]` };
    errors.push(...evaluateChild(visit, child, run));
  }
  return errors;
};

const containsCheck: ArrayCheck = (visit, run, items) => {
  const { contains, minContains = 1, maxContains } = visit.schema;
  if (contains === undefined) return [];
  // Counting stops once the outcome is settled: enough matches, or one over the maximum.
  const settledAt = Math.max(minContains, maxContains === undefined ? 0 : maxContains + 1);
  let matches = 0;
  for (const [index, item] of items.entries()) {
    if (matches >= settledAt || isSpent(run)) break;
    const element = { value: item, schema: contains, path: `${visit.path}[${index}]` };
    if (isValid(visit, element, run)) matches += 1;
  }
  return spend(run, [
    ...(matches < minContains
      ? [`${visit.path}: fewer than ${minContains} items match contains`]
      : []),
    ...(maxContains !== undefined && matches > maxContains
      ? [`${visit.path}: more than ${maxContains} items match contains`]
      : []),
  ]);
};

/**
 * A string equal for structurally equal JSON (object key order ignored, `-0`
 * equals `0`), so uniqueness is a `Set` lookup instead of an O(n²) comparison.
 * Bounded in depth and charged to the step counter: it reads client data.
 */
const canonicalKey = (value: unknown, visit: Visit, run: Run, depth: number): string => {
  if (run.counters.abort !== undefined || !charge(run, visit.path)) return "";
  if (depth > MAX_EVALUATION_DEPTH) {
    abort(
      run,
      `${visit.path}: items nested deeper than ${MAX_EVALUATION_DEPTH} levels cannot be compared`,
    );
    return "";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalKey(entry, visit, run, depth + 1)).join(",")}]`;
  }
  if (!isJsonObject(value)) return String(JSON.stringify(value));
  const keys = Object.keys(value);
  if (!charge(run, visit.path, keys.length)) return "";
  const members = keys
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalKey(value[key], visit, run, depth + 1)}`);
  return `{${members.join(",")}}`;
};

const uniqueCheck: ArrayCheck = (visit, run, items) => {
  if (visit.schema.uniqueItems !== true) return [];
  if (items.length > MAX_UNIQUE_ITEMS) {
    return abort(
      run,
      `${visit.path}: more than ${MAX_UNIQUE_ITEMS} items cannot be checked for uniqueness`,
    );
  }
  const seen = new Set<string>();
  for (const item of items) {
    const key = canonicalKey(item, visit, run, visit.depth);
    if (run.counters.abort !== undefined) return [];
    if (seen.has(key)) return spend(run, [`${visit.path}: items are not unique`]);
    seen.add(key);
  }
  return [];
};

const ARRAY_CHECKS: readonly ArrayCheck[] = [
  sizeCheck,
  positionalCheck,
  containsCheck,
  uniqueCheck,
];

export const arrayChecks: Check = (visit, run) => {
  const { value } = visit;
  if (!Array.isArray(value)) return [];
  const errors: string[] = [];
  for (const check of ARRAY_CHECKS) {
    if (isSpent(run)) break;
    errors.push(...check(visit, run, value));
  }
  return errors;
};
