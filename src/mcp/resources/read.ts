/** A general `resources/read`: build the context, run the provider once, and answer only a well-formed body. */

import { isJsonObject } from "../../util/json.js";
import { shownName } from "../tools/call-args.js";
import type { ResultWriter } from "../types.js";
import { auditResource, type ResourceCall, readFailedResponse } from "./outcome.js";
import { DEFAULT_RESOURCE_MIME_TYPE, type ResourceBody, type ResourceDef } from "./types.js";
import { isAppMimeType } from "./validate.js";

/** `undefined` for anything a provider may not return: a non-string body, a non-string or MCP Apps type. */
const parseBody = (result: unknown): ResourceBody | undefined => {
  if (typeof result === "string") return { text: result };
  if (!isJsonObject(result) || typeof result.text !== "string") return undefined;
  const { text, mimeType } = result;
  if (mimeType === undefined) return { text };
  const usable = typeof mimeType === "string" && mimeType !== "" && !isAppMimeType(mimeType);
  return usable ? { text, mimeType } : undefined;
};

/** The provider's answer, or `undefined` when it threw or answered badly: its exception goes nowhere. */
const runProvider = async <TCtx>(
  def: ResourceDef<TCtx>,
  ctx: TCtx,
): Promise<ResourceBody | undefined> => {
  try {
    return parseBody(await def.read(ctx));
  } catch {
    return undefined;
  }
};

/** Called only after the principal passed every check; the one place `context` is built for a resource. */
export const readGeneral = async <TCtx>(
  call: ResourceCall<TCtx>,
  input: { def: ResourceDef<TCtx>; respond: ResultWriter },
): Promise<Response> => {
  const { def, respond } = input;
  const ctx = await call.options.ports.context(call.req, call.principal);
  const body = await runProvider(def, ctx);
  if (body === undefined) return readFailedResponse(call, def.uri);

  await auditResource(call, { resource: shownName(def.uri) });
  return respond(call.id, {
    contents: [
      {
        uri: def.uri,
        mimeType: body.mimeType ?? def.mimeType ?? DEFAULT_RESOURCE_MIME_TYPE,
        text: body.text,
      },
    ],
  });
};
