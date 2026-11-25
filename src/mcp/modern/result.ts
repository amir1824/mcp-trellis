/** How a 2026-07-28 success result is written: `resultType` first, the method's cache hints last. */

import { jsonResponse } from "../../http/http.js";
import { rpcResult } from "../jsonrpc.js";
import type { ResultWriter } from "../types.js";
import { authenticatedHints } from "./cache.js";

export const modernWriter =
  (method: string): ResultWriter =>
  (id, result) =>
    jsonResponse({
      data: rpcResult(id, { ...result, resultType: "complete", ...authenticatedHints(method) }),
    });

/** What every older protocol version gets: the result exactly as the handlers built it. */
export const legacyWriter: ResultWriter = (id, result) =>
  jsonResponse({ data: rpcResult(id, result) });
