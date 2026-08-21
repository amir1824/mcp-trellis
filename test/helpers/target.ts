/**
 * Normalizes the three shapes tests exercise an OAuth/MCP surface through —
 * an in-process `McpApp` (`fetch`), a bare `OAuthRouter` (`tryHandle`), or a
 * real socket (`origin`) — into one `fetch`-shaped function. Without this,
 * router-only tests can't share assertions with the e2e (real-socket) suite,
 * which is exactly why the e2e file duplicates ~30 assertion blocks today.
 */

export type Target =
  | { fetch: (request: Request) => Promise<Response> }
  | { tryHandle: (request: Request) => Promise<Response | null> }
  | { origin: string };

/** Base origin to build request URLs against when the target has none of its own. */
export const DEFAULT_ORIGIN = "https://example.test";

export const originOf = (target: Target): string =>
  "origin" in target ? target.origin : DEFAULT_ORIGIN;

export const asFetch = (target: Target): ((request: Request) => Promise<Response>) => {
  if ("fetch" in target) return target.fetch;
  if ("tryHandle" in target) {
    return async (request) => {
      const res = await target.tryHandle(request);
      if (res === null) {
        throw new Error(`router did not claim ${new URL(request.url).pathname}`);
      }
      return res;
    };
  }
  return (request) => fetch(request);
};
