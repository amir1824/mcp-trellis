/** How a 2026-07-28 success result is written: `resultType` first, the method's cache hints last. */

import { jsonResponse } from "../../http/http.js";
import { rpcResult } from "../jsonrpc.js";
import { legacyToolCallResult, legacyToolsListResult } from "../tools/wire/legacy.js";
import type { ResultWriter } from "../types.js";
import { authenticatedHints } from "./cache.js";

export const modernWriter =
  (method: string): ResultWriter =>
  (id, result) =>
    jsonResponse({
      data: rpcResult(id, { ...result, resultType: "complete", ...authenticatedHints(method) }),
    });

/** What every older protocol version gets: the result exactly as the handlers built it. */
const legacyWriter: ResultWriter = (id, result) => jsonResponse({ data: rpcResult(id, result) });

const legacyToolsWriter: ResultWriter = (id, result) =>
  legacyWriter(id, legacyToolsListResult(result));

const legacyToolCallWriter: ResultWriter = (id, result) =>
  legacyWriter(id, legacyToolCallResult(result));

const LEGACY_WRITERS: ReadonlyMap<string, ResultWriter> = new Map([
  ["tools/list", legacyToolsWriter],
  ["tools/call", legacyToolCallWriter],
]);

/** The older versions' writer, narrowing a tool's listing and result to what those versions define. */
export const legacyWriterFor = (method: string): ResultWriter =>
  LEGACY_WRITERS.get(method) ?? legacyWriter;
