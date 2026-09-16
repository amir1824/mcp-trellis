/**
 * Stand-in for the README quickstart's `./your-app.js` — the host app's
 * session resolver, data adapter, and replay store.
 */
import { createMemoryCodeStore } from "../../src/oauth/crypto/codes.js";
import type { OAuthUser } from "../../src/oauth/types.js";

/** Demo session: every request is Alice. A real app reads cookies / JWT. */
export const session = async (_request: Request): Promise<OAuthUser | null> => ({
  id: "alice",
});

/** Process-local store for the quickstart test; production uses Redis/KV. */
export const codeStore = createMemoryCodeStore();

const PROJECTS: Record<string, string[]> = {
  alice: ["Apollo", "Borealis"],
  bob: ["Cygnus"],
};

export const projectsForUser = async (userId: string): Promise<string[]> => PROJECTS[userId] ?? [];
