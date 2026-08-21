export type JsonSchema = {
  /** A single type, or a union (`["string", "null"]`) — both are evaluated. */
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  description?: string;
  title?: string;
  [key: string]: unknown;
};

/** Keywords `validateAgainstSchema` actually evaluates. */
export const SUPPORTED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "enum",
  "required",
  "properties",
  "items",
  "minimum",
  "maximum",
]);

/**
 * Allowed on inputSchema but never evaluated (tools/list / generator metadata).
 * Semantically-enforcing keywords (`pattern`, `additionalProperties`, …) are
 * not ignored — with `validateArgs: true` they throw at construction.
 */
export const IGNORED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "description",
  "title",
  "$schema",
  "$id",
  "$comment",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "format",
]);

/**
 * Paths of keywords outside the evaluated subset, e.g. `args.properties.code.pattern`.
 * Walks nested `properties` / `items`.
 */
export const unsupportedKeywords = (schema: JsonSchema, path = "args"): string[] => {
  const local = Object.keys(schema).flatMap((key) =>
    SUPPORTED_SCHEMA_KEYWORDS.has(key) || IGNORED_SCHEMA_KEYWORDS.has(key)
      ? []
      : [`${path}.${key}`],
  );
  const fromProperties = Object.entries(schema.properties ?? {}).flatMap(([key, child]) =>
    unsupportedKeywords(child, `${path}.properties.${key}`),
  );
  const fromItems = schema.items ? unsupportedKeywords(schema.items, `${path}.items`) : [];
  return [...local, ...fromProperties, ...fromItems];
};

/**
 * Paths where `properties`/`required` implies an object shape but `type`
 * doesn't say so — absent, or a single type/union not including
 * `"object"`. Without this, `{ properties: { x: { type: "string" } },
 * required: ["x"] }` validates *any* input, `{}` included: `typeMismatch`
 * short-circuits on a missing `type`, and the object-specific checks below
 * only ran when `schema.type === "object"`. Walks nested
 * `properties`/`items` the same way `unsupportedKeywords` does. Under
 * `validateArgs: true` this throws at construction instead of silently
 * validating nothing at runtime — `validateNode`'s dispatch-by-actual-type
 * (see below) is the separate runtime backstop for schemas that reach
 * validation unchecked (e.g. loaded from outside the tool definition).
 */
export const missingObjectType = (schema: JsonSchema, path = "args"): string[] => {
  const declaredTypes = schema.type
    ? Array.isArray(schema.type)
      ? schema.type
      : [schema.type]
    : [];
  const impliesObject = schema.properties !== undefined || schema.required !== undefined;
  const local = impliesObject && !declaredTypes.includes(JSON_SCHEMA_TYPES.object) ? [path] : [];
  const fromProperties = Object.entries(schema.properties ?? {}).flatMap(([key, child]) =>
    missingObjectType(child, `${path}.properties.${key}`),
  );
  const fromItems = schema.items ? missingObjectType(schema.items, `${path}.items`) : [];
  return [...local, ...fromProperties, ...fromItems];
};

export const JSON_SCHEMA_TYPES = {
  string: "string",
  number: "number",
  integer: "integer",
  boolean: "boolean",
  object: "object",
  array: "array",
  null: "null",
} as const;

type TypeChecker = (value: unknown, schema: JsonSchema, path: string) => string[];

const runtimeTypeOf = (value: unknown): string => {
  if (value === null) return JSON_SCHEMA_TYPES.null;
  if (Array.isArray(value)) return JSON_SCHEMA_TYPES.array;
  return typeof value;
};

const TYPE_MATCHERS: Record<string, (actual: string, value: unknown) => boolean> = {
  [JSON_SCHEMA_TYPES.integer]: (actual, value) =>
    actual === JSON_SCHEMA_TYPES.number && Number.isInteger(value),
};

const matchesDeclaredType = (actual: string, value: unknown, declared: string): boolean =>
  TYPE_MATCHERS[declared]?.(actual, value) ?? actual === declared;

/** `schema.type` as an array either way — a single type is a union of one. */
const declaredTypesOf = (schema: JsonSchema): string[] =>
  schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];

const typeMismatch = (value: unknown, schema: JsonSchema, path: string): string[] => {
  const declared = declaredTypesOf(schema);
  if (declared.length === 0) return [];
  const actual = runtimeTypeOf(value);
  const matches = declared.some((type) => matchesDeclaredType(actual, value, type));
  return matches ? [] : [`${path}: expected ${declared.join(" | ")}, got ${actual}`];
};

const enumErrors = (value: unknown, schema: JsonSchema, path: string): string[] => {
  if (!schema.enum || schema.enum.includes(value)) return [];
  return [`${path}: value not in enum`];
};

const RANGE_BOUNDS: Array<{
  key: "minimum" | "maximum";
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
];

const rangeErrors: TypeChecker = (value, schema, path) => {
  if (typeof value !== "number") return [];
  return RANGE_BOUNDS.flatMap(({ key, fails, message }) => {
    const bound = schema[key];
    if (bound === undefined || !fails(value, bound)) return [];
    return [message(path, bound)];
  });
};

const objectErrors: TypeChecker = (value, schema, path) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const requiredErrors = (schema.required ?? [])
    .filter((key) => !(key in record))
    .map((key) => `${path}.${key}: required`);
  const propertyErrors = Object.entries(schema.properties ?? {})
    .filter(([key]) => key in record)
    .flatMap(([key, propSchema]) => validateNode(record[key], propSchema, `${path}.${key}`));
  return [...requiredErrors, ...propertyErrors];
};

const arrayErrors: TypeChecker = (value, schema, path) => {
  const items = schema.items;
  if (!Array.isArray(value) || !items) return [];
  return value.flatMap((entry, index) => validateNode(entry, items, `${path}[${index}]`));
};

const TYPE_CHECKERS: Record<string, TypeChecker> = {
  [JSON_SCHEMA_TYPES.object]: objectErrors,
  [JSON_SCHEMA_TYPES.array]: arrayErrors,
  [JSON_SCHEMA_TYPES.number]: rangeErrors,
  [JSON_SCHEMA_TYPES.integer]: rangeErrors,
};

const validateNode = (value: unknown, schema: JsonSchema, path: string): string[] => {
  const typeErrors = typeMismatch(value, schema, path);
  if (typeErrors.length > 0) return typeErrors;
  // Dispatch on the value's own runtime shape, not the declared type
  // string(s). By this point `typeMismatch` has already confirmed `value`
  // is consistent with whatever was declared (or nothing was declared at
  // all) — so this is always safe, handles a union type correctly with no
  // extra cases, and is what makes `objectErrors` run for a type-less
  // schema whose `properties`/`required` clearly mean "object" even
  // though `type` doesn't say so (the construction-time
  // `missingObjectType` check is the primary guard; this is the runtime
  // backstop for a schema that reaches validation unchecked).
  const actual = runtimeTypeOf(value);
  return [
    ...enumErrors(value, schema, path),
    ...(TYPE_CHECKERS[actual]?.(value, schema, path) ?? []),
  ];
};

/** Minimal JSON Schema subset used by MCP tool inputSchema. Empty = valid. */
export const validateAgainstSchema = (value: unknown, schema: JsonSchema): string[] =>
  validateNode(value, schema, "args");
