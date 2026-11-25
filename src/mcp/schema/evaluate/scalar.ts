import { areJsonValuesEqual } from "../../../util/json.js";
import { JSON_SCHEMA_TYPES } from "../keywords.js";
import { MULTIPLE_OF_EPSILONS, MULTIPLE_OF_MAX_SLACK } from "../limits.js";
import {
  type Check,
  chargeText,
  echo,
  matchesPattern,
  type Run,
  spend,
  type Visit,
} from "./run.js";

/** `JSON.parse("1e999")` is Infinity: not a JSON number, so it matches neither `number` nor `integer`. */
const NON_FINITE_NUMBER = "non-finite number";

export const runtimeTypeOf = (value: unknown): string => {
  if (value === null) return JSON_SCHEMA_TYPES.null;
  if (Array.isArray(value)) return JSON_SCHEMA_TYPES.array;
  if (typeof value === "number" && !Number.isFinite(value)) return NON_FINITE_NUMBER;
  return typeof value;
};

const declaredTypesOf = (visit: Visit): string[] => {
  const { type } = visit.schema;
  if (type === undefined) return [];
  return Array.isArray(type) ? type : [type];
};

const matchesDeclaredType = (actual: string, value: unknown, declared: string): boolean =>
  declared === JSON_SCHEMA_TYPES.integer
    ? actual === JSON_SCHEMA_TYPES.number && Number.isInteger(value)
    : actual === declared;

/** Unspent: a type mismatch short-circuits the node, so the caller returns it alone. */
export const typeMismatch = (visit: Visit): string[] => {
  const declared = declaredTypesOf(visit);
  if (declared.length === 0) return [];
  const actual = runtimeTypeOf(visit.value);
  const matches = declared.some((type) => matchesDeclaredType(actual, visit.value, type));
  return matches ? [] : [`${visit.path}: expected ${declared.join(" | ")}, got ${actual}`];
};

export const enumAndConst: Check = ({ value, schema, path }, run) => [
  ...spend(
    run,
    schema.enum && !schema.enum.some((entry) => areJsonValuesEqual(entry, value))
      ? [`${path}: value not in enum`]
      : [],
  ),
  ...spend(
    run,
    Object.hasOwn(schema, "const") && !areJsonValuesEqual(schema.const, value)
      ? [`${path}: value does not equal const`]
      : [],
  ),
];

const NUMBER_BOUNDS: Array<{
  key: "minimum" | "maximum" | "exclusiveMinimum" | "exclusiveMaximum";
  fails: (value: number, bound: number) => boolean;
  message: (path: string, bound: number) => string;
}> = [
  {
    key: "minimum",
    fails: (value, bound) => value < bound,
    message: (path, bound) => `${path}: below minimum ${bound}`,
  },
  {
    key: "maximum",
    fails: (value, bound) => value > bound,
    message: (path, bound) => `${path}: above maximum ${bound}`,
  },
  {
    key: "exclusiveMinimum",
    fails: (value, bound) => value <= bound,
    message: (path, bound) => `${path}: not above exclusiveMinimum ${bound}`,
  },
  {
    key: "exclusiveMaximum",
    fails: (value, bound) => value >= bound,
    message: (path, bound) => `${path}: not below exclusiveMaximum ${bound}`,
  },
];

/**
 * Decimal multiples are not exact in binary (`0.3 / 0.1` is `2.9999999999999996`),
 * so the quotient may sit a few epsilons off an integer; an infinite quotient
 * (`1e308 / 0.123456789`) is never a multiple. An integer divisor and a finite
 * value are exact in binary, so the quotient must be an integer, with no slack.
 */
const isMultipleOf = (value: number, divisor: number): boolean => {
  const quotient = value / divisor;
  if (!Number.isFinite(quotient)) return false;
  if (Number.isInteger(divisor)) return value % divisor === 0;
  const slack = Math.min(
    MULTIPLE_OF_EPSILONS * Number.EPSILON * Math.abs(quotient),
    MULTIPLE_OF_MAX_SLACK,
  );
  return Math.abs(quotient - Math.round(quotient)) <= slack;
};

export const numberChecks: Check = ({ value, schema, path }, run) => {
  if (typeof value !== "number") return [];
  const bounds = NUMBER_BOUNDS.flatMap(({ key, fails, message }) => {
    const bound = schema[key];
    return bound !== undefined && fails(value, bound) ? [message(path, bound)] : [];
  });
  const { multipleOf } = schema;
  const multiple =
    multipleOf !== undefined && !isMultipleOf(value, multipleOf)
      ? [`${path}: not a multiple of ${multipleOf}`]
      : [];
  return spend(run, [...bounds, ...multiple]);
};

/** Length as the spec counts it: Unicode code points, not UTF-16 code units. */
export const codePointLength = (text: string): number => {
  let length = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    const next = text.charCodeAt(index + 1);
    const isPair = unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
    if (isPair) index += 1;
    length += 1;
  }
  return length;
};

/**
 * Length violations. A count is only taken when the UTF-16 length cannot decide:
 * code points are between half the code units and all of them.
 */
const lengthErrors = (visit: Visit, run: Run, text: string): string[] => {
  const { minLength = 0, maxLength } = visit.schema;
  const units = text.length;
  const mayBeShort = units < 2 * minLength;
  const mayBeLong = maxLength !== undefined && units > maxLength;
  if (!(mayBeShort || mayBeLong) || !chargeText(run, visit.path, text)) return [];
  const length = codePointLength(text);
  return [
    ...(length < minLength ? [`${visit.path}: shorter than minLength ${minLength}`] : []),
    ...(maxLength !== undefined && length > maxLength
      ? [`${visit.path}: longer than maxLength ${maxLength}`]
      : []),
  ];
};

export const stringChecks: Check = (visit, run) => {
  const { value, schema, path } = visit;
  if (typeof value !== "string") return [];
  const { pattern } = schema;
  const patternMiss =
    pattern !== undefined && !matchesPattern(run, { schema, path, source: pattern, text: value })
      ? [`${path}: does not match pattern ${echo(pattern)}`]
      : [];
  return spend(run, [...lengthErrors(visit, run, value), ...patternMiss]);
};
