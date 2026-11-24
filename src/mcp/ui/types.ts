/** MCP Apps (SEP-1865) shapes this library serves: a UI resource and the tool metadata that points at it. */

export const UI_RESOURCE_SCHEME = "ui://";

/** The only content type MCP Apps defines for a UI resource. */
export const UI_MIME_TYPE = "text/html;profile=mcp-app";

export type UiVisibility = "model" | "app";

/** Where a tool's UI lives and who the host may show the tool to (the host enforces `visibility`, not this server). */
export type ToolUi = {
  /** `ui://...`, one of the `uiResources` registered on the server. */
  resourceUri: string;
  /** Default (omitted): `["model", "app"]`. */
  visibility?: UiVisibility[] | undefined;
};

/** Origins the host lets the UI reach. Each entry is an exact origin or `https://*.host`; see `parseCsp`. */
export type UiCsp = {
  /** Network requests (fetch, XHR, WebSocket): `https://` or `wss://`. */
  connectDomains?: string[] | undefined;
  /** Scripts, styles, images, fonts: `https://`. */
  resourceDomains?: string[] | undefined;
};

export type UiResource = {
  /** `ui://...`, unique on the server. */
  uri: string;
  name?: string | undefined;
  description?: string | undefined;
  /** A static, user-independent HTML document: per-user data travels in tool results, never here. */
  html: string;
  csp?: UiCsp | undefined;
};
