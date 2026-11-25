import { compileRegex, type Program } from "./compile.js";
import { parseRegex, RegexError } from "./parse.js";

/** A pattern compiled once, or why it cannot be: the text names the unsupported construct. */
export type CompiledPattern = { program: Program } | { problem: string };

/**
 * Compiles a JSON Schema `pattern` (ECMAScript syntax, unicode mode) for the non-backtracking
 * matcher. Never throws: anything outside the supported subset (`docs/reference.md`) is a `problem`,
 * and a problem is never a partial acceptance.
 */
export const compilePattern = (source: string): CompiledPattern => {
  try {
    return { program: compileRegex(parseRegex(source)) };
  } catch (error) {
    if (error instanceof RegexError) return { problem: error.message };
    throw error;
  }
};
