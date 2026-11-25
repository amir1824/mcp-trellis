/** Construction-time checks of every tool's `inputSchema` for argument validation. */

import { missingObjectType, unsupportedKeywords } from "../../schema/check.js";
import type { JsonSchema } from "../../schema/types.js";

/** Throws with every violation listed at once, rather than failing on the first tool found. */
export const assertToolSchemasValid = (
  tools: ReadonlyArray<{ name: string; inputSchema: JsonSchema }>,
): void => {
  const keywordViolations = tools.flatMap((tool) =>
    unsupportedKeywords(tool.inputSchema).map(
      (path) => `${tool.name}: unsupported JSON Schema keyword at ${path}`,
    ),
  );
  if (keywordViolations.length > 0) {
    throw new Error(
      `validateArgs: true but inputSchema uses unsupported keywords:\n` +
        keywordViolations.join("\n") +
        "\nRemove the keyword, enforce it in the handler, or set validateArgs: false",
    );
  }

  // `properties`/`required` without `type: "object"` validates nothing at
  // that node, and passes the keyword check above. See `missingObjectType`.
  const typeViolations = tools.flatMap((tool) =>
    missingObjectType(tool.inputSchema).map(
      (path) => `${tool.name}: ${path} uses properties/required without type: "object"`,
    ),
  );
  if (typeViolations.length > 0) {
    throw new Error(
      `validateArgs: true but inputSchema implies an object shape without declaring it:\n` +
        typeViolations.join("\n") +
        '\nAdd type: "object" (or include it in a union), or set validateArgs: false',
    );
  }
};
