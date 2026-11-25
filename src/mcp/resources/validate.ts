/** Construction-time checks of `resources`: every violation is listed at once, nothing is fixed up. */

import { isJsonObject } from "../../util/json.js";
import { SKILL_URI_SCHEME } from "../skills/types.js";
import { shownName } from "../tools/call-args.js";
import { UI_MIME_TYPE, UI_RESOURCE_SCHEME } from "../ui/types.js";
import type { ResourceDef } from "./types.js";
import { uriShapeViolations } from "./uri.js";

const MIME_PARAMETER_SEPARATOR = ";";
const [APP_ESSENCE = "", APP_PARAMETER = ""] = UI_MIME_TYPE.split(MIME_PARAMETER_SEPARATOR);

/** The MCP Apps type however it is spelled: case, spaces, quotes and extra parameters do not matter. */
export const isAppMimeType = (mimeType: string): boolean => {
  const [essence = "", ...parameters] = mimeType
    .toLowerCase()
    .replace(/[\s"]/g, "")
    .split(MIME_PARAMETER_SEPARATOR);
  return essence === APP_ESSENCE && parameters.includes(APP_PARAMETER);
};

const isOptional = (value: unknown, type: "string" | "function"): boolean =>
  value === undefined || typeof value === type;

const uriViolations = (uri: unknown, seen: ReadonlySet<string>): string[] => {
  if (typeof uri !== "string") return ["uri must be a string"];
  const violations = uriShapeViolations(uri);
  if (uri.startsWith(UI_RESOURCE_SCHEME)) {
    violations.push(`uri may not use "${UI_RESOURCE_SCHEME}", which uiResources owns`);
  }
  if (uri.startsWith(SKILL_URI_SCHEME)) {
    violations.push(`uri may not use "${SKILL_URI_SCHEME}", which skills owns`);
  }
  if (seen.has(uri)) violations.push("uri is a duplicate");
  return violations;
};

const fieldViolations = (def: Record<string, unknown>): string[] => {
  const { name, description, mimeType, scope, allow, read } = def;
  const violations: string[] = [];
  if (typeof name !== "string" || name.trim() === "") {
    violations.push("name must be a non-empty string");
  }
  if (!isOptional(description, "string")) violations.push("description must be a string");
  if (!isOptional(mimeType, "string") || mimeType === "") {
    violations.push("mimeType must be a non-empty string");
  }
  if (typeof mimeType === "string" && isAppMimeType(mimeType)) {
    violations.push(`mimeType may not be "${UI_MIME_TYPE}", which uiResources owns`);
  }
  if (scope !== null && !isOptional(scope, "string")) {
    violations.push("scope must be a string or null");
  }
  if (!isOptional(allow, "function")) violations.push("allow must be a function");
  if (typeof read !== "function") violations.push("read must be a function");
  return violations;
};

/** Every violation of `resources`, each prefixed with the entry it belongs to. */
export const resourceViolations = <TCtx>(resources: ReadonlyArray<ResourceDef<TCtx>>): string[] => {
  const seen = new Set<string>();
  return resources.flatMap((def, index) => {
    if (!isJsonObject(def)) return [`resources[${index}] must be an object`];
    const label = typeof def.uri === "string" ? shownName(def.uri) : String(index);
    const violations = [...uriViolations(def.uri, seen), ...fieldViolations(def)];
    if (typeof def.uri === "string") seen.add(def.uri);
    return violations.map((violation) => `resources ${label}: ${violation}`);
  });
};
