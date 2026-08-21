/**
 * Test-side `createOAuthRouter` — defaults `requireRegisteredClients` to
 * false so harnesses that invent a `client_id` (the majority of unit tests)
 * keep working. Production default since 1.0 is true; tests that assert the
 * 1.0 lock-down set `requireRegisteredClients: true` explicitly and win via
 * the spread below.
 */

import { createOAuthRouter as create, type OAuthRouter } from "../../src/oauth/router.js";
import type { OAuthRouterOptions } from "../../src/oauth/types.js";

export type { OAuthRouter, OAuthRouterOptions };

export const createOAuthRouter = (options: OAuthRouterOptions): OAuthRouter =>
  create({ requireRegisteredClients: false, ...options });
