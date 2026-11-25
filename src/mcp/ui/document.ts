/** Construction-time check of a UI resource's document: `html` text XOR a strict base64 `blob`. */

import type { UiDocument } from "./types.js";

/** Largest decoded `blob` (16 MiB). Checked from the base64 length, so an oversized blob is never decoded. */
export const MAX_UI_BLOB_BYTES = 16 * 1024 * 1024;

const BASE64_GROUP_BYTES = 3;
const BASE64_GROUP_CHARS = 4;
const PADDING = "=";

/** Alphabet then at most two `=`; a flat pattern, because a repeated group overflows the regex stack on a large blob. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

const decodedSize = (blob: string): number => {
  const padding = blob.endsWith(`${PADDING}${PADDING}`) ? 2 : blob.endsWith(PADDING) ? 1 : 0;
  return (blob.length / BASE64_GROUP_CHARS) * BASE64_GROUP_BYTES - padding;
};

/** The decoded text of a canonical base64 string (no stray trailing bits), or `undefined` for anything else. */
const decodeUtf8 = (blob: string): string | undefined => {
  try {
    const binary = atob(blob);
    if (btoa(binary) !== blob) return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    );
  } catch {
    return undefined;
  }
};

const parseBlob = (blob: string): void => {
  if (blob.length % BASE64_GROUP_CHARS !== 0)
    throw new Error("blob must be standard padded base64");
  const size = decodedSize(blob);
  if (size > MAX_UI_BLOB_BYTES) {
    throw new Error(`blob decodes to ${size} bytes, over the ${MAX_UI_BLOB_BYTES}-byte limit`);
  }
  if (!BASE64_PATTERN.test(blob)) throw new Error("blob must be standard padded base64");
  const text = decodeUtf8(blob);
  if (text === undefined) throw new Error("blob must be canonical base64 of UTF-8 text");
  if (text.trim() === "") throw new Error("blob must decode to a non-empty html document");
};

/** The `html` or `blob` to serve, or throws: both, neither, or a document that is empty, not a string or not valid. */
export const parseDocument = ({ html, blob }: Partial<UiDocument>): UiDocument => {
  if (html !== undefined && blob !== undefined) {
    throw new Error("give html or blob, not both");
  }
  if (blob !== undefined) {
    if (typeof blob !== "string") throw new Error("blob must be a base64 string");
    parseBlob(blob);
    return { blob };
  }
  if (typeof html !== "string" || html.trim() === "") {
    throw new Error("html must be a non-empty string");
  }
  return { html };
};
