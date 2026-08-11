export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  description?: string;
  [key: string]: unknown;
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

type TypeChecker = (
  value: unknown,
  schema: JsonSchema,
  path: string,
) => string[];

const runtimeTypeOf = (value: unknown): string => {
  if (value === null) return JSON_SCHEMA_TYPES.null;
  if (Array.isArray(value)) return JSON_SCHEMA_TYPES.array;
  return typeof value;
};

const TYPE_MATCHERS: Record<
  string,
  (actual: string, value: unknown) => boolean
> = {
  [JSON_SCHEMA_TYPES.integer]: (actual, value) =>
    actual === JSON_SCHEMA_TYPES.number && Number.isInteger(value),
};

const typeMismatch = (
  value: unknown,
  schema: JsonSchema,
  path: string,
): string[] => {
  if (!schema.type) return [];
  const actual = runtimeTypeOf(value);
  const matches =
    TYPE_MATCHERS[schema.type]?.(actual, value) ?? actual === schema.type;
  return matches ? [] : [`${path}: expected ${schema.type}, got ${actual}`];
};

const enumErrors = (
  value: unknown,
  schema: JsonSchema,
  path: string,
): string[] => {
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
    .flatMap(([key, propSchema]) =>
      validateNode(record[key], propSchema, `${path}.${key}`),
    );
  return [...requiredErrors, ...propertyErrors];
};

const arrayErrors: TypeChecker = (value, schema, path) => {
  if (!Array.isArray(value) || !schema.items) return [];
  return value.flatMap((entry, index) =>
    validateNode(entry, schema.items!, `${path}[${index}]`),
  );
};

const TYPE_CHECKERS: Record<string, TypeChecker> = {
  [JSON_SCHEMA_TYPES.object]: objectErrors,
  [JSON_SCHEMA_TYPES.array]: arrayErrors,
  [JSON_SCHEMA_TYPES.number]: rangeErrors,
  [JSON_SCHEMA_TYPES.integer]: rangeErrors,
};

const validateNode = (
  value: unknown,
  schema: JsonSchema,
  path: string,
): string[] => {
  const typeErrors = typeMismatch(value, schema, path);
  if (typeErrors.length > 0) return typeErrors;
  return [
    ...enumErrors(value, schema, path),
    ...(TYPE_CHECKERS[schema.type ?? ""]?.(value, schema, path) ?? []),
  ];
};

/** Minimal JSON Schema subset used by MCP tool inputSchema. Empty = valid. */
export const validateAgainstSchema = (
  value: unknown,
  schema: JsonSchema,
): string[] => validateNode(value, schema, "args");
