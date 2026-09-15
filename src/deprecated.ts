/**
 * Root-entry aliases for symbols that moved to `mcp-trellis/advanced`.
 * Declared as consts (not `export { } from`) so `@deprecated` reaches
 * editors. Removed in 3.0.
 */

import * as advanced from "./advanced.js";

/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const timingSafeEqual = advanced.timingSafeEqual;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const matchesAny = advanced.matchesAny;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const corsHeaders = advanced.corsHeaders;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const emptyResponse = advanced.emptyResponse;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const methodNotAllowed = advanced.methodNotAllowed;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const optionsResponse = advanced.optionsResponse;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const pickProtocolVersion = advanced.pickProtocolVersion;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const ASSUMED_HEADER_PROTOCOL_VERSION = advanced.ASSUMED_HEADER_PROTOCOL_VERSION;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const validateAgainstSchema = advanced.validateAgainstSchema;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const unsupportedKeywords = advanced.unsupportedKeywords;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const missingObjectType = advanced.missingObjectType;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const JSON_SCHEMA_TYPES = advanced.JSON_SCHEMA_TYPES;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const SUPPORTED_SCHEMA_KEYWORDS = advanced.SUPPORTED_SCHEMA_KEYWORDS;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const IGNORED_SCHEMA_KEYWORDS = advanced.IGNORED_SCHEMA_KEYWORDS;
