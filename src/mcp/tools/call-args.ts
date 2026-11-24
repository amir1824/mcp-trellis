/** Reading a `tools/call` request and auditing what became of it. */

import { jsonResponse } from "../../http/http.js";
import { clipText } from "../../util/clip.js";
import { isJsonObject } from "../../util/json.js";
import {
  JSONRPC_INVALID_PARAMS,
  type JsonRpcId,
  type JsonRpcRequest,
  rpcError,
} from "../jsonrpc.js";
import { DENIAL_REASONS, safeAudit } from "../request-policy.js";
import type { AuditEntry, McpHandlerOptions, Principal } from "../types.js";

/** The one shape every "tools/call" outcome — unknown tool, missing scope, or a real call — audits. */
export const auditToolCall = <TCtx>(
  options: McpHandlerOptions<TCtx>,
  input: Pick<AuditEntry, "tool" | "ok" | "error"> & {
    principal: Principal | null;
    startedAt: number;
  },
): Promise<void> =>
  safeAudit(options, {
    method: "tools/call",
    tool: input.tool,
    principalId: input.principal?.id,
    ok: input.ok,
    error: input.error,
    durationMs: Date.now() - input.startedAt,
  });

/** A tool name or resource URI as echoed back or audited — it is whatever the caller sent. */
const MAX_SHOWN_NAME_LENGTH = 200;
export const shownName = (name: string): string => clipText(name, MAX_SHOWN_NAME_LENGTH, "…");

/** `args` is `null` when `arguments` is present but not an object. */
type ParsedToolCall = { name: string; args: Record<string, unknown> | null } | { error: string };

const INVALID_ARGUMENTS_MESSAGE = "tools/call params.arguments must be an object";

/**
 * Omitted params default to `{}`; null, an array or a primitive fail rather
 * than being coerced. `name` is only ever a string: `String(params.name)`
 * would throw on an object with a hostile `toString`, and coerce `["a"]` or
 * `1` into a real-looking tool name. An absent `arguments` is `{}` (it is
 * optional); a malformed one must not silently become `{}` and run the tool
 * with every optional argument unset.
 */
export const parseToolCallArgs = (body: JsonRpcRequest): ParsedToolCall => {
  const params = body.params === undefined ? {} : body.params;
  if (!isJsonObject(params)) return { error: "tools/call params must be an object" };
  const name = typeof params.name === "string" ? params.name : "";
  if (params.arguments === undefined) return { name, args: {} };
  return { name, args: isJsonObject(params.arguments) ? params.arguments : null };
};

export type ToolCallDenialInput = {
  name: string;
  principal: Principal | null;
  id: JsonRpcId;
  startedAt: number;
};

export const invalidArgumentsResponse = async <TCtx>(
  options: McpHandlerOptions<TCtx>,
  input: ToolCallDenialInput,
): Promise<Response> => {
  await auditToolCall(options, {
    ...input,
    tool: shownName(input.name),
    ok: false,
    error: DENIAL_REASONS.invalidParams,
  });
  return jsonResponse({
    data: rpcError(input.id, JSONRPC_INVALID_PARAMS, INVALID_ARGUMENTS_MESSAGE),
  });
};
