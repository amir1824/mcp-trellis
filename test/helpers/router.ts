/**
 * Test-side `createOAuthRouter` — defaults `requireRegisteredClients` to
 * false so harnesses that invent a `client_id` (the majority of unit tests)
 * keep working, and `allowInMemoryCodeStore: true` so tests do not each
 * pass a CodeStore. Production defaults since 2.0 require an explicit
 * codeStore (or the allow flag); tests that assert those lock-downs set
 * the options explicitly and win via the spread below.
 */

import { createOAuthRouter as create, type OAuthRouter } from "../../src/oauth/router.js";
import type { OAuthRouterOptions } from "../../src/oauth/types.js";

export type { OAuthRouter, OAuthRouterOptions };

export const createOAuthRouter = (options: OAuthRouterOptions): OAuthRouter =>
  create({ requireRegisteredClients: false, allowInMemoryCodeStore: true, ...options });
