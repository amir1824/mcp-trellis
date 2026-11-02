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
   * DNS lookup for rebinding checks. When omitted, the library uses
   * `node:dns/promises.lookup`, falling back to `resolve4` / `resolve6` where
   * `lookup` is stubbed (Workers `nodejs_compat`); with no `node:dns` at all,
   * resolution is refused rather than fetched blind.
   */
  lookup?: (hostname: string) => Promise<string[]>;
  /** Per-hop timeout covering connect **and** body read. Tests only — default 10 s. */
  timeoutMs?: number;
};
