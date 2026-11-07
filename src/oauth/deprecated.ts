/**
 * `mcp-trellis/oauth` aliases for symbols that moved to
 * `mcp-trellis/advanced`. Declared as consts so `@deprecated` reaches
 * editors. Removed in the next major release.
 */

import * as advanced from "../advanced.js";

/** @deprecated Import from "mcp-trellis/advanced". Removed in the next major release. */
export const readClientAuth = advanced.readClientAuth;
/** @deprecated Import from "mcp-trellis/advanced". Removed in the next major release. */
export const firstClientAuthError = advanced.firstClientAuthError;
/** @deprecated Import from "mcp-trellis/advanced". Removed in the next major release. */
export const firstResourceError = advanced.firstResourceError;
/** @deprecated Import from "mcp-trellis/advanced". Removed in the next major release. */
export const resourceErrorInfo = advanced.resourceErrorInfo;
/** @deprecated Import from "mcp-trellis/advanced". Removed in the next major release. */
export const normalizeConfiguredPath = advanced.normalizeConfiguredPath;
/** @deprecated Import from "mcp-trellis/advanced". Removed in the next major release. */
export const firstScopeError = advanced.firstScopeError;
/** @deprecated Import from "mcp-trellis/advanced". Removed in the next major release. */
export const scopeErrorInfo = advanced.scopeErrorInfo;
/** @deprecated Import from "mcp-trellis/advanced". Removed in the next major release. */
export const parseScope = advanced.parseScope;
/** @deprecated Import from "mcp-trellis/advanced". Removed in the next major release. */
export const requestedScopes = advanced.requestedScopes;
/** @deprecated Import from "mcp-trellis/advanced". Removed in the next major release. */
export const formatScope = advanced.formatScope;
/** @deprecated Import from "mcp-trellis/advanced". Removed in the next major release. */
export const issueAuthCode = advanced.issueAuthCode;
/** @deprecated Import from "mcp-trellis/advanced". Removed in the next major release. */
export const consumeAuthCode = advanced.consumeAuthCode;
/** @deprecated Import from "mcp-trellis/advanced". Removed in the next major release. */
export const newClientId = advanced.newClientId;
/** @deprecated Import from "mcp-trellis/advanced". Removed in the next major release. */
export const randomBase64Url = advanced.randomBase64Url;
/** @deprecated Import from "mcp-trellis/advanced". Removed in the next major release. */
export const sha256Base64Url = advanced.sha256Base64Url;
/** @deprecated Import from "mcp-trellis/advanced". Removed in the next major release. */
export const verifyPkceS256 = advanced.verifyPkceS256;
/** @deprecated Import from "mcp-trellis/advanced". Removed in the next major release. */
export const buildErrorRedirectUrl = advanced.buildErrorRedirectUrl;
/** @deprecated Import from "mcp-trellis/advanced". Removed in the next major release. */
export const advertisedScopes = advanced.advertisedScopes;
/** @deprecated Import from "mcp-trellis/advanced". Removed in the next major release. */
export const defaultScopes = advanced.defaultScopes;
/** @deprecated Import from "mcp-trellis/advanced". Removed in the next major release. */
export const registeredClientsRequired = advanced.registeredClientsRequired;
/** @deprecated Import from "mcp-trellis/advanced". Removed in the next major release. */
export const unregisteredClientsAllowed = advanced.unregisteredClientsAllowed;
