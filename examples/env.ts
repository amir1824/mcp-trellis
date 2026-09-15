/**
 * Required secrets for the runnable examples. There is deliberately no
 * fallback value: a secret hardcoded in a public repo is a published secret,
 * and anyone who copies the example as-is would ship a server whose auth
 * codes and access tokens every reader of this repo can forge.
 */
export const requiredSecret = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set — generate one with \`openssl rand -base64 32\``);
  }
  return value;
};
