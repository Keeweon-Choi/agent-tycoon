/**
 * FEAT-UI-MODERN-THEME 화면 스타일, one setting per browser (owner 11-06 16:15, replaces UI-FONT 글꼴):
 * 'modern' (the default) is the GPT mockups' look, Pretendard for every DOM text, rounded shapes, soft
 * shadows and outline icons; 'pixel' is the pixel UI exactly as it was, FS Pixel Sans for digits, Latin
 * and punctuation. It sets data-ui-theme on <html> (index.css swaps the shape, shadow and font tokens,
 * floors.css the elevator's numbers) and the canvas asks pixelFontFamily() per draw: the office world
 * stays pixel art in both, with Galmuri11 for ASCII in 모던 (the former 읽기 쉬움) and FS Pixel Sans in 픽셀 감성.
 *
 * Stored in localStorage behind try/catch, like uiScale: junk or a blocked store keeps the default. A
 * browser that chose a 글꼴 before (agty.ui-font.v2) is read once: 'pixel' -> 픽셀 감성, anything else -> 모던.
 */
import { useSyncExternalStore } from 'react';

import { PIXEL_FONT_FAMILY, PIXEL_FONT_FAMILY_READABLE } from '../constants.js';

export const UI_THEMES = ['modern', 'pixel'] as const;
export type UiTheme = (typeof UI_THEMES)[number];
export const DEFAULT_UI_THEME: UiTheme = 'modern';
export const UI_THEME_KEY = 'agty.ui-theme';
/** The 글꼴 setting's key until 11-06; only read, for the move. */
export const OLD_UI_FONT_KEY = 'agty.ui-font.v2';

export const parseUiTheme = (raw: string | null): UiTheme =>
  UI_THEMES.find((f) => f === raw) ?? DEFAULT_UI_THEME;

function read(): UiTheme {
  try {
    const saved = localStorage.getItem(UI_THEME_KEY);
    if (saved !== null) return parseUiTheme(saved);
    return localStorage.getItem(OLD_UI_FONT_KEY) === 'pixel' ? 'pixel' : DEFAULT_UI_THEME;
  } catch {
    return DEFAULT_UI_THEME;
  }
}
let theme = read();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const uiTheme = () => theme;
export const useUiTheme = () => useSyncExternalStore(subscribe, uiTheme, uiTheme);

/** The canvas's font family for the current setting (the office world is pixel art in both). */
export const pixelFontFamily = (): string =>
  theme === 'modern' ? PIXEL_FONT_FAMILY_READABLE : PIXEL_FONT_FAMILY;

function apply(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.uiTheme = theme;
  // The canvas draws with the face the moment it is loaded; ask for it now, not at the first glyph.
  if (theme === 'modern')
    document.fonts?.load("16px 'Galmuri11 ASCII'", '0').catch(() => undefined);
}
apply();

export function setUiTheme(next: string): void {
  theme = parseUiTheme(next);
  try {
    localStorage.setItem(UI_THEME_KEY, theme);
  } catch {
    // Private mode or a locked-down webview: this visit still remembers it.
  }
  apply();
  for (const l of listeners) l();
}

/** Tests: read the store again (after stubbing localStorage). */
export const reloadUiTheme = (): void => {
  theme = read();
};
