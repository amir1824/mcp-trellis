import { oauthError } from "../config.js";
import { HTTP_STATUS, OAUTH_ERRORS } from "../constants.js";
import type { AuthCodeRecord } from "../crypto/codes.js";
import { verifyPkceS256 } from "../crypto/pkce.js";
import { resourcesEqual } from "./resource.js";

const firstAuthCodeMismatch = (
  record: AuthCodeRecord,
  body: Record<string, string>,
  clientId: string,
): Response | null => {
  const rule = [
    {
      ok: record.redirectUri === (body.redirect_uri ?? ""),
      description: "redirect_uri mismatch",
    },
    {
      ok: record.clientId === clientId,
      description: "client_id mismatch",
    },
  ].find((entry) => !entry.ok);

  return rule
    ? oauthError(OAUTH_ERRORS.invalidGrant, HTTP_STATUS.badRequest, rule.description)
    : null;
};

type AuthCodeCheck = {
  record: AuthCodeRecord;
  body: Record<string, string>;
  clientId: string;
  expectedResource: string;
};

/** What a consumed code must still satisfy before a token is minted, in order. */
export const firstAuthCodeError = async ({
  record,
  body,
  clientId,
  expectedResource,
}: AuthCodeCheck): Promise<Response | null> => {
  const mismatch = firstAuthCodeMismatch(record, body, clientId);
  if (mismatch) return mismatch;

  if (!resourcesEqual(record.resource, expectedResource)) {
    return oauthError(
      OAUTH_ERRORS.invalidTarget,
      HTTP_STATUS.badRequest,
      "auth code bound to a different resource",
    );
  }

  if (!(await verifyPkceS256(body.code_verifier ?? "", record.codeChallenge))) {
    return oauthError(
      OAUTH_ERRORS.invalidGrant,
      HTTP_STATUS.badRequest,
      "pkce verification failed",
    );
  }
  return null;
};
