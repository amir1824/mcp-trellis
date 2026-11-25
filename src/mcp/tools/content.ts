/** What a tool returns: standard MCP content blocks, optional structured data, an error flag. */

import { isJsonObject } from "../../util/json.js";

/**
 * Every block carries `text?: never` so a caller that only reads text (`result.content[0]?.text`)
 * keeps compiling after the union widened; `type` still narrows to the real shape.
 */
type BlockBase = { text?: never; _meta?: Record<string, unknown> };

export type ContentBlock =
  | { type: "text"; text: string; _meta?: Record<string, unknown> }
  | (BlockBase & { type: "image" | "audio"; data: string; mimeType: string })
  | (BlockBase & {
      type: "resource_link";
      uri: string;
      name: string;
      description?: string;
      mimeType?: string;
    })
  | (BlockBase & {
      type: "resource";
      resource: { uri: string; mimeType?: string } & ({ text: string } | { blob: string });
    });

export type ToolResult = {
  content: ContentBlock[];
  /** A plain JSON object for a UI or a typed client; `content` stays the text fallback. */
  structuredContent?: Record<string, unknown> | undefined;
  _meta?: Record<string, unknown> | undefined;
  isError?: boolean | undefined;
};

/** The first block's text, or `undefined` when there is none or the first block is not text. */
export const firstText = (result: ToolResult): string | undefined => {
  const first = result.content[0];
  return first?.type === "text" && typeof first.text === "string" ? first.text : undefined;
};

/**
 * A handler can be plain JS: anything without an array `content`, or with a
 * `structuredContent` / `_meta` that is not an object, never reaches the client.
 */
export const isToolResult = (out: unknown): out is ToolResult => {
  if (!isJsonObject(out) || !Array.isArray(out.content)) return false;
  const { structuredContent, _meta } = out;
  return (
    (structuredContent === undefined || isJsonObject(structuredContent)) &&
    (_meta === undefined || isJsonObject(_meta))
  );
};
