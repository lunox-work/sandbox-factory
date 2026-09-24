/**
 * Turns an uploaded file into the one thing an avatar is stored as: a square
 * WebP of fixed size with no metadata.
 *
 * The bytes a browser sends are never stored. They are sniffed, decoded and
 * re-encoded, so what is served has a known type, a known size and nothing
 * embedded — no EXIF location, no script, no second format hiding in the
 * same file.
 */

import { createHash } from "node:crypto";

import sharp from "sharp";

/** Four times the largest rendered avatar (64px), for 2x screens and room. */
export const AVATAR_SIZE = 256;

/** The upload cap. The route's body limit sits just above it. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * A decompression-bomb cap. A tiny PNG can declare a huge canvas, and libvips
 * would allocate for all of it; this refuses it from the header instead.
 */
export const MAX_INPUT_PIXELS = 40_000_000;

const WEBP_QUALITY = 82;

/** Refused input. The message is written for the person who picked the file. */
export class UnsupportedImageError extends Error {
  override name = "UnsupportedImageError";
}

export const UNSUPPORTED_FORMAT = "Use a PNG, JPEG, WebP or GIF.";
export const UNREADABLE = "That file could not be read as a picture.";
export const TOO_MANY_PIXELS =
  "That picture is too large to process. Try one under 40 megapixels.";

type Format = "png" | "jpeg" | "webp" | "gif";

/**
 * The format from the file's first bytes. Done before libvips sees the input,
 * so formats it could decode but this feature does not accept — SVG, HEIF,
 * TIFF and the rest — are never parsed at all.
 */
export function sniff(bytes: Uint8Array): Format | undefined {
  const at = (offset: number, ...expected: number[]) =>
    expected.every((value, index) => bytes[offset + index] === value);

  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpeg";
  // "GIF87a" or "GIF89a".
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (at(4, 0x37, 0x61) || at(4, 0x39, 0x61)))
    return "gif";
  // "RIFF" <size> "WEBP".
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
    return "webp";
  return undefined;
}

export interface ProcessedAvatar {
  /** The WebP to store. */
  readonly bytes: Uint8Array;
  /** SHA-256 of `bytes`, lowercase hex: the object's name. */
  readonly hash: string;
}

/**
 * Decode, orient, centre-crop to a square, resize and re-encode. Animated
 * input keeps its first frame. Throws `UnsupportedImageError` for anything
 * that is not an accepted, decodable, reasonably sized picture.
 */
export async function processImage(
  input: Uint8Array,
): Promise<ProcessedAvatar> {
  const format = sniff(input);
  if (format === undefined) {
    throw new UnsupportedImageError(UNSUPPORTED_FORMAT);
  }

  let width: number | undefined;
  let height: number | undefined;
  try {
    // Header only, so no pixel limit here: with one, libvips refuses an
    // oversized canvas as an error indistinguishable from a corrupt file,
    // and the person would be told the wrong thing. The limit is checked
    // just below, and applied again to the decode.
    ({ width, height } = await sharp(input, {
      limitInputPixels: false,
    }).metadata());
  } catch {
    throw new UnsupportedImageError(UNREADABLE);
  }
  // Checked from the header, before any pixel is decoded.
  if (
    width === undefined ||
    height === undefined ||
    width * height > MAX_INPUT_PIXELS
  ) {
    throw new UnsupportedImageError(
      width === undefined || height === undefined
        ? UNREADABLE
        : TOO_MANY_PIXELS,
    );
  }

  let output: Buffer;
  try {
    output = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      // Applies the EXIF orientation, so a phone photo is not sideways once
      // the metadata carrying that orientation is dropped.
      .rotate()
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "centre" })
      // No `withMetadata()`: sharp drops EXIF, ICC and XMP by default.
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
  } catch {
    throw new UnsupportedImageError(UNREADABLE);
  }

  return {
    bytes: new Uint8Array(output),
    hash: createHash("sha256").update(output).digest("hex"),
  };
}
