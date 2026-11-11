/**
 * Minimal Standard Schema v1 surface (https://standardschema.dev).
 * Any compliant validator works here with zero adapter code. This is a
 * structural type, not a dependency: nothing is imported at runtime.
 */

import type { ToolResult } from "../registry.js";

export type StandardSchemaV1<Input = unknown, Output = Input> = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | { value: Output; issues?: undefined }
      | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<unknown> }> }
      | Promise<
          | { value: Output; issues?: undefined }
          | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<unknown> }> }
        >;
  };
};

export type ParseResult<Output> = { value: Output } | { issues: string[] };

const pathToString = (path: ReadonlyArray<unknown> | undefined): string =>
  (path ?? [])
    .map((segment) =>
      segment && typeof segment === "object" && "key" in segment
        ? String((segment as { key: unknown }).key)
        : String(segment),
    )
    .join(".");

export const parseWithSchema = async <Output>(
  schema: StandardSchemaV1<unknown, Output>,
  raw: unknown,
): Promise<ParseResult<Output>> => {
  const result = await schema["~standard"].validate(raw);
  const issues = result.issues;
  if (issues?.length) {
    return {
      issues: issues.map((issue) => {
        const path = pathToString(issue.path);
        return path ? `${path}: ${issue.message}` : issue.message;
      }),
    };
  }
  return { value: (result as { value: Output }).value };
};

export const issuesResult = (issues: string[]): ToolResult => ({
  content: [{ type: "text", text: issues.join("; ") }],
  isError: true,
});
