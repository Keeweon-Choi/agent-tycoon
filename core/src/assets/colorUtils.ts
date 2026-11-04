/**
 * Pure color conversion utilities — no external dependencies.
 */

import { HEX_CACHE_MAX, PNG_ALPHA_THRESHOLD } from './constants.js';

/** MEM-IDLE: one string per colour, not one per pixel (the daemon's sprite caches hold some
 *  200,000 pixels in a few hundred colours). Bounded, so a photo's colours are not all kept. */
const hexOf = new Map<number, string>();

export function rgbaToHex(r: number, g: number, b: number, a: number): string {
  if (a < PNG_ALPHA_THRESHOLD) return '';
  const key = (r << 24) | (g << 16) | (b << 8) | Math.min(a, 255);
  const known = hexOf.get(key);
  if (known !== undefined) return known;
  const rgb =
    `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase();
  const hex = a >= 255 ? rgb : `${rgb}${a.toString(16).padStart(2, '0').toUpperCase()}`;
  if (hexOf.size < HEX_CACHE_MAX) hexOf.set(key, hex);
  return hex;
}
