/** `skills/list` and `skills/get`: the access rule of `resources/read`, per request. */

import { isJsonObject } from "../../util/json.js";
import { DENIAL_REASONS } from "../request-policy.js";
import { accessFor } from "../resources/access.js";
import {
  anonymousResponse,
  auditResource,
  deniedResponse,
  invalidParamsResponse,
  type ResourceCall,
  unknownResponse,
} from "../resources/outcome.js";
import { shownName } from "../tools/call-args.js";
import type { RpcMethodHandler } from "../types.js";
import type { SkillRecord } from "./types.js";

const NO_SKILLS: ReadonlyMap<string, never> = new Map<string, never>();

const skillEntry = async ({ uri, frontmatter, manifest }: SkillRecord) => ({
  uri,
  frontmatter,
  resources: await manifest(),
});

export const SKILL_METHODS = {
  "skills/list": async ({ req, id, principal, options, startedAt, respond }) => {
    const call = { method: "skills/list", req, id, principal, options, startedAt } as const;
    if (!principal) return anonymousResponse(call);

    const visible = [...(options.skillIndex ?? NO_SKILLS).values()].filter(
      (record) => accessFor(record.access, principal).allowed,
    );
    const skills = await Promise.all(visible.map(skillEntry));
    await auditResource(call);
    return respond(id, { skills });
  },

  "skills/get": async ({ req, body, id, principal, options, startedAt, respond }) => {
    const call: ResourceCall<unknown> = {
      method: "skills/get",
      req,
      id,
      principal,
      options,
      startedAt,
    };
    if (!principal) return anonymousResponse(call);

    const uri = isJsonObject(body.params) ? body.params.uri : undefined;
    if (typeof uri !== "string") return invalidParamsResponse(call);

    const record = (options.skillIndex ?? NO_SKILLS).get(uri);
    if (!record) return unknownResponse(call, { uri, reason: DENIAL_REASONS.unknownResource });

    const access = accessFor(record.access, principal);
    if (!access.allowed) return deniedResponse(call, { uri, access });

    await auditResource(call, { resource: shownName(uri) });
    return respond(id, { skill: await skillEntry(record) });
  },
} as const satisfies Record<string, RpcMethodHandler<unknown>>;
