/** What a handler's outcome becomes: a `ToolResult`, with a failure shown to the client as redacted text. */

import { isToolResult, type ToolResult } from "../content.js";

const DEFAULT_TOOL_ERROR = "Tool execution failed";

export const INVALID_TOOL_RESULT = "Tool returned an invalid result";

export const errorResult = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/**
 * Map a tool exception to client-visible text.
 * A throwing or non-string `onToolError` falls back to the redacted default —
 * a mapper must never turn a tool failure into a transport failure.
 */
export const resolveToolError = (
  caught: unknown,
  onToolError: ((error: unknown) => string) | undefined,
): string => {
  if (!onToolError) return DEFAULT_TOOL_ERROR;
  try {
    const mapped = onToolError(caught);
    return typeof mapped === "string" && mapped.length > 0 ? mapped : DEFAULT_TOOL_ERROR;
  } catch {
    return DEFAULT_TOOL_ERROR;
  }
};

/**
 * A handler is typed to return `ToolResult | string`, but a JS tool (or a
 * lookup that came back `undefined`) can return anything. Anything else is a
 * tool failure the caller sees as `isError`, never a malformed `result`.
 */
export const asToolResult = (out: ToolResult | string): ToolResult => {
  if (typeof out === "string") {
    return { content: [{ type: "text", text: out }], isError: false };
  }
  return isToolResult(out) ? out : errorResult(INVALID_TOOL_RESULT);
};
