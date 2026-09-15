/**
 * `mcp-trellis/oauth` aliases for symbols that moved to
 * `mcp-trellis/advanced`. Declared as consts so `@deprecated` reaches
 * editors. Removed in 3.0.
 */

import * as advanced from "../advanced.js";

/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const readClientAuth = advanced.readClientAuth;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const firstClientAuthError = advanced.firstClientAuthError;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const firstResourceError = advanced.firstResourceError;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const resourceErrorInfo = advanced.resourceErrorInfo;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const normalizeConfiguredPath = advanced.normalizeConfiguredPath;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const firstScopeError = advanced.firstScopeError;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const scopeErrorInfo = advanced.scopeErrorInfo;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const parseScope = advanced.parseScope;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const requestedScopes = advanced.requestedScopes;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const formatScope = advanced.formatScope;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const issueAuthCode = advanced.issueAuthCode;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const consumeAuthCode = advanced.consumeAuthCode;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const newClientId = advanced.newClientId;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const randomBase64Url = advanced.randomBase64Url;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const sha256Base64Url = advanced.sha256Base64Url;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const verifyPkceS256 = advanced.verifyPkceS256;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const buildErrorRedirectUrl = advanced.buildErrorRedirectUrl;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const advertisedScopes = advanced.advertisedScopes;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const defaultScopes = advanced.defaultScopes;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const registeredClientsRequired = advanced.registeredClientsRequired;
/** @deprecated Import from "mcp-trellis/advanced". Removed in 3.0. */
export const unregisteredClientsAllowed = advanced.unregisteredClientsAllowed;
