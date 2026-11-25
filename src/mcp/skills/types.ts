/** Experimental Skills extension: what a host registers, and the index built from it. */

import type { GeneralCatalogEntry } from "../resources/types.js";
import type { Principal } from "../types.js";

export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";
export const SKILL_URI_SCHEME = "skill://";
export const SKILL_FILE_NAME = "SKILL.md";

/** `path` is relative to the skill; `mimeType` defaults to markdown for `.md`, else plain text. */
export type SkillFile = { path: string; text: string; mimeType?: string | undefined };

/**
 * A skill is data, served as text and never run, at `skill://<name>/SKILL.md` and `skill://<name>/<path>`.
 * @experimental
 */
export type SkillDef = {
  /** Lowercase letters, digits and single hyphens, 1 to 64 characters. */
  name: string;
  description: string;
  /** The body of `SKILL.md`. */
  instructions: string;
  /** Frontmatter `metadata`: string values; `allowed-tools` is refused. */
  metadata?: Record<string, string> | undefined;
  files?: SkillFile[] | undefined;
  /** As a tool's `scope`: omitted, `null` or `""` means any authenticated principal. */
  scope?: string | null | undefined;
  /** As `ResourceDef.allow`. */
  allow?: ((principal: Principal) => boolean) | undefined;
};

export type SkillResource = { uri: string; digest: string; size: number };

export type SkillRecord = {
  uri: string;
  frontmatter: Record<string, unknown>;
  /** The catalog entry of `SKILL.md`: access to the skill is decided on it. */
  access: GeneralCatalogEntry<unknown>;
  /** Digests of the static bytes, hashed on first use: the same for every caller. */
  manifest: () => Promise<SkillResource[]>;
};

/** Keyed by the URI of `SKILL.md`. */
export type SkillIndex = ReadonlyMap<string, SkillRecord>;
