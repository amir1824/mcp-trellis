/** Construction-time checks of `resources`: every violation is listed at once, nothing is fixed up. */

import { isJsonObject } from "../../util/json.js";
import { shownName } from "../tools/call-args.js";
import { UI_MIME_TYPE, UI_RESOURCE_SCHEME } from "../ui/types.js";
import type { ResourceDef } from "./types.js";

/** RFC 3986 `unreserved`, `reserved` and `%`: every ASCII character a URI may carry. */
const URI_CHARACTERS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
const LOWERCASE_SCHEME = /^[a-z][a-z0-9+.-]*:/;
const MAX_URI_LENGTH = 512;

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
  const violations: string[] = [];
  if (!URI_CHARACTERS.test(uri)) violations.push("uri must hold only RFC 3986 ASCII characters");
  if (!LOWERCASE_SCHEME.test(uri)) violations.push("uri must start with a lowercase `scheme:`");
  if (uri.length > MAX_URI_LENGTH) violations.push(`uri is over ${MAX_URI_LENGTH} characters`);
  if (uri.startsWith(UI_RESOURCE_SCHEME)) {
    violations.push(`uri may not use "${UI_RESOURCE_SCHEME}", which uiResources owns`);
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
