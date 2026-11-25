/** The UI resources a server serves, checked once at construction and read-only afterwards. */

import { clipText } from "../../util/clip.js";
import { isJsonObject } from "../../util/json.js";
import type { ToolRegistry } from "../registry.js";
import { uriShapeViolations } from "../resources/uri.js";
import { parseCsp } from "./csp.js";
import { type ToolUi, UI_RESOURCE_SCHEME, type UiResource } from "./types.js";

/** A registered resource and the `scope` of every tool that references it, in registration order. */
export type UiEntry = {
  resource: UiResource;
  scopes: ReadonlyArray<string | null | undefined>;
};

/** Keyed by URI in a `Map`: a request's `uri` is never looked up as an object key. */
export type UiRegistry = ReadonlyMap<string, UiEntry>;

/** Longest URI echoed in a construction error. */
const MAX_SHOWN_URI = 200;

const VISIBILITIES: ReadonlySet<string> = new Set(["model", "app"]);

const isUiUri = (uri: unknown): uri is string =>
  typeof uri === "string" &&
  uri.startsWith(UI_RESOURCE_SCHEME) &&
  uri.length > UI_RESOURCE_SCHEME.length;

/** What `tools/list` carries for a tool with a UI: the nested `_meta.ui` form only. */
export const toolListMeta = ({ resourceUri, visibility }: ToolUi): { ui: ToolUi } => ({
  ui: { resourceUri, ...(visibility !== undefined ? { visibility: [...visibility] } : {}) },
});

/** Every violation of a tool's `ui`, listed at once. */
export const toolUiViolations = (
  tools: ReadonlyArray<{ name: string; ui?: ToolUi | undefined }>,
): string[] =>
  tools.flatMap(({ name, ui }) => {
    if (ui === undefined) return [];
    if (!isJsonObject(ui) || !isUiUri(ui.resourceUri)) {
      return [`${name}: ui.resourceUri must be a "${UI_RESOURCE_SCHEME}" URI`];
    }
    const { visibility } = ui;
    const valid =
      visibility === undefined ||
      (Array.isArray(visibility) &&
        visibility.length > 0 &&
        visibility.every((entry) => VISIBILITIES.has(entry)));
    return valid ? [] : [`${name}: ui.visibility must be a non-empty list of "model" and "app"`];
  });

const parseResource = (resource: UiResource): UiResource => {
  const { uri, name, description, html, csp } = resource;
  if (!isUiUri(uri)) throw new Error(`uiResources uri must be a "${UI_RESOURCE_SCHEME}" URI`);
  const shapeProblems = uriShapeViolations(uri);
  if (shapeProblems.length > 0) {
    throw new Error(
      `uiResources ${clipText(uri, MAX_SHOWN_URI, "…")}: ${shapeProblems.join("; ")}`,
    );
  }
  if (typeof html !== "string" || html.trim() === "") {
    throw new Error(`uiResources ${uri}: html must be a non-empty string`);
  }
  if (name !== undefined && typeof name !== "string") {
    throw new Error(`uiResources ${uri}: name must be a string`);
  }
  if (description !== undefined && typeof description !== "string") {
    throw new Error(`uiResources ${uri}: description must be a string`);
  }
  try {
    return { uri, name, description, html, ...(csp !== undefined ? { csp: parseCsp(csp) } : {}) };
  } catch (caught) {
    throw new Error(`uiResources ${uri}: ${caught instanceof Error ? caught.message : "bad csp"}`);
  }
};

/**
 * `undefined` when the server has no UI at all (the whole feature stays off).
 * Fails closed with every problem listed: a bad or duplicate URI, empty html, a bad
 * CSP, a tool pointing at an unregistered URI, a resource no tool points at.
 */
export const buildUiRegistry = <TCtx>(
  registry: ToolRegistry<TCtx>,
  resources: UiResource[] = [],
): UiRegistry | undefined => {
  const uiTools = registry.list().flatMap(({ name }) => {
    const tool = registry.get(name);
    return tool?.ui !== undefined ? [tool] : [];
  });
  if (resources.length === 0 && uiTools.length === 0) return undefined;

  const violations: string[] = [];
  const resourcesByUri = new Map<string, UiResource>();
  for (const resource of resources) {
    try {
      const parsed = parseResource(resource);
      if (resourcesByUri.has(parsed.uri))
        violations.push(`uiResources has duplicate uri ${parsed.uri}`);
      resourcesByUri.set(parsed.uri, parsed);
    } catch (caught) {
      violations.push(caught instanceof Error ? caught.message : "invalid uiResources entry");
    }
  }

  const scopesByUri = new Map<string, Array<string | null | undefined>>();
  for (const tool of uiTools) {
    const uri = tool.ui?.resourceUri ?? "";
    if (!resourcesByUri.has(uri)) {
      violations.push(`${tool.name}: ui.resourceUri ${uri} is not in uiResources`);
      continue;
    }
    scopesByUri.set(uri, [...(scopesByUri.get(uri) ?? []), tool.scope]);
  }
  for (const uri of resourcesByUri.keys()) {
    if (!scopesByUri.has(uri)) violations.push(`uiResources ${uri} is referenced by no tool`);
  }
  if (violations.length > 0)
    throw new Error(`invalid MCP Apps configuration:\n${violations.join("\n")}`);

  return new Map(
    [...resourcesByUri].map(([uri, resource]) => [
      uri,
      { resource, scopes: scopesByUri.get(uri) ?? [] },
    ]),
  );
};
