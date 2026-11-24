import type { ToolDef } from "../registry.js";

/**
 * On a multi-scope server a tool with no `scope` is callable by a principal
 * holding none of the advertised scopes, silently defeating
 * `defaultScopes: []`. Single-scope servers have no such ambiguity. Pass
 * `scope: null` on a tool to state the omission on purpose.
 */
export const assertToolScopesConfigured = <TCtx>(
  tools: ToolDef<TCtx>[],
  scopes: string[],
): void => {
  if (scopes.length <= 1) return;
  const unscoped = tools.filter((tool) => tool.scope === undefined).map((tool) => tool.name);
  if (unscoped.length === 0) return;
  throw new Error(
    `scopes has more than one entry (${scopes.join(", ")}), but these tools have no ` +
      `scope and would be callable by any authenticated principal regardless of what ` +
      `scopes it holds: ${unscoped.join(", ")}. Set scope: "<one of the entries above>" ` +
      `on each, or scope: null to state the omission on purpose.`,
  );
};
