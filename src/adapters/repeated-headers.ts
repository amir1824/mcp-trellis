/** A header sent twice reaches a Web `Request` as one value joined with `, `: this marks the ones MCP validates against the body. */

const PARAM_HEADER_PREFIX = "mcp-param-";

/**
 * The value a repeated `Mcp-Param-*` header is replaced with. `req.headers` joins the copies into `a, b`,
 * which cannot be told from one value holding a comma. This one holds a byte no plain header value may
 * carry, so the MCP layer answers a repeated header it knows about with 400 `-32020`, and ignores one it
 * does not know, as it does any other.
 */
const REPEATED_PARAM_HEADER_VALUE = "\u0080";

/** Lower-case names of the `Mcp-Param-*` headers `rawHeaders` holds more than once. */
const repeatedParamHeaders = (rawHeaders: readonly string[] = []): string[] => {
  const names = rawHeaders
    .filter((_, index) => index % 2 === 0)
    .map((name) => name.toLowerCase())
    .filter((name) => name.startsWith(PARAM_HEADER_PREFIX));
  return [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
};

/** Replaces each repeated `Mcp-Param-*` header of `rawHeaders` in `headers` with a value the MCP layer refuses. */
export const refuseRepeatedParamHeaders = (
  headers: Headers,
  rawHeaders: readonly string[] | undefined,
): void => {
  repeatedParamHeaders(rawHeaders).forEach((name) => {
    headers.set(name, REPEATED_PARAM_HEADER_VALUE);
  });
};
