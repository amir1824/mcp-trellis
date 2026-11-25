/**
 * `resources/list` and `resources/read` for MCP Apps UI documents and general resources. Both need an
 * authenticated principal, and every answer is built per request: no state, no cache, nothing keyed by
 * principal. `context` is built only for an authorized general read.
 */

import { isJsonObject } from "../../util/json.js";
import { clientSupports } from "../modern/extensions.js";
import { DENIAL_REASONS } from "../request-policy.js";
import { shownName } from "../tools/call-args.js";
import type { RpcMethodHandler } from "../types.js";
import { uiReadMeta } from "../ui/meta.js";
import { UI_EXTENSION_ID, UI_MIME_TYPE } from "../ui/types.js";
import { accessFor, requestAccess } from "./access.js";
import {
  anonymousResponse,
  auditResource,
  deniedResponse,
  invalidParamsResponse,
  type ResourceCall,
  unknownResponse,
} from "./outcome.js";
import { readGeneral } from "./read.js";
import { DEFAULT_RESOURCE_MIME_TYPE, type ResourceEntry } from "./types.js";

const NO_RESOURCES: ReadonlyMap<string, never> = new Map<string, never>();

/**
 * UI documents are listed, for the principals allowed to read them. The spec only says servers "MAY omit
 * UI-only resources from `resources/list`" and its discovery sequence shows `ui://` resources in the list,
 * so nothing in it asks to hide them; the list stays access-filtered and carries no csp or permissions.
 */
const listEntry = <TCtx>(entry: ResourceEntry<TCtx>) => {
  if (entry.kind === "ui") {
    const { uri, name, description } = entry.resource;
    return {
      uri,
      name: name ?? uri,
      ...(description !== undefined ? { description } : {}),
      mimeType: UI_MIME_TYPE,
    };
  }
  const { uri, name, description, mimeType } = entry.def;
  return {
    uri,
    name,
    ...(description !== undefined ? { description } : {}),
    mimeType: mimeType ?? DEFAULT_RESOURCE_MIME_TYPE,
  };
};

/** Built only after `accessFor` allowed the read: the document and every `_meta.ui` field leave here. */
const uiBody = (entry: Extract<ResourceEntry<unknown>, { kind: "ui" }>, uri: string) => {
  const { resource } = entry;
  return {
    contents: [
      {
        uri,
        mimeType: UI_MIME_TYPE,
        ...(resource.blob !== undefined ? { blob: resource.blob } : { text: resource.html }),
        ...uiReadMeta(resource),
      },
    ],
  };
};

export const RESOURCE_METHODS = {
  "resources/list": async ({ req, id, principal, options, startedAt, respond, client }) => {
    const call = { method: "resources/list", req, id, principal, options, startedAt } as const;
    if (!principal) return anonymousResponse(call);

    const accessOf = requestAccess<unknown>(principal);
    const resources = [...(options.resourceCatalog ?? NO_RESOURCES).values()]
      .filter((entry) => entry.kind !== "ui" || clientSupports(client, UI_EXTENSION_ID))
      .filter((entry) => accessOf(entry).allowed)
      .map(listEntry);
    await auditResource(call);
    return respond(id, { resources });
  },

  "resources/read": async ({ req, body, id, principal, options, startedAt, respond, client }) => {
    const call: ResourceCall<unknown> = {
      method: "resources/read",
      req,
      id,
      principal,
      options,
      startedAt,
    };
    if (!principal) return anonymousResponse(call);

    const uri = isJsonObject(body.params) ? body.params.uri : undefined;
    if (typeof uri !== "string") return invalidParamsResponse(call);

    const entry = (options.resourceCatalog ?? NO_RESOURCES).get(uri);
    // A `ui://` document is core-protocol invisible to a client that did not declare MCP Apps.
    const hidden = entry?.kind === "ui" && !clientSupports(client, UI_EXTENSION_ID);
    if (!entry || hidden)
      return unknownResponse(call, { uri, reason: DENIAL_REASONS.unknownResource });

    const access = accessFor(entry, principal);
    if (!access.allowed) return deniedResponse(call, { uri, access });

    if (entry.kind === "general") return readGeneral(call, { def: entry.def, respond });
    await auditResource(call, { resource: shownName(uri) });
    return respond(id, uiBody(entry, uri));
  },
} as const satisfies Record<string, RpcMethodHandler<unknown>>;
