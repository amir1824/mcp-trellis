import { clipText } from "../../util/clip.js";
import { isJsonObject } from "../../util/json.js";
import {
  hasSupportedShape,
  isAnnotationKeyword,
  isSupportedDialect,
  legacyKeywordReason,
} from "./keywords.js";
import { MAX_ECHOED_TEXT_LENGTH } from "./limits.js";
import type { Program } from "./regex/compile.js";
import { compilePattern } from "./regex/pattern.js";
import type { JsonSchema } from "./types.js";

/** A keyword on one schema node the evaluator cannot honour; `reason` is absent for an unknown keyword. */
export type NodeProblem = { keyword: string; reason?: string };

/** What is learned once about a schema node: its problems and its compiled regular expressions. */
export type NodeInfo = {
  problems: readonly NodeProblem[];
  patterns: ReadonlyMap<string, Program>;
};

const REASON_DIALECT = "unsupported dialect";
const REASON_REMOTE_REF = "non-local $ref";
const REASON_VALUE = "invalid value";

/** Only `#`, `#/pointer` and `#anchor` stay inside the document; anything else could be a network URI. */
export const isLocalRef = (ref: string): boolean => ref.startsWith("#");

const regexSources = (keyword: string, value: unknown): string[] => {
  if (keyword === "pattern") return [value as string];
  return keyword === "patternProperties" && isJsonObject(value) ? Object.keys(value) : [];
};

const problemOf = (keyword: string, value: unknown): NodeProblem | undefined => {
  if (keyword === "$schema") {
    return isSupportedDialect(value) ? undefined : { keyword, reason: REASON_DIALECT };
  }
  const legacy = legacyKeywordReason(keyword, value);
  if (legacy !== undefined) return { keyword, reason: legacy };
  if (isAnnotationKeyword(keyword)) return undefined;
  const shaped = hasSupportedShape(keyword, value);
  if (shaped === undefined) return { keyword };
  if (!shaped) return { keyword, reason: REASON_VALUE };
  if (keyword === "$ref" && !isLocalRef(value as string)) {
    return { keyword, reason: REASON_REMOTE_REF };
  }
  return undefined;
};

const regexReason = (keyword: string, source: string, problem: string): string =>
  `unsupported regex syntax for ${keyword}${keyword === "pattern" ? "" : ` "${clipText(source, MAX_ECHOED_TEXT_LENGTH, "…")}"`}: ${problem}; simplify it or pass a schemaValidator`;

const analyse = (schema: JsonSchema): NodeInfo => {
  const patterns = new Map<string, Program>();
  const problems = Object.entries(schema).flatMap(([keyword, value]): NodeProblem[] => {
    const problem = problemOf(keyword, value);
    if (problem) return [problem];
    return regexSources(keyword, value).flatMap((source): NodeProblem[] => {
      const compiled = compilePattern(source);
      if ("problem" in compiled) {
        return [{ keyword, reason: regexReason(keyword, source, compiled.problem) }];
      }
      patterns.set(source, compiled.program);
      return [];
    });
  });
  return { problems, patterns };
};

const INFO = new WeakMap<JsonSchema, NodeInfo>();

/**
 * Parses one schema node once (keyword values, dialect, local `$ref`, regular
 * expressions) and remembers the result per object, so validation trusts the
 * node afterwards and each regex compiles once. A schema is treated as
 * immutable once handed to the library: editing it later is not noticed.
 */
export const nodeInfo = (schema: JsonSchema): NodeInfo => {
  const known = INFO.get(schema);
  if (known) return known;
  const info = analyse(schema);
  INFO.set(schema, info);
  return info;
};
