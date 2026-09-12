/** In-memory access + refresh token store for the Project desk demo. */
import { randomBytes } from "node:crypto";
import { isScopeSubset } from "../stores.js";

export const randomOpaqueToken = () => randomBytes(32).toString("base64url");

export const parseScopes = (scope: string): string[] => [
  ...new Set(
    scope
      .split(" ")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];

type TokenRecord = {
  userId: string;
  scopes: string[];
  audience: string;
  expires: number;
};

type RefreshRecord = {
  userId: string;
  scopes: string[];
  audience: string;
  clientId: string;
};

export type MintedDemoToken = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
};

export const createDemoTokenStore = () => {
  const tokens = new Map<string, TokenRecord>();
  const refreshTokens = new Map<string, RefreshRecord>();

  const mintPair = (input: {
    userId: string;
    clientId: string;
    scopes: string[];
    audience: string;
  }): MintedDemoToken => {
    const accessToken = randomOpaqueToken();
    const refreshToken = randomOpaqueToken();
    const scope = input.scopes.join(" ");
    tokens.set(accessToken, {
      userId: input.userId,
      scopes: input.scopes,
      audience: input.audience,
      expires: Date.now() + 3600_000,
    });
    refreshTokens.set(refreshToken, {
      userId: input.userId,
      scopes: input.scopes,
      audience: input.audience,
      clientId: input.clientId,
    });
    return { accessToken, refreshToken, expiresIn: 3600, scope };
  };

  return {
    mintPair,
    verifyAccess: (token: string): TokenRecord | null => {
      const found = tokens.get(token);
      return found && found.expires > Date.now() ? found : null;
    },
    refresh: (input: {
      refreshToken: string;
      clientId: string;
      resource: string;
      scope?: string;
    }): MintedDemoToken | null => {
      const record = refreshTokens.get(input.refreshToken);
      if (!record || record.clientId !== input.clientId || record.audience !== input.resource) {
        return null;
      }
      const requested = input.scope !== undefined ? parseScopes(input.scope) : record.scopes;
      if (requested.length === 0 || !isScopeSubset(requested, record.scopes)) {
        return null;
      }
      // Rotate: drop the presented RT so replay of the old one fails.
      refreshTokens.delete(input.refreshToken);
      return mintPair({
        userId: record.userId,
        clientId: input.clientId,
        scopes: requested,
        audience: input.resource,
      });
    },
  };
};
