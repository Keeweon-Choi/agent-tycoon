/**
 * MSG-UI3: the owner's profile picture. The daemon serves `/cld/profile/owner.png` to a logged-in
 * client, 404 when none is set; every owner face shares one answer, so a missing picture costs one
 * request and an upload or reset updates every face at once (another device sees it on reload).
 */
import { useSyncExternalStore } from 'react';

export const OWNER_PICTURE_URL = 'cld/profile/owner.png';
export const OWNER_PICTURE_SIDE = 128;
/** The daemon's cap (core's MAX_SHEET_BYTES). */
const OWNER_PICTURE_MAX_BYTES = 64 * 1024;

let version = 1;
let missing = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** The picture's URL, or null when the daemon has none (cache-busted per upload). */
const snapshot = (): string | null => (missing ? null : `${OWNER_PICTURE_URL}?v=${version}`);

export function useOwnerPicture(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    snapshot,
    snapshot,
  );
}

/** An <img> of the picture failed to load: show the default one until the next upload. */
export function ownerPictureMissing(): void {
  if (missing) return;
  missing = true;
  emit();
}

/** The owner saved a new picture (true) or went back to the default (false). */
export function ownerPictureChanged(has: boolean): void {
  version = Date.now();
  missing = !has;
  emit();
}

/** Crop `source` square (centre), scale to OWNER_PICTURE_SIDE and encode as PNG. */
export async function squarePng(source: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = OWNER_PICTURE_SIDE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    OWNER_PICTURE_SIDE,
    OWNER_PICTURE_SIDE,
  );
  bitmap.close();
  const encode = () => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  let png = await encode();
  if (png && png.size > OWNER_PICTURE_MAX_BYTES) {
    // ponytail: a noisy photo can top the cap; dropping each channel's low 3 bits shrinks it. Past that, the daemon refuses.
    const image = ctx.getImageData(0, 0, OWNER_PICTURE_SIDE, OWNER_PICTURE_SIDE);
    for (let i = 0; i < image.data.length; i++) image.data[i] &= 0xf8;
    ctx.putImageData(image, 0, 0);
    png = await encode();
  }
  if (!png) throw new Error('no png');
  return png;
}
