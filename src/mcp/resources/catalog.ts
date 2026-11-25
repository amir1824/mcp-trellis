/** The one catalog `resources/list` and `resources/read` serve from: UI documents first, then general resources. */

import type { ToolRegistry } from "../registry.js";
import { buildUiRegistry } from "../ui/registry.js";
import type { UiResource } from "../ui/types.js";
import type { ResourceCatalog, ResourceDef, ResourceEntry } from "./types.js";
import { resourceViolations } from "./validate.js";

type CatalogSources<TCtx> = {
  uiResources?: UiResource[] | undefined;
  resources?: ResourceDef<TCtx>[] | undefined;
};

/** A copy of the fields the server reads, so a host mutating its object later changes nothing. */
const generalEntry = <TCtx>(def: ResourceDef<TCtx>): [string, ResourceEntry<TCtx>] => {
  const { uri, name, description, mimeType, scope, allow, read } = def;
  return [uri, { kind: "general", def: { uri, name, description, mimeType, scope, allow, read } }];
};

/**
 * `undefined` when the server has neither UI documents nor general resources (the feature stays off).
 * Fails closed: `buildUiRegistry` lists the UI problems, then every `resources` problem is listed at once.
 */
export const buildResourceCatalog = <TCtx>(
  registry: ToolRegistry<TCtx>,
  { uiResources, resources = [] }: CatalogSources<TCtx>,
): ResourceCatalog<TCtx> | undefined => {
  const ui = buildUiRegistry(registry, uiResources);
  if (!Array.isArray(resources)) throw new Error("invalid resources configuration: not an array");
  const violations = resourceViolations(resources);
  if (violations.length > 0) {
    throw new Error(`invalid resources configuration:\n${violations.join("\n")}`);
  }
  if (ui === undefined && resources.length === 0) return undefined;

  const uiEntries = [...(ui ?? [])].map(([uri, entry]): [string, ResourceEntry<TCtx>] => [
    uri,
    { kind: "ui", ...entry },
  ]);
  return new Map([...uiEntries, ...resources.map(generalEntry)]);
};
