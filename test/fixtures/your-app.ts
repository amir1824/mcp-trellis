/**
 * Stand-in for the README quickstart's `./your-app.js` — the host app's
 * auth and data adapter. Tokens are opaque base64url JSON; the library
 * still enforces the audience itself.
 */
import type { McpAppAuth } from "../../src/app-options.js";
import { createMemoryCodeStore } from "../../src/oauth/crypto/codes.js";
import { stubPorts } from "../helpers/ports.js";

type TokenPayload = { userId: string; scopes: string[]; audience: string };

export const encodeToken = (payload: TokenPayload): string =>
  Buffer.from(JSON.stringify(payload)).toString("base64url");

const { codeSecret, resolveUser, loginUrl, mintAccessToken } = stubPorts();

export const existingAuth: McpAppAuth = {
  codeSecret,
  resolveUser,
  loginUrl,
  mintAccessToken,
  codeStore: createMemoryCodeStore(),
  verifyToken: async (token) => {
    try {
      return JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as TokenPayload;
    } catch {
      return null;
    }
  },
};

const PROJECTS: Record<string, string[]> = {
  alice: ["Apollo", "Borealis"],
  bob: ["Cygnus"],
};

export const projectsForUser = async (userId: string): Promise<string[]> => PROJECTS[userId] ?? [];
