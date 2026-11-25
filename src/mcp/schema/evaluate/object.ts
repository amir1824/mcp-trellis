import { isJsonObject } from "../../../util/json.js";
import { evaluateChild, isValid } from "./node.js";
import {
  type Check,
  charge,
  chargeText,
  echo,
  isSpent,
  matchesPattern,
  type Run,
  spend,
  type Visit,
} from "./run.js";

/** The object under validation with its own keys listed once. */
type ObjectView = { record: Record<string, unknown>; keys: string[] };

type ObjectCheck = (visit: Visit, run: Run, view: ObjectView) => string[];

// `Object.hasOwn`, not `key in record` — `in` also matches inherited
// Object.prototype members (`toString`, `constructor`, `hasOwnProperty`, …),
// so `required: ["toString"]` would pass against `{}` and a
// `properties: { constructor: {...} }` entry would validate against the
// prototype's own `constructor`, neither of which is an argument the caller supplied.
const requiredCheck: ObjectCheck = ({ schema, path }, run, { record }) =>
  spend(
    run,
    (schema.required ?? [])
      .filter((key) => !Object.hasOwn(record, key))
      .map((key) => `${path}.${key}: required`),
  );

const propertiesCheck: ObjectCheck = (visit, run, { record }) => {
  const errors: string[] = [];
  for (const [key, subschema] of Object.entries(visit.schema.properties ?? {})) {
    if (isSpent(run)) break;
    if (!Object.hasOwn(record, key)) continue;
    const child = { value: record[key], schema: subschema, path: `${visit.path}.${key}` };
    errors.push(...evaluateChild(visit, child, run));
  }
  return errors;
};

/** `patternProperties` and `additionalProperties`: one pass, each key tested once per pattern. */
const keyedCheck: ObjectCheck = (visit, run, { record, keys }) => {
  const { schema, path } = visit;
  const patterns = Object.entries(schema.patternProperties ?? {});
  const { additionalProperties, properties } = schema;
  if (
    patterns.length === 0 &&
    (additionalProperties === undefined || additionalProperties === true)
  ) {
    return [];
  }
  const errors: string[] = [];
  for (const key of keys) {
    if (isSpent(run)) break;
    const keyPath = `${path}.${echo(key)}`;
    const matching = patterns.filter(
      ([source]) =>
        chargeText(run, keyPath, key) &&
        matchesPattern(run, { schema, path: keyPath, source, text: key }),
    );
    for (const [, subschema] of matching) {
      errors.push(
        ...evaluateChild(visit, { value: record[key], schema: subschema, path: keyPath }, run),
      );
    }
    const isExtra = matching.length === 0 && !Object.hasOwn(properties ?? {}, key);
    if (!isExtra || additionalProperties === undefined || additionalProperties === true) continue;
    errors.push(
      ...(additionalProperties === false
        ? spend(run, [`${keyPath}: not allowed`])
        : evaluateChild(
            visit,
            { value: record[key], schema: additionalProperties, path: keyPath },
            run,
          )),
    );
  }
  return errors;
};

const sizeCheck: ObjectCheck = ({ schema, path }, run, { keys }) =>
  spend(run, [
    ...(schema.minProperties !== undefined && keys.length < schema.minProperties
      ? [`${path}: fewer than ${schema.minProperties} properties`]
      : []),
    ...(schema.maxProperties !== undefined && keys.length > schema.maxProperties
      ? [`${path}: more than ${schema.maxProperties} properties`]
      : []),
  ]);

const dependentRequiredCheck: ObjectCheck = ({ schema, path }, run, { record }) =>
  spend(
    run,
    Object.entries(schema.dependentRequired ?? {}).flatMap(([key, dependents]) =>
      Object.hasOwn(record, key)
        ? dependents
            .filter((name) => !Object.hasOwn(record, name))
            .map((name) => `${path}.${name}: required when ${key} is present`)
        : [],
    ),
  );

const propertyNamesCheck: ObjectCheck = (visit, run, { keys }) => {
  const { propertyNames } = visit.schema;
  if (propertyNames === undefined) return [];
  const errors: string[] = [];
  for (const key of keys) {
    if (isSpent(run)) break;
    const name = { value: key, schema: propertyNames, path: visit.path };
    if (!isValid(visit, name, run)) {
      errors.push(...spend(run, [`${visit.path}.${echo(key)}: invalid property name`]));
    }
  }
  return errors;
};

const dependentSchemasCheck: ObjectCheck = (visit, run, { record }) => {
  const errors: string[] = [];
  for (const [key, subschema] of Object.entries(visit.schema.dependentSchemas ?? {})) {
    if (isSpent(run)) break;
    if (!Object.hasOwn(record, key)) continue;
    errors.push(
      ...evaluateChild(visit, { value: record, schema: subschema, path: visit.path }, run),
    );
  }
  return errors;
};

const OBJECT_CHECKS: readonly ObjectCheck[] = [
  requiredCheck,
  propertiesCheck,
  keyedCheck,
  sizeCheck,
  dependentRequiredCheck,
  propertyNamesCheck,
  dependentSchemasCheck,
];

export const objectChecks: Check = (visit, run) => {
  if (!isJsonObject(visit.value)) return [];
  const view = { record: visit.value, keys: Object.keys(visit.value) };
  if (!charge(run, visit.path, view.keys.length)) return [];
  const errors: string[] = [];
  for (const check of OBJECT_CHECKS) {
    if (isSpent(run)) break;
    errors.push(...check(visit, run, view));
  }
  return errors;
};
