/** CIMD document, cache and fetch-option shapes, shared by the fetcher and the parser. */

export type CimdDocument = {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method?: string;
};

export type CimdCache = {
  get: (clientId: string) => Promise<CimdDocument | null> | CimdDocument | null;
  set: (clientId: string, doc: CimdDocument, maxAgeSeconds: number) => Promise<void> | void;
};

export type CimdFetchOptions = {
  /** Override fetch (tests). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  cache?: CimdCache;
  /**
   * DNS lookup for rebinding checks. When omitted, the library uses `node:dns/promises`
   * `resolve4` / `resolve6` (A and AAAA only, 5 s per lookup, at most 8 at once); with no
   * `node:dns` at all, resolution is refused rather than fetched blind.
   */
  lookup?: (hostname: string) => Promise<string[]>;
  /** Per-hop timeout covering connect **and** body read. Tests only — default 10 s. */
  timeoutMs?: number;
  /** Ports a CIMD URL may use, for the first request and every redirect. Default: any port. */
  allowedPorts?: readonly number[];
  /** Refuse a response whose Content-Type is not a JSON media type. Default: off. */
  requireJsonContentType?: boolean;
};

/** The host-facing CIMD options, shared by `createMcpApp` and `createOAuthRouter`. */
export type CimdPorts = {
  /**
   * CIMD document cache (respects Cache-Control max-age, capped at 1 h).
   * **Strongly recommended with `cimd: true`:** without it `/token` and
   * `/revoke` re-fetch the client's document on every call, so a flaky
   * document host fails refresh/revoke (audited as `cimd_resolve_failed`).
   */
  cimdCache?: CimdCache;
  /** Optional DNS lookup for CIMD SSRF checks — see `CimdFetchOptions.lookup`. */
  cimdLookup?: (hostname: string) => Promise<string[]>;
  /**
   * The fetch CIMD documents are retrieved with. Web `fetch` cannot pin the connection to the
   * address that was checked, so a host on Node that must close DNS rebinding passes a fetch
   * that dials only an allowed address. It must honour `redirect: "manual"` and `signal`: a response
   * that followed a redirect (`response.redirected`) is refused. Default: `globalThis.fetch`.
   */
  cimdFetch?: typeof fetch;
  /** Ports a CIMD URL may use. Default unchanged (any port); `[443]` is recommended in production. */
  cimdAllowedPorts?: readonly number[];
  /** Refuse a CIMD response that is not served as JSON. Default off. */
  cimdRequireJsonContentType?: boolean;
};
