import { bytesToBase64Url } from "./base64url.js";
import { timingSafeEqual } from "../auth/bearer.js";

export const sha256Base64Url = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return bytesToBase64Url(digest);
};

export const verifyPkceS256 = async (
  verifier: string,
  challenge: string,
): Promise<boolean> => {
  if (!verifier || !challenge) return false;
  const computed = await sha256Base64Url(verifier);
  return timingSafeEqual(computed, challenge);
};

export const randomBase64Url = (byteLen: number): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLen));
  return bytesToBase64Url(bytes);
};
