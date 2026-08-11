/** Shared base64url helpers (WebCrypto / DOM — no Node Buffer). */

export const bytesToBase64Url = (bytes: ArrayBuffer | Uint8Array): string => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const binary = Array.from(u8, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

export const textToBase64Url = (text: string): string =>
  bytesToBase64Url(new TextEncoder().encode(text));

export const fromBase64Url = (text: string): Uint8Array => {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const pad =
    padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const bin = atob(padded + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
