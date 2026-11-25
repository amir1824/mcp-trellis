/** MCP Apps (SEP-1865) shapes this library serves: a UI resource and the tool metadata that points at it. */

/** The extension id a client declares to receive MCP Apps metadata and `ui://` documents. */
export const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";

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

/**
 * Origins the host lets the UI reach. Each entry is an exact origin or `https://*.host`; see `parseCsp`.
 * Omitting the whole `csp` leaves the host's restrictive default in force (no external origin at all).
 */
export type UiCsp = {
  /** Network requests (fetch, XHR, WebSocket): `https://` or `wss://`. CSP `connect-src`. */
  connectDomains?: string[] | undefined;
  /** Scripts, styles, images, fonts, media: `https://`. */
  resourceDomains?: string[] | undefined;
  /** Nested iframes the UI may embed: `https://`. CSP `frame-src`; omitted means none. */
  frameDomains?: string[] | undefined;
  /** Allowed `<base href>` origins: `https://`. CSP `base-uri`; omitted means the document's own origin. */
  baseUriDomains?: string[] | undefined;
};

/** A browser capability the UI asks for. Present means requested: the value is always `{}`, as the spec writes it. */
export type UiPermission = Record<string, never>;

/**
 * Device access the UI asks its host for. Each entry grants the UI iframe a sensitive browser feature
 * (Permission Policy `camera`, `microphone`, `geolocation`, `clipboard-write`), so every one is off unless
 * listed. This server only declares the request: the host alone decides whether to honour it.
 */
export type UiPermissions = {
  camera?: UiPermission | undefined;
  microphone?: UiPermission | undefined;
  geolocation?: UiPermission | undefined;
  clipboardWrite?: UiPermission | undefined;
};

/**
 * The document body: exactly one of `html` (text) or `blob` (base64 of the UTF-8 HTML), never both and
 * never neither. It is static and user-independent: per-user data travels in tool results, never here.
 */
export type UiDocument =
  | { html: string; blob?: undefined }
  | {
      /** Standard base64 (RFC 4648, padded) of a UTF-8 HTML document, at most 16 MiB once decoded. */
      blob: string;
      html?: undefined;
    };

export type UiResource = UiDocument & {
  /** `ui://...`, unique on the server. */
  uri: string;
  name?: string | undefined;
  description?: string | undefined;
  csp?: UiCsp | undefined;
  /** Device access to request for the UI iframe. Default: none. See `UiPermissions`. */
  permissions?: UiPermissions | undefined;
  /**
   * Dedicated sandbox origin the UI asks for (OAuth callbacks, CORS or API-key allowlists): a bare lower-case
   * DNS host with an optional port, such as `a904794854a047f6.claudemcpcontent.com`. Its meaning is host-defined.
   */
  domain?: string | undefined;
  /** `true` asks the host for a visible border and background, `false` for none; omitted leaves it to the host. */
  prefersBorder?: boolean | undefined;
};
