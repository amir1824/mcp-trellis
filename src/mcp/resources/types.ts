/** The shapes a host registers general resources with, and the one catalog every `resources/*` method reads. */

import type { Principal } from "../types.js";
import type { UiEntry } from "../ui/registry.js";

/** The type of a general resource that names none. */
export const DEFAULT_RESOURCE_MIME_TYPE = "text/plain";

/** What a provider returns when it needs a content type of its own. Text only. */
export type ResourceBody = {
  text: string;
  /** Overrides `ResourceDef.mimeType`. Never the MCP Apps type, which belongs to `uiResources`. */
  mimeType?: string | undefined;
};

export type ResourceDef<TCtx> = {
  /** A fixed, unique URI (RFC 3986, ASCII, lowercase scheme, at most 512 characters). Never `ui://`. */
  uri: string;
  name: string;
  description?: string | undefined;
  /** Default `"text/plain"`. Never the MCP Apps type. */
  mimeType?: string | undefined;
  /** Same rule as a tool's `scope`: omitted, `null` or `""` means any authenticated principal. */
  scope?: string | null | undefined;
  /**
   * An extra rule on top of `scope`, evaluated synchronously for every list and read. `true` allows;
   * anything else, or a throw, denies. A denial here always answers like an unknown URI.
   */
  allow?: ((principal: Principal) => boolean) | undefined;
  /**
   * Builds the body. Called once per authorized read, with the context built for that request, and never
   * for a list. A throw or a malformed result answers a fixed "Resource read failed".
   */
  read: (ctx: TCtx) => ResourceBody | string | Promise<ResourceBody | string>;
};

/** A UI document keeps its static body and the scopes of the tools that reference it. */
export type UiCatalogEntry = { kind: "ui" } & UiEntry;

export type GeneralCatalogEntry<TCtx> = { kind: "general"; def: ResourceDef<TCtx> };

export type ResourceEntry<TCtx> = UiCatalogEntry | GeneralCatalogEntry<TCtx>;

/** Keyed by URI in a `Map`: a request's `uri` is never looked up as an object key. */
export type ResourceCatalog<TCtx> = ReadonlyMap<string, ResourceEntry<TCtx>>;
