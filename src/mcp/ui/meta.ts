/** The `_meta.ui` of a UI resource: checked once at construction, then shaped for `resources/read`. */

import { isJsonObject } from "../../util/json.js";
import { isExactOrigin } from "./csp.js";
import type { UiPermissions, UiResource } from "./types.js";

const PERMISSION_KEYS = ["camera", "microphone", "geolocation", "clipboardWrite"] as const;

/** A scheme is only borrowed so `domain` gets the same host, port and no-userinfo check as a CSP origin. */
const DOMAIN_SCHEME = "https://";

/** A normalized copy of `permissions`, or throws: only the four spec keys, each exactly `{}`. */
export const parsePermissions = (permissions: unknown): UiPermissions => {
  if (!isJsonObject(permissions)) throw new Error("permissions must be an object");
  const extra = Object.keys(permissions).filter(
    (key) => !(PERMISSION_KEYS as readonly string[]).includes(key),
  );
  if (extra.length > 0) {
    throw new Error(
      `permissions has unsupported keys: ${extra.join(", ")} (allowed: ${PERMISSION_KEYS.join(", ")})`,
    );
  }
  const asked = PERMISSION_KEYS.filter((key) => permissions[key] !== undefined);
  for (const key of asked) {
    const value = permissions[key];
    if (!isJsonObject(value) || Object.keys(value).length > 0) {
      throw new Error(`permissions.${key} must be an empty object {}`);
    }
  }
  return Object.fromEntries(asked.map((key) => [key, {}]));
};

/** The `domain` itself, or throws unless it is a bare lower-case DNS host with an optional port. */
export const parseDomain = (domain: unknown): string => {
  if (typeof domain === "string" && isExactOrigin(`${DOMAIN_SCHEME}${domain}`, ["https:"])) {
    return domain;
  }
  throw new Error(
    `domain ${JSON.stringify(domain)} must be a bare lower-case host with an optional port, no scheme, path or wildcard`,
  );
};

/** `prefersBorder` itself, or throws unless it is a boolean. */
export const parsePrefersBorder = (value: unknown): boolean => {
  if (typeof value === "boolean") return value;
  throw new Error("prefersBorder must be a boolean");
};

/** What `resources/read` carries under `_meta`: only what was declared, and no `_meta` at all when nothing was. */
export const uiReadMeta = ({
  csp,
  permissions,
  domain,
  prefersBorder,
}: UiResource): { _meta?: { ui: object } } => {
  const ui = {
    ...(csp !== undefined ? { csp } : {}),
    ...(permissions !== undefined ? { permissions } : {}),
    ...(domain !== undefined ? { domain } : {}),
    ...(prefersBorder !== undefined ? { prefersBorder } : {}),
  };
  return Object.keys(ui).length > 0 ? { _meta: { ui } } : {};
};
