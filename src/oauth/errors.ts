/**
 * Throw from `mintAccessToken` or `refreshAccessToken` to refuse a grant on
 * purpose (the user is not allowed what they asked for). The token endpoint
 * answers `400 invalid_grant` with a generic description; `message` goes to
 * `ports.audit` only, so it can name the tenant or user without leaking either
 * to the caller. Any other thrown error is still a `500 server_error`.
 *
 * From `refreshAccessToken`, throw it only after the refresh token has been
 * verified and bound to this client and resource, and before you rotate it.
 * Until then return `null`: `/token` is reachable with a junk refresh token, so
 * an earlier throw tells an unauthenticated caller what you refuse. Do not mix
 * plain `Error` and `AccessDeniedError` for the same kind of refusal either: a
 * 500 next to a 400 is the same leak.
 */
export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}
