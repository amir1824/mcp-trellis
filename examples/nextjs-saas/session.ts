/**
 * Cookie session stub for the Next.js SaaS starter — Web Request only, so
 * this file typechecks without a `next` dependency.
 *
 * Wire your real auth here (Auth.js, Better Auth, your JWT cookie) and
 * return `{ id }` or `null`.
 */

export const readSession = (_request: Request): { id: string } | null => {
  // Placeholder: nobody logged in → OAuth redirects to loginUrl.
  return null;
};
