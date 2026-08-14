/** JSON `error` body / audit reason when a host port throws. */
export const INTERNAL_ERROR = "internal_error";

export const corsHeaders = (
  extra?: Record<string, string>,
): Record<string, string> => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, MCP-Protocol-Version",
  ...extra,
});

export type JsonResponseOptions = {
  /** Include permissive CORS headers. Default true (MCP). OAuth token set false. */
  cors?: boolean;
};

export const jsonResponse = (
  data: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
  options?: JsonResponseOptions,
): Response => {
  const cors = options?.cors !== false;
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(cors ? corsHeaders() : {}),
      ...extraHeaders,
    },
  });
};

export const emptyResponse = (status: number): Response =>
  new Response(null, { status, headers: corsHeaders() });

export const optionsResponse = (options?: JsonResponseOptions): Response =>
  new Response(null, {
    status: 204,
    headers: options?.cors === false ? { "Cache-Control": "no-store" } : corsHeaders(),
  });

export const methodNotAllowed = (
  message = "Method not allowed",
  options?: JsonResponseOptions,
): Response => jsonResponse({ error: message }, 405, undefined, options);

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
  return jsonResponse(
    { detail: "method not allowed" },
    405,
    undefined,
    options,
  );
};
