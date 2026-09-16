/**
 * Project desk on Cloudflare Workers — public remotes target for the
 * Official MCP Registry listing (`io.github.amir1824/project-desk`).
 *
 * Deploy: `npx wrangler deploy` (see wrangler.toml).
 * Secrets: DEMO_PASSWORD, OAUTH_CODE_SECRET
 * Optional var: PUBLIC_ORIGIN (defaults to the request origin).
 *
 * ponytail: in-memory sessions/tokens/codeStore — isolate-local only.
 * Fine for a fictional reference demo; not multi-isolate durable state.
 */
import { createDemo } from "./src/app.js";

type Env = {
  DEMO_PASSWORD: string;
  OAUTH_CODE_SECRET: string;
  PUBLIC_ORIGIN?: string;
};

type App = ReturnType<typeof createDemo>;

let cached: { key: string; app: App } | null = null;

const appFor = (env: Env, origin: string): App => {
  const key = `${env.OAUTH_CODE_SECRET}\0${env.DEMO_PASSWORD}\0${origin}`;
  if (cached?.key === key) return cached.app;
  const app = createDemo({
    origin,
    password: env.DEMO_PASSWORD,
    codeSecret: env.OAUTH_CODE_SECRET,
  });
  cached = { key, app };
  return app;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.DEMO_PASSWORD || !env.OAUTH_CODE_SECRET) {
      return new Response("Missing DEMO_PASSWORD or OAUTH_CODE_SECRET", { status: 500 });
    }
    const origin = env.PUBLIC_ORIGIN ?? new URL(request.url).origin;
    return appFor(env, origin).fetch(request);
  },
};
