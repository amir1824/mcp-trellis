/** The shape every resource URI must have, `ui://` documents and general resources alike. */

/** RFC 3986 `unreserved`, `reserved` and `%`: every ASCII character a URI may carry. */
const URI_CHARACTERS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
const LOWERCASE_SCHEME = /^[a-z][a-z0-9+.-]*:/;
export const MAX_URI_LENGTH = 512;

/** What is wrong with the shape of `uri`; empty when it is fine. */
export const uriShapeViolations = (uri: string): string[] => [
  ...(URI_CHARACTERS.test(uri) ? [] : ["uri must hold only RFC 3986 ASCII characters"]),
  ...(LOWERCASE_SCHEME.test(uri) ? [] : ["uri must start with a lowercase `scheme:`"]),
  ...(uri.length > MAX_URI_LENGTH ? [`uri is over ${MAX_URI_LENGTH} characters`] : []),
];
