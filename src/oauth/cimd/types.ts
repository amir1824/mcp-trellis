/** CIMD document and cache shapes, shared by the fetcher and the parser. */

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
