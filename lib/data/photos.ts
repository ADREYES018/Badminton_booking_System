/**
 * Profile photos.
 *
 * KV values cap at 64 KiB, so originals are never stored. Uploads are decoded,
 * cropped to a centred square, scaled to 256px and re-encoded as JPEG, which
 * lands far under the cap and keeps the app free of external image hosting.
 *
 * ImageScript is used rather than OffscreenCanvas: Deno provides no 2D canvas
 * context, so `getContext("2d")` returns null both locally and on Deploy.
 * ImageScript is pure WASM and runs in both places.
 *
 * Note: Vite's dev server rejects multipart requests carrying a file part with
 * a bare 400 before they reach Fresh, so photo upload cannot be exercised
 * through `deno task dev`. It works under `deno task build && deno task start`,
 * and on Deno Deploy, which do not involve Vite at request time.
 */

import { keys } from "../kv/keys.ts";

export const PHOTO_SIZE = 256;
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** Hard ceiling below KV's 64 KiB limit, leaving room for key overhead. */
export const MAX_STORED_BYTES = 60 * 1024;
export const PHOTO_MIME = "image/jpeg";

const ACCEPTED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export class PhotoError extends Error {}

/**
 * Normalizes an uploaded image to a small square JPEG.
 * Quality steps down until the result fits comfortably inside a KV value.
 */
export async function processPhoto(file: File): Promise<Uint8Array> {
  if (!ACCEPTED_TYPES.has(file.type)) {
    throw new PhotoError("Please upload a JPEG, PNG, WebP or GIF image.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new PhotoError("That image is larger than 8 MB.");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // Imported lazily: ImageScript pulls in a large WASM module that Vite's SSR
  // pipeline cannot load eagerly, and photos are only processed on upload.
  const { decode, Image } = await import("imagescript");

  let decoded;
  try {
    decoded = await decode(bytes);
  } catch (error) {
    // Surface the underlying cause; a decoder failure here is a real defect,
    // not merely a bad upload.
    console.error("Image decode failed", error);
    throw new PhotoError("That file could not be read as an image.");
  }

  // An animated GIF decodes to a Frame collection rather than a single Image;
  // in that case take the first frame.
  const image = decoded instanceof Image
    ? decoded
    : (decoded as unknown as ArrayLike<InstanceType<typeof Image>>)[0];

  if (!image) throw new PhotoError("That image appears to be empty.");

  // Centre crop to a square so faces are not stretched.
  const side = Math.min(image.width, image.height);
  const sx = Math.floor((image.width - side) / 2);
  const sy = Math.floor((image.height - side) / 2);

  const square = image.clone()
    .crop(sx, sy, side, side)
    .resize(PHOTO_SIZE, PHOTO_SIZE);

  // Step the quality down until the result fits comfortably inside a KV value.
  const qualities = [82, 70, 60, 45] as const;
  for (const quality of qualities) {
    const encoded = await square.encodeJPEG(quality);
    if (encoded.byteLength <= MAX_STORED_BYTES) return encoded;
  }

  throw new PhotoError("That image could not be compressed enough.");
}

export async function savePhoto(
  kv: Deno.Kv,
  userId: string,
  bytes: Uint8Array,
): Promise<void> {
  if (bytes.byteLength > MAX_STORED_BYTES) {
    throw new PhotoError("Processed image is too large to store.");
  }
  await kv.set(keys.photo(userId), bytes);
}

export async function getPhoto(
  kv: Deno.Kv,
  userId: string,
): Promise<Uint8Array | null> {
  const entry = await kv.get<Uint8Array>(keys.photo(userId));
  return entry.value ?? null;
}

export async function deletePhoto(kv: Deno.Kv, userId: string): Promise<void> {
  await kv.delete(keys.photo(userId));
}
