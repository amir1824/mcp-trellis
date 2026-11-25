/**
 * Bounds of the non-backtracking `pattern` matcher. This library's choice; the cost of one
 * match is at most (input code points + 1) x program size instruction visits, whatever the pattern.
 */

/** Longest `pattern` source accepted, in code points. */
export const MAX_REGEX_SOURCE_LENGTH = 512;

/**
 * Most instructions a compiled pattern may have. Counted repeats are expanded (`a{0,9999}` is
 * 9999 copies), so this bounds both the memory of a program and the work per input character.
 */
export const MAX_REGEX_PROGRAM_SIZE = 2000;

/** Deepest nesting of groups in a pattern; the parser recurses once per level. */
export const MAX_REGEX_GROUP_DEPTH = 32;

/** Instruction visits that cost one unit of the evaluator's step budget. */
export const REGEX_VISITS_PER_STEP = 64;
