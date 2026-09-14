/** JSON `error` body / audit reason when a host port throws. */
export const INTERNAL_ERROR = "internal_error";

export const corsHeaders = (extra?: Record<string, string>): Record<string, string> => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
  // Response headers are opaque to browser JS by default unless explicitly
  // exposed — without this, a browser-based MCP client reading a 401 can
  // see the status but not WWW-Authenticate itself, i.e. not the
  // resource_metadata URL RFC 9728 discovery depends on.
  "Access-Control-Expose-Headers": "WWW-Authenticate",
  ...extra,
});

export type JsonResponseOptions = {
  /** Include permissive CORS headers. Default true (MCP). OAuth token set false. */
  cors?: boolean;
};

/** Single-object JSON response — keeps the call site under the ≤3-params rule. */
export type JsonResponseInput = {
  data: unknown;
  status?: number;
  headers?: Record<string, string>;
  cors?: boolean;
};

export const jsonResponse = (input: JsonResponseInput): Response => {
  const cors = input.cors !== false;
  return new Response(JSON.stringify(input.data), {
    status: input.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(cors ? corsHeaders() : {}),
      ...input.headers,
    },
  });
};

export const emptyResponse = (status: number): Response =>
  new Response(null, {
    status,
    headers: { ...corsHeaders(), "Cache-Control": "no-store" },
  });

export const optionsResponse = (options?: JsonResponseOptions): Response =>
  new Response(null, {
    status: 204,
    headers:
      options?.cors === false
        ? { "Cache-Control": "no-store" }
        : { ...corsHeaders(), "Cache-Control": "no-store" },
  });

/** Reflect a validated browser Origin on MCP CORS instead of `*`. */
export const withReflectedCorsOrigin = (response: Response, origin: string): Response => {
  const headers = new Headers(response.headers);
  if (!headers.has("Access-Control-Allow-Origin")) return response;
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export const methodNotAllowed = (
  message = "Method not allowed",
  options?: JsonResponseOptions,
): Response =>
  jsonResponse({
    data: { error: message },
    status: 405,
    ...(options?.cors !== undefined ? { cors: options.cors } : {}),
  });

/**
 * OPTIONS → 204; allowed verb → null (continue); otherwise → 405.
 * Shared by OAuth handlers that all need the same method gate.
 */
export const requireHttpMethod = (
  request: Request,
  allowed: ReadonlySet<string>,
  options?: JsonResponseOptions,
): Response | null => {
  if (request.method === "OPTIONS") return optionsResponse(options);
  if (allowed.has(request.method)) return null;
  return jsonResponse({
    data: { detail: "method not allowed" },
    status: 405,
    ...(options?.cors !== undefined ? { cors: options.cors } : {}),
  });
};
