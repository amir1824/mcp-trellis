/**
 * Why a CIMD document could not be resolved. Reasons reach the operator's
 * audit sink only — the connector always sees one generic error — so a detail
 * is limited to static text, an HTTP status or a DNS error code: never a
 * resolved address, a response header or body, or a redirect target.
 */

import { BodyTooLargeError } from "../../http/body.js";

export type CimdFailureCode =
  | "dns_unavailable"
  | "dns_failed"
  | "blocked_address"
  | "blocked_url"
  | "http_status"
  | "redirect_refused"
  | "too_large"
  | "timeout"
  | "not_json"
  | "document_invalid"
  | "client_id_mismatch"
  | "auth_method_unsupported"
  | "redirect_uris_invalid"
  | "fetch_failed";

export type CimdFailure = { code: CimdFailureCode; detail?: string };

export class CimdError extends Error {
  readonly code: CimdFailureCode;

  constructor(code: CimdFailureCode, message: string) {
    super(message);
    this.name = "CimdError";
    this.code = code;
  }
}

const TIMEOUT_ERROR_NAMES = new Set(["AbortError", "TimeoutError"]);

/** Maps whatever a fetch attempt threw to a code; unknown errors keep only their class name. */
export const classifyCimdFailure = (caught: unknown): CimdFailure => {
  if (caught instanceof CimdError) return { code: caught.code, detail: caught.message };
  if (caught instanceof BodyTooLargeError) return { code: "too_large" };
  if (caught instanceof Error && TIMEOUT_ERROR_NAMES.has(caught.name)) return { code: "timeout" };
  return { code: "fetch_failed", ...(caught instanceof Error ? { detail: caught.name } : {}) };
};

export const formatCimdFailure = ({ code, detail }: CimdFailure): string =>
  detail ? `${code}: ${detail}` : code;
