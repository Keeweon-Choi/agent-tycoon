/**
 * CH-6: the custom sheet checks (design §4.3), one rule for the daemon (saves, folder scans)
 * and the browser (import, save). Pure: the caller decodes the PNG (pngjs / a canvas).
 */
import {
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  CHAR_FRAMES_PER_ROW,
  CHARACTER_DIRECTIONS,
  PNG_ALPHA_THRESHOLD,
} from '../assets/constants.js';

export const SHEET_W = CHAR_FRAME_W * CHAR_FRAMES_PER_ROW;
export const SHEET_H = CHAR_FRAME_H * CHARACTER_DIRECTIONS.length;
export const MAX_SHEET_BYTES = 64 * 1024;
/** Every frame needs at least this many opaque pixels (no empty cell). */
export const MIN_FRAME_PIXELS = 8;
/** CH-6b: a redrawn furniture sprite needs at least this many opaque pixels. */
export const MIN_ART_PIXELS = 4;
/** Walk frames (standing on the floor): their lowest opaque row should be one of these. */
export const WALK_FRAMES = 3;
export const FEET_ROWS: readonly [number, number] = [26, 31];

export type SheetIssueCode =
  'tooBig' | 'notPng' | 'size' | 'format' | 'interlaced' | 'broken' | 'empty' | 'feet' | 'blank';

export interface SheetIssue {
  code: SheetIssueCode;
  /** English, for logs and the daemon's answer. */
  text: string;
  /** For the screen's own wording (rows and frames count from 1). */
  params: Record<string, number>;
}

const issue = (code: SheetIssueCode, text: string, params: Record<string, number> = {}) => ({
  code,
  text,
  params,
});

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const u32 = (b: Uint8Array, at: number) =>
  ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

/** What is wrong with the PNG's bytes before decoding (a `w`×`h` 8-bit RGBA, or RGB when
 *  `opaqueOk`, non-interlaced, at most 64 KB), or null. Interlaced files are refused because
 *  pngjs inflates those without a size cap. */
export function pngHeaderIssue(
  bytes: Uint8Array,
  w: number,
  h: number,
  opaqueOk = false,
  maxBytes = MAX_SHEET_BYTES,
): SheetIssue | null {
  if (bytes.length > maxBytes)
    return issue('tooBig', `too big (${bytes.length} bytes, max ${maxBytes})`, {
      kb: Math.ceil(bytes.length / 1024),
      max: maxBytes / 1024,
    });
  if (bytes.length < 33 || SIGNATURE.some((v, i) => bytes[i] !== v))
    return issue('notPng', 'bad PNG signature');
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR')
    return issue('notPng', 'no PNG header');
  const width = u32(bytes, 16);
  const height = u32(bytes, 20);
  if (width !== w || height !== h)
    return issue('size', `${width}×${height}, not ${w}×${h}`, { width, height, w, h });
  if (bytes[24] !== 8 || !(bytes[25] === 6 || (opaqueOk && bytes[25] === 2)))
    return issue('format', 'not an 8-bit RGBA PNG');
  if (bytes[28] !== 0) return issue('interlaced', 'interlaced PNG');
  return null;
}

/** The frame rules on a decoded 112×96 RGBA sheet: an empty cell is a problem (not saved),
 *  walk frames whose feet miss rows 26..31 a warning (saved anyway). The first of each. */
