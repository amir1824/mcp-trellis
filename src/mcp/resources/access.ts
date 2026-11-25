/** Who may see a resource: one rule for UI documents and general resources, never cached. */

import { mayUse } from "../request-policy.js";
import type { Principal } from "../types.js";
import type { GeneralCatalogEntry, ResourceEntry } from "./types.js";

/** `scope`: the principal lacks the scope to step up to. `rule`: the host's `allow` said no, so there is nothing to step up to. */
export type Access =
  | { allowed: true }
  | { allowed: false; reason: "scope"; scope: string }
  | { allowed: false; reason: "rule" };

const ALLOWED: Access = { allowed: true };
const DENIED_BY_RULE: Access = { allowed: false, reason: "rule" };

/** Only an explicit `true` allows; a throw, a promise or any other value denies, and nothing of it leaks. */
const passesRule = <TCtx>({ def }: GeneralCatalogEntry<TCtx>, principal: Principal): boolean => {
  if (def.allow === undefined) return true;
  try {
    return def.allow(principal) === true;
  } catch {
    return false;
  }
};

/** `allow` first: a caller it rejects must not learn from a scope challenge that the resource exists. */
const generalAccess = <TCtx>(entry: GeneralCatalogEntry<TCtx>, principal: Principal): Access => {
  if (!passesRule(entry, principal)) return DENIED_BY_RULE;
  const { scope } = entry.def;
  return mayUse(principal, scope)
    ? ALLOWED
    : { allowed: false, reason: "scope", scope: scope ?? "" };
};

/** A UI document is visible to a principal who may call at least one tool that references it. */
const uiAccess = (
  scopes: ReadonlyArray<string | null | undefined>,
  principal: Principal,
): Access =>
  scopes.some((scope) => mayUse(principal, scope))
    ? ALLOWED
    : { allowed: false, reason: "scope", scope: scopes[0] ?? "" };

export const accessFor = <TCtx>(entry: ResourceEntry<TCtx>, principal: Principal): Access =>
  entry.kind === "ui" ? uiAccess(entry.scopes, principal) : generalAccess(entry, principal);

/**
 * `accessFor` for one request. The files of a skill share one decision, so a stateful `allow` cannot show
 * `SKILL.md` and hide a sibling. The map lives and dies with the request.
 */
export const requestAccess = <TCtx>(
  principal: Principal,
): ((entry: ResourceEntry<TCtx>) => Access) => {
  const bySkill = new Map<string, Access>();
  return (entry) => {
    const skill = entry.kind === "general" ? entry.skill : undefined;
    if (skill === undefined) return accessFor(entry, principal);
    const decided = bySkill.get(skill) ?? accessFor(entry, principal);
    bySkill.set(skill, decided);
    return decided;
  };
};
