/**
 * Sheet pixels as RGBA (CH-6 editor, photo maker): canvas encode/decode and the compositor's
 * hex sheet as bytes. 112×96, rows down/up/right × 7 frames of 16×32. CH-6b: a furniture
 * sprite, any size, too.
 */
import { SHEET_H, SHEET_W } from '../../../../core/src/cld/sheetCheck.js';
import type { LoadedCharacterData } from '../../office/sprites/spriteData.js';
import { FRAME_H, FRAME_W, FRAMES, VIEWS } from './compose.js';

export type Pixels = Uint8ClampedArray<ArrayBuffer>;

/** Byte offset of pixel (x, y) in an RGBA image `w` wide (the sheet by default). */
export const at = (x: number, y: number, w = SHEET_W) => (y * w + x) * 4;
/** Top-left sheet pixel of cell `frame` (0..20, row by row). */
export const origin = (frame: number) => [
  (frame % FRAMES) * FRAME_W,
  Math.floor(frame / FRAMES) * FRAME_H,
];
export const hex2 = (v: number) => v.toString(16).padStart(2, '0');

/** `#RRGGBB` or `#RRGGBBAA` as RGBA bytes. */
const hexRgba = (hex: string) => {
  const v = parseInt(hex.slice(1, 7), 16);
  return [v >> 16, (v >> 8) & 255, v & 255, hex.length > 7 ? parseInt(hex.slice(7, 9), 16) : 255];
};

/** The compositor's sheet (hex strings) as 112×96 RGBA. */
export function sheetRgba(sheet: LoadedCharacterData): Pixels {
  const out = new Uint8ClampedArray(SHEET_W * SHEET_H * 4);
  VIEWS.forEach((view, r) =>
    sheet[view].forEach((f, i) =>
      f.forEach((row, y) =>
        row.forEach((hex, x) => {
          if (hex) out.set(hexRgba(hex), at(i * FRAME_W + x, r * FRAME_H + y));
        }),
      ),
    ),
  );
  return out;
}

/** CH-6b: one sprite (rows of hex strings, '' clear) as RGBA, its own width wide. */
export function spriteRgba(sprite: readonly (readonly string[])[]): Pixels {
  const w = sprite[0]?.length ?? 0;
  const out = new Uint8ClampedArray(w * sprite.length * 4);
  sprite.forEach((row, y) =>
    row.forEach((hex, x) => {
      if (hex) out.set(hexRgba(hex), at(x, y, w));
    }),
  );
  return out;
}

// ponytail: the canvas stores premultiplied alpha, so a semi-transparent pixel may move by
// one step on decode/encode; a JS PNG codec if that ever matters (opaque and clear are exact).
export async function decodePng(bytes: Uint8Array): Promise<Pixels> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d canvas');
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
}

export function canvasOf(
  rgba: Uint8ClampedArray<ArrayBuffer>,
  w: number,
  h: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')?.putImageData(new ImageData(rgba, w, h), 0, 0);
  return canvas;
}

export async function pngBase64(
  rgba: Uint8ClampedArray<ArrayBuffer>,
  w: number,
  h: number,
): Promise<string> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvasOf(rgba, w, h).toBlob(resolve, 'image/png'),
  );
  if (!blob) throw new Error('PNG');
  let s = '';
  for (const byte of new Uint8Array(await blob.arrayBuffer())) s += String.fromCharCode(byte);
  return btoa(s);
}
