/** The extensions a 2026-07-28 client declared on one request, and the check a handler makes before relying on one. */

import { isJsonObject } from "../../util/json.js";
import { UI_EXTENSION_ID, UI_MIME_TYPE } from "../ui/types.js";

type ExtensionSettings = Record<string, unknown>;

/** What a request carries per call; `undefined` on a request that is not 2026-07-28 (no per-request capabilities). */
export type ClientContext = {
  /** Extension id to the settings object the client sent for it. A key is present only when declared. */
  extensions: ReadonlyMap<string, ExtensionSettings>;
};

/**
 * Reads `clientCapabilities.extensions`. Tolerant: the spec only requires `clientCapabilities` itself, so
 * `extensions` that is not an object, or an entry that is not an object, counts as not declared.
 */
export const clientContextOf = (capabilities: Record<string, unknown>): ClientContext => {
  const { extensions } = capabilities;
  return {
    extensions: new Map(
      isJsonObject(extensions)
        ? Object.entries(extensions).filter((entry): entry is [string, ExtensionSettings] =>
            isJsonObject(entry[1]),
          )
        : [],
    ),
  };
};

/**
 * What an extension's declared settings must hold before the server relies on it; an extension with no
 * rule needs only its key. MCP Apps marks `mimeTypes` required and its server sample checks that the
 * list includes the app type, so `{}` declares nothing usable.
 */
const SETTINGS_RULES: ReadonlyMap<string, (settings: ExtensionSettings) => boolean> = new Map([
  [
    UI_EXTENSION_ID,
    ({ mimeTypes }) => Array.isArray(mimeTypes) && mimeTypes.includes(UI_MIME_TYPE),
  ],
]);

/**
 * Whether a handler may rely on extension `extensionId`. A request without a `ClientContext` is a legacy
 * one: it declares nothing per request, so nothing is withheld from it.
 */
export const clientSupports = (client: ClientContext | undefined, extensionId: string): boolean => {
  if (client === undefined) return true;
  const settings = client.extensions.get(extensionId);
  if (settings === undefined) return false;
  return SETTINGS_RULES.get(extensionId)?.(settings) ?? true;
};
