import { isJsonObject } from "../../util/json.js";

/** What the check reads from a tool or a resource: the label it names and the scope it may lack. */
type ScopedItem = { name: string; scope?: string | null | undefined };

/**
 * The URIs or names and scopes of `resources` or `skills`, read defensively: a malformed entry is skipped
 * here so that the handler's construction check names every violation, instead of a raw TypeError from this one.
 */
const scopedItems = (list: unknown, label: "uri" | "name"): ScopedItem[] =>
  Array.isArray(list)
    ? list
        .filter(isJsonObject)
        .map((item) => ({ name: String(item[label]), scope: item.scope as ScopedItem["scope"] }))
    : [];

/** Which kind of item is checked, and how an unscoped one is described in the error. */
const KINDS = {
  tools: "callable",
  resources: "readable",
  skills: "readable",
} as const;

/**
 * On a multi-scope server a tool or resource with no `scope` is reachable by a principal
 * holding none of the advertised scopes, silently defeating `defaultScopes: []`.
 * Single-scope servers have no such ambiguity. Pass `scope: null` to state the
 * omission on purpose.
 */
export const assertToolScopesConfigured = (
  items: ReadonlyArray<ScopedItem>,
  scopes: string[],
  kind: keyof typeof KINDS = "tools",
): void => {
  if (scopes.length <= 1) return;
  const unscoped = items.filter((item) => item.scope === undefined).map((item) => item.name);
  if (unscoped.length === 0) return;
  throw new Error(
    `scopes has more than one entry (${scopes.join(", ")}), but these ${kind} have no ` +
      `scope and would be ${KINDS[kind]} by any authenticated principal regardless of what ` +
      `scopes it holds: ${unscoped.join(", ")}. Set scope: "<one of the entries above>" ` +
      `on each, or scope: null to state the omission on purpose.`,
  );
};

/** The scope check of everything a host registers: tools, resources and skills. */
export const assertAllScopesConfigured = (
  options: { tools: ReadonlyArray<ScopedItem>; resources?: unknown; skills?: unknown },
  scopes: string[],
): void => {
  assertToolScopesConfigured(options.tools, scopes);
  assertToolScopesConfigured(scopedItems(options.resources, "uri"), scopes, "resources");
  assertToolScopesConfigured(scopedItems(options.skills, "name"), scopes, "skills");
};
