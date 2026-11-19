import type { ChatImage } from "./chat-types";
import { newId } from "./secure-context";
import { InputError } from "./input-error";

export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGES = 4;
/**
 * What one message may add to the runtime's Flow submission budget. That budget is
 * 4 MiB for the whole session lifetime and is never reclaimed, so an image has to
 * stay small enough that a normal session keeps working.
 */
export const MAX_SEND_IMAGE_BASE64 = 200 * 1024;
export const MAX_SEND_TOTAL_BASE64 = 600 * 1024;
const MAX_EDGE = 1536;
const MIN_SCALE = 0.2;
export interface ImageAttachment { id: string; name: string; size: number; image: ChatImage }
type ImageFile = { type: string; size: number };

export function validateImageSelection(existing: readonly { size: number }[], files: readonly ImageFile[]) {
  if (existing.length + files.length > MAX_IMAGES) throw new InputError("image-count", "Attach at most 4 images.", { n: MAX_IMAGES });
  for (const file of files) {
    if (!IMAGE_ACCEPT.split(",").includes(file.type)) throw new InputError("image-type", "Choose PNG, JPEG, WebP, or GIF images only.");
    if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new InputError("image-empty", "Images must not be empty.");
  }
  if ([...existing, ...files].reduce((total, file) => total + file.size, 0) > MAX_TOTAL_IMAGE_BYTES) {
    throw new InputError("image-total", "Images must total 20 MB or less.");
  }
}

// Check file signatures independently of filename and browser-provided MIME type.
// This is a format guard, not a full image decoder.
export function validateImageBytes(bytes: Uint8Array, mimeType: string): ChatImage["mimeType"] {
  const starts = (signature: number[], offset = 0) => signature.every((value, index) => bytes[offset + index] === value);
  const valid = mimeType === "image/png" ? starts([137, 80, 78, 71, 13, 10, 26, 10])
    : mimeType === "image/jpeg" ? starts([255, 216, 255])
    : mimeType === "image/gif" ? starts([71, 73, 70, 56, 55, 97]) || starts([71, 73, 70, 56, 57, 97])
    : mimeType === "image/webp" ? starts([82, 73, 70, 70]) && bytes.length >= 12 && starts([87, 69, 66, 80], 8)
    : false;
  if (!valid || bytes.length > MAX_IMAGE_BYTES) throw new InputError("image-invalid", "Image contents do not match a supported image type or exceed 10 MB.");
  return mimeType as ChatImage["mimeType"];
}

export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/**
 * Smallest side a provider accepts. A 256x1 strip passes every format check and then
 * fails the request, which used to leave the session unusable, so the shape is checked
 * here where it can still be refused.
 */
export const MIN_IMAGE_SIDE = 16;

/** Pixel size from the container header. Undefined when the size cannot be read, in
 *  which case the caller must not guess. */
export function imageDimensions(bytes: Uint8Array, mimeType: string): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mimeType === "image/png") {
    if (bytes.length < 24 || bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return undefined;
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mimeType === "image/gif") {
    if (bytes.length < 10) return undefined;
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (mimeType === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (isStartOfFrame) return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      const length = view.getUint16(offset + 2);
      if (length < 2) return undefined;
      offset += 2 + length;
    }
    return undefined;
  }
  return undefined;
}

/** Refuse an image the provider would reject for its size. An unreadable size passes:
 *  a false refusal is worse than the request's own error. */
export function assertMinimumImageSide(bytes: Uint8Array, mimeType: string): void {
  const size = imageDimensions(bytes, mimeType);
  if (!size) return;
  if (Math.min(size.width, size.height) < MIN_IMAGE_SIDE) {
    throw new InputError("image-too-small", `This image is ${size.width}\u00d7${size.height}px. Every side must be at least ${MIN_IMAGE_SIDE}px for the model to accept it.`, { width: size.width, height: size.height, min: MIN_IMAGE_SIDE });
  }
}

export function fitsSendBudget(images: readonly ImageAttachment[]): boolean {
  const total = images.reduce((sum, item) => sum + item.image.data.length, 0);
  return total <= MAX_SEND_TOTAL_BASE64;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

async function encode(bitmap: ImageBitmap, scale: number): Promise<Uint8Array | undefined> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/webp", 0.85));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : undefined;
}

/** Shrink an oversized image until one message stays inside the runtime's budget. */
export async function fitForSend(bytes: Uint8Array, mimeType: ChatImage["mimeType"]): Promise<{ bytes: Uint8Array; mimeType: ChatImage["mimeType"] }> {
  if (base64Length(bytes.length) <= MAX_SEND_IMAGE_BASE64) return { bytes, mimeType };
  // Re-encoding a still GIF would drop the animation; leave small ones alone and refuse huge ones.
  if (mimeType === "image/gif") throw new InputError("gif-too-large", "This GIF is too large to send. Use a smaller GIF or a still image.");
  let bitmap: ImageBitmap | undefined;
  try {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    bitmap = await createImageBitmap(new Blob([copy.buffer], { type: mimeType }));
  } catch {
    throw new InputError("image-unreadable", "This image could not be read.");
  }
  try {
    let scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const encoded = await encode(bitmap, scale);
      if (encoded && base64Length(encoded.length) <= MAX_SEND_IMAGE_BASE64) return { bytes: encoded, mimeType: "image/webp" };
      if (scale <= MIN_SCALE) break;
      scale *= 0.8;
    }
  } finally {
    bitmap.close();
  }
  throw new InputError("image-too-large", "This image is too large to send. Crop it or choose a smaller one.");
}

export async function readImageAttachment(file: File): Promise<ImageAttachment> {
  validateImageSelection([], [file]);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size) throw new InputError("image-changed", "Image size changed while reading.");
  const mimeType = validateImageBytes(bytes, file.type);
  assertMinimumImageSide(bytes, mimeType);
  const prepared = await fitForSend(bytes, mimeType);
  return {
    id: newId(),
    name: file.name,
    size: prepared.bytes.length,
    image: { type: "image", data: toBase64(prepared.bytes), mimeType: prepared.mimeType },
  };
}

export function removeSubmittedImages(current: readonly ImageAttachment[], submitted: readonly ImageAttachment[]) {
  const ids = new Set(submitted.map(image => image.id));
  return current.filter(image => !ids.has(image.id));
}

