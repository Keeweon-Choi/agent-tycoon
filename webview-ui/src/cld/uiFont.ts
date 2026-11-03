/**
 * UI-FONT: one 글꼴 setting per browser (owner 11-01 14:54, 감성이냐 가독성이냐).
 * 'pixel' (the default) draws digits, Latin and punctuation in FS Pixel Sans, which sit at about
 * half a Hangul syllable's height; 'readable' draws printable ASCII in Galmuri11, the face that
 * already draws the Hangul. It sets data-ui-font on <html> (index.css swaps --pixel-font-stack,
 * floors.css resizes the elevator's numbers) and the canvas asks pixelFontFamily() per draw.
 *
 * Stored in localStorage behind try/catch, like uiScale: junk or a blocked store keeps 'pixel'.
 */
import { useSyncExternalStore } from 'react';

import { PIXEL_FONT_FAMILY, PIXEL_FONT_FAMILY_READABLE } from '../constants.js';

export const UI_FONTS = ['pixel', 'readable'] as const;
export type UiFont = (typeof UI_FONTS)[number];
export const DEFAULT_UI_FONT: UiFont = 'pixel';
export const UI_FONT_KEY = 'cld.ui-font';

export const parseUiFont = (raw: string | null): UiFont =>
  UI_FONTS.find((f) => f === raw) ?? DEFAULT_UI_FONT;

function read(): UiFont {
  try {
    return parseUiFont(localStorage.getItem(UI_FONT_KEY));
  } catch {
    return DEFAULT_UI_FONT;
  }
}
let font = read();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const uiFont = () => font;
export const useUiFont = () => useSyncExternalStore(subscribe, uiFont);

/** The canvas's font family for the current setting. */
export const pixelFontFamily = (): string =>
  font === 'readable' ? PIXEL_FONT_FAMILY_READABLE : PIXEL_FONT_FAMILY;

function apply(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.uiFont = font;
  // The canvas draws with the face the moment it is loaded; ask for it now, not at the first glyph.
  if (font === 'readable') document.fonts?.load("16px 'Galmuri11 ASCII'", '0').catch(() => undefined);
}
apply();

export function setUiFont(next: string): void {
  font = parseUiFont(next);
  try {
    localStorage.setItem(UI_FONT_KEY, font);
  } catch {
    // Private mode or a locked-down webview: this visit still remembers it.
  }
  apply();
  for (const l of listeners) l();
}

/** Tests: read the store again (after stubbing localStorage). */
export const reloadUiFont = (): void => {
  font = read();
};