export function sheetFrameIssues(rgba: ArrayLike<number>): {
  problem: SheetIssue | null;
  warning: SheetIssue | null;
} {
  let problem: SheetIssue | null = null;
  let warning: SheetIssue | null = null;
  for (let r = 0; r < CHARACTER_DIRECTIONS.length; r++)
    for (let f = 0; f < CHAR_FRAMES_PER_ROW; f++) {
      let count = 0;
      let lowest = -1;
      for (let y = 0; y < CHAR_FRAME_H; y++)
        for (let x = 0; x < CHAR_FRAME_W; x++) {
          const at = ((r * CHAR_FRAME_H + y) * SHEET_W + f * CHAR_FRAME_W + x) * 4 + 3;
          if (rgba[at] >= PNG_ALPHA_THRESHOLD) {
            count++;
            lowest = y;
          }
        }
      const cell = { row: r + 1, frame: f + 1 };
      if (!problem && count < MIN_FRAME_PIXELS)
        problem = issue(
          'empty',
          `row ${cell.row} frame ${cell.frame}: ${count} opaque pixels, needs ${MIN_FRAME_PIXELS}`,
          { ...cell, count, min: MIN_FRAME_PIXELS },
        );
      else if (
        !warning &&
        count >= MIN_FRAME_PIXELS &&
        f < WALK_FRAMES &&
        (lowest < FEET_ROWS[0] || lowest > FEET_ROWS[1])
      )
        warning = issue(
          'feet',
          `row ${cell.row} frame ${cell.frame}: feet on row ${lowest}, not ${FEET_ROWS[0]}..${FEET_ROWS[1]}`,
          { ...cell, lowest, from: FEET_ROWS[0], to: FEET_ROWS[1] },
        );
    }
  return { problem, warning };
}

/** The whole check of a sheet PNG with the caller's decoder (which throws on a broken body). */
export async function checkSheetPng(
  bytes: Uint8Array,
  decode: (bytes: Uint8Array) => ArrayLike<number> | Promise<ArrayLike<number>>,
): Promise<{ problem: SheetIssue | null; warning: SheetIssue | null }> {
  const header = pngHeaderIssue(bytes, SHEET_W, SHEET_H);
  if (header) return { problem: header, warning: null };
  let rgba: ArrayLike<number>;
  try {
    rgba = await decode(bytes);
  } catch (err) {
    return {
      problem: issue('broken', `broken PNG (${err instanceof Error ? err.message : String(err)})`),
      warning: null,
    };
  }
  return sheetFrameIssues(rgba);
}

/** CH-6b: a redrawn furniture sprite (any size) that is (almost) all clear, or null. */
export function artIssue(rgba: ArrayLike<number>): SheetIssue | null {
  let count = 0;
  for (let p = 3; p < rgba.length; p += 4) if (rgba[p] >= PNG_ALPHA_THRESHOLD) count++;
  return count < MIN_ART_PIXELS
    ? issue('blank', `${count} opaque pixels, needs ${MIN_ART_PIXELS}`, {
        count,
        min: MIN_ART_PIXELS,
      })
    : null;
}

/** CHAR-HUMAN: an image to import as a part (any size, big-block or 1:1) is at most this big. */
export const MAX_IMPORT_BYTES = 6 * 1024 * 1024;
/** SHEET-IMPORT: an imported sheet as stored (192×384 frames, smooth art) is at most this big. */
export const MAX_HD_SHEET_BYTES = MAX_IMPORT_BYTES;
export const MAX_IMPORT_SIDE = 4096;
export const MAX_IMPORT_PIXELS = 4_200_000;

/** What is wrong with an import's PNG bytes before decoding (signature, header, a side or the
 *  pixel count past the caps, interlaced), or null. Any colour type: pngjs turns each into RGBA. */
export function importHeaderIssue(bytes: Uint8Array): SheetIssue | null {
  if (bytes.length > MAX_IMPORT_BYTES)
    return issue('tooBig', `too big (${bytes.length} bytes, max ${MAX_IMPORT_BYTES})`, {
      kb: Math.ceil(bytes.length / 1024),
      max: MAX_IMPORT_BYTES / 1024,
    });
  if (bytes.length < 33 || SIGNATURE.some((v, i) => bytes[i] !== v))
    return issue('notPng', 'bad PNG signature');
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR')
    return issue('notPng', 'no PNG header');
  const width = u32(bytes, 16);
  const height = u32(bytes, 20);
  if (
    !width ||
    !height ||
    width > MAX_IMPORT_SIDE ||
    height > MAX_IMPORT_SIDE ||
    width * height > MAX_IMPORT_PIXELS
  )
    return issue('size', `${width}×${height} is too large`, {
      width,
      height,
      w: MAX_IMPORT_SIDE,
      h: MAX_IMPORT_SIDE,
    });
  if (bytes[28] !== 0) return issue('interlaced', 'interlaced PNG');
  return null;
}
