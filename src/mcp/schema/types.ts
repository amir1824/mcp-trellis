/**
 * A JSON Schema 2020-12 object. Typed fields are the keywords the evaluator
 * understands; any other key is an annotation (`x-*`, `description`, …) or is
 * rejected at construction. A subschema may also be the boolean `true` / `false`.
 */
export type JsonSchema = {
  /** A single type, or a union (`["string", "null"]`) — both are evaluated. */
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema | boolean>;
  patternProperties?: Record<string, JsonSchema | boolean>;
  additionalProperties?: boolean | JsonSchema;
  propertyNames?: JsonSchema | boolean;
  required?: string[];
  minProperties?: number;
  maxProperties?: number;
  dependentRequired?: Record<string, string[]>;
  dependentSchemas?: Record<string, JsonSchema | boolean>;
  items?: JsonSchema | boolean;
  prefixItems?: Array<JsonSchema | boolean>;
  contains?: JsonSchema | boolean;
  minContains?: number;
  maxContains?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  allOf?: Array<JsonSchema | boolean>;
  anyOf?: Array<JsonSchema | boolean>;
  oneOf?: Array<JsonSchema | boolean>;
  not?: JsonSchema | boolean;
  if?: JsonSchema | boolean;
  then?: JsonSchema | boolean;
  else?: JsonSchema | boolean;
  /** Local references only: `#`, `#/$defs/name`, or `#anchor`. Never fetched. */
  $ref?: string;
  $defs?: Record<string, JsonSchema | boolean>;
  $anchor?: string;
  $schema?: string;
  description?: string;
  title?: string;
  [key: string]: unknown;
};

/**
 * A replacement for the built-in evaluator, for hosts that need full
 * JSON Schema coverage (for example a function wrapping Ajv). Receives the
 * untrusted value and the developer-authored schema; returns one short message
 * per violation, `[]` when valid. It must not throw and must not echo `value`.
 */
export type SchemaValidator = (value: unknown, schema: JsonSchema) => string[];
