import assert from "node:assert/strict";
import { it } from "node:test";
import type { JsonSchema } from "../../../src/mcp/schema/types.js";
import { validateAgainstSchema } from "../../../src/mcp/schema/validate.js";

/** One case: what it shows, the schema, the instance, and the exact violations (`[]` = valid). */
export type Row = [label: string, schema: JsonSchema, instance: unknown, expected: string[]];

export const checkRows = (rows: Row[]): void => {
  rows.forEach(([label, schema, instance, expected]) => {
    it(label, () => {
      assert.deepEqual(validateAgainstSchema(instance, schema), expected);
    });
  });
};
