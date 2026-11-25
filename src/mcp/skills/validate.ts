/** Construction-time checks of one skill: every violation is listed, nothing is fixed up. */

import { isJsonObject } from "../../util/json.js";
import { isAppMimeType } from "../resources/validate.js";
import { shownName } from "../tools/call-args.js";
import { SKILL_FILE_NAME } from "./types.js";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A segment starts with a letter, digit or `_`: no `.`, `..` or empty segment. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
/** Control characters, line and paragraph separators and noncharacters: refused in frontmatter. */
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}\p{Noncharacter_Code_Point}]/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const RESERVED_KEY = /^(?:allowed-tools$|io\.modelcontextprotocol\/)/i;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
const MAX_PATH = 200;

const check = (ok: boolean, message: string): string[] => (ok ? [] : [message]);
const wellFormed = (value: unknown): value is string =>
  typeof value === "string" && !LONE_SURROGATE.test(value);
const isText = (value: unknown): value is string => wellFormed(value) && !CONTROL.test(value);
const optional = (value: unknown, type: string): boolean =>
  value === undefined || typeof value === type;

const metadataViolations = (metadata: unknown): string[] =>
  metadata === undefined
    ? []
    : check(isJsonObject(metadata), "metadata must be an object of strings").concat(
        Object.entries(isJsonObject(metadata) ? metadata : {}).flatMap(([key, value]) => [
          ...check(
            key !== "" && !RESERVED_KEY.test(key) && !CONTROL.test(key),
            `metadata key "${shownName(key)}" is not allowed`,
          ),
          ...check(
            isText(value),
            `metadata "${shownName(key)}" must be text without control characters`,
          ),
        ]),
      );

const pathViolations = (path: unknown, seen: ReadonlySet<string>): string[] => {
  if (typeof path !== "string") return ["file path must be a string"];
  const shown = shownName(path);
  const segments = path.split("/");
  return [
    ...check(
      path.length <= MAX_PATH && segments.every((part) => SEGMENT.test(part)),
      `file path "${shown}" must be relative segments of A-Z a-z 0-9 _ . -, none starting with "." or "-", at most ${MAX_PATH} characters`,
    ),
    ...check(
      segments.at(-1)?.toLowerCase() !== SKILL_FILE_NAME.toLowerCase(),
      `file path "${shown}" collides with ${SKILL_FILE_NAME}`,
    ),
    ...check(!seen.has(path.toLowerCase()), `file path "${shown}" is a duplicate`),
  ];
};

const fileViolations = (files: unknown): string[] => {
  if (files === undefined) return [];
  if (!Array.isArray(files)) return ["files must be an array"];
  const seen = new Set<string>();
  return files.flatMap((file: unknown, index) => {
    if (!isJsonObject(file)) return [`files[${index}] must be an object`];
    const { path, text, mimeType } = file;
    const violations = [
      ...pathViolations(path, seen),
      ...check(wellFormed(text), `file ${index} text must be well-formed text`),
      ...check(
        optional(mimeType, "string") && mimeType !== "",
        "mimeType must be a non-empty string",
      ),
      ...check(
        typeof mimeType !== "string" || !isAppMimeType(mimeType),
        "mimeType may not be the MCP Apps type",
      ),
    ];
    if (typeof path === "string") seen.add(path.toLowerCase());
    return violations;
  });
};

const fieldViolations = (def: Record<string, unknown>): string[] => {
  const { description, instructions, scope, allow } = def;
  return [
    ...check(
      isText(description) && description.trim() !== "" && description.length <= MAX_DESCRIPTION,
      `description must be 1 to ${MAX_DESCRIPTION} characters without control characters`,
    ),
    ...check(wellFormed(instructions), "instructions must be well-formed text"),
    ...metadataViolations(def.metadata),
    ...check(scope === null || optional(scope, "string"), "scope must be a string or null"),
    ...check(optional(allow, "function"), "allow must be a function"),
    ...fileViolations(def.files),
  ];
};

/** Every violation of one entry of `skills`, prefixed with its skill; adds its name to `seen`. */
export const skillViolations = (
  def: unknown,
  input: { index: number; seen: Set<string> },
): string[] => {
  const { index, seen } = input;
  if (!isJsonObject(def)) return [`skills[${index}] must be an object`];
  const { name } = def;
  const violations = [
    ...check(
      typeof name === "string" && NAME.test(name) && name.length <= MAX_NAME,
      `name must be 1 to ${MAX_NAME} lowercase letters, digits and single hyphens, with none at either end`,
    ),
    ...check(typeof name !== "string" || !seen.has(name), "name is a duplicate"),
    ...fieldViolations(def),
  ];
  if (typeof name === "string") seen.add(name);
  return violations.map((violation) => `skills ${shownName(String(name ?? index))}: ${violation}`);
};
