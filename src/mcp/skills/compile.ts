/** `skills` into catalog files and the skill index; throws once, listing every problem. */

import { DEFAULT_RESOURCE_MIME_TYPE, type GeneralCatalogEntry } from "../resources/types.js";
import {
  SKILL_FILE_NAME,
  SKILL_URI_SCHEME,
  type SkillDef,
  type SkillFile,
  type SkillIndex,
  type SkillRecord,
  type SkillResource,
} from "./types.js";
import { skillViolations } from "./validate.js";

/** The specification's per-skill limits: files counted with `SKILL.md`, bytes over all of them. */
const MAX_FILES = 512;
const MAX_BYTES = 16 * 1024 * 1024;
const MARKDOWN = "text/markdown";
const HEX_RADIX = 16;
const HEX_WIDTH = 2;

type Entry = [string, GeneralCatalogEntry<unknown>];
type Part = { uri: string; text: string; size: number };
type Compiled = { record: SkillRecord; entries: Entry[]; parts: Part[] };

const encoder = new TextEncoder();

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(HEX_RADIX).padStart(HEX_WIDTH, "0"))
    .join("");

/** Hashed on first use and kept: the only memo, over static text, so never keyed by a caller. Bytes are encoded per hash, not kept. */
const lazyManifest = (parts: Part[]): (() => Promise<SkillResource[]>) => {
  let pending: Promise<SkillResource[]> | undefined;
  return () => {
    pending ??= Promise.all(
      parts.map(async ({ uri, text, size }) => ({
        uri,
        digest: `sha256:${hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)))}`,
        size,
      })),
    ).catch((caught: unknown) => {
      pending = undefined; // a failed hash is retried on the next call, never kept
      throw caught;
    });
    return pending;
  };
};

/** `key: <JSON value>` per line: valid YAML, and the listed frontmatter is the object that was rendered. */
const renderSkillMd = (frontmatter: Record<string, unknown>, body: string): string => {
  const lines = Object.entries(frontmatter).map(
    ([key, value]) => `${key}: ${JSON.stringify(value)}`,
  );
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
};

const buildFile = (def: SkillDef, { path, text, mimeType }: SkillFile) => {
  const uri = `${SKILL_URI_SCHEME}${def.name}/${path}`;
  const isSkillMd = path === SKILL_FILE_NAME;
  const fallback = path.toLowerCase().endsWith(".md") ? MARKDOWN : DEFAULT_RESOURCE_MIME_TYPE;
  const entry: GeneralCatalogEntry<unknown> = {
    kind: "general",
    skill: def.name,
    def: {
      uri,
      name: isSkillMd ? def.name : path,
      description: isSkillMd ? def.description : undefined,
      mimeType: mimeType ?? fallback,
      scope: def.scope,
      allow: def.allow,
      read: () => text,
    },
  };
  return { uri, entry, text, size: encoder.encode(text).length };
};

const compileSkill = (def: SkillDef): Compiled => {
  const { name, description, metadata } = def;
  const frontmatter = {
    name,
    description,
    ...(metadata === undefined ? {} : { metadata: { ...metadata } }),
  };
  const text = renderSkillMd(frontmatter, def.instructions);
  const skillMd = buildFile(def, { path: SKILL_FILE_NAME, text, mimeType: MARKDOWN });
  const built = [skillMd, ...(def.files ?? []).map((file) => buildFile(def, file))];
  const record = {
    uri: skillMd.uri,
    frontmatter,
    access: skillMd.entry,
    manifest: lazyManifest(built),
  };
  return { record, entries: built.map(({ uri, entry }): Entry => [uri, entry]), parts: built };
};

const limitViolations = (name: string, parts: Part[]): string[] => {
  const bytes = parts.reduce((sum, part) => sum + part.size, 0);
  return [
    ...(parts.length > MAX_FILES
      ? [`has ${parts.length} files, over the ${MAX_FILES}-file limit`]
      : []),
    ...(bytes > MAX_BYTES ? [`holds ${bytes} bytes, over the ${MAX_BYTES}-byte limit`] : []),
  ].map((violation) => `skills ${name}: ${violation}`);
};

/** `undefined` when no skill is registered (the feature stays off); nothing partial is ever built. */
export const compileSkills = (
  skills: unknown,
): { index: SkillIndex; entries: Entry[] } | undefined => {
  if (skills === undefined) return undefined;
  if (!Array.isArray(skills)) throw new Error("invalid skills configuration: not an array");
  const seen = new Set<string>();
  const problems: string[] = [];
  const compiled: Compiled[] = [];
  skills.forEach((def: unknown, index) => {
    const found = skillViolations(def, { index, seen });
    problems.push(...found);
    if (found.length > 0) return;
    const skill = def as SkillDef; // `skillViolations` proved the shape
    const one = compileSkill(skill);
    problems.push(...limitViolations(skill.name, one.parts));
    compiled.push(one);
  });
  if (problems.length > 0) throw new Error(`invalid skills configuration:\n${problems.join("\n")}`);
  if (compiled.length === 0) return undefined;
  return {
    index: new Map(compiled.map(({ record }) => [record.uri, record])),
    entries: compiled.flatMap(({ entries }) => entries),
  };
};
