/**
 * UI-SCALE: one 화면 크기 setting (small · medium · large) for the whole DOM UI,
 * per browser (owner 10-24 16:07: the setting decides, never the screen width).
 * It sets --ui-scale on <html>, which Tailwind's spacing and text sizes follow
 * (index.css), and picks the nameplate's size row (constants.ts NAMEPLATE_SIZES).
 * The canvas world keeps its own zoom.
 *
 * Stored in localStorage behind try/catch, like office hours: junk or a blocked
 * store keeps the default, medium.
 */
import { useSyncExternalStore } from 'react';

import { NAMEPLATE_SIZES, UI_SCALE_FACTORS } from '../constants.js';

export type UiScale = keyof typeof UI_SCALE_FACTORS;
export const UI_SCALES: readonly UiScale[] = ['small', 'medium', 'large'];
export const DEFAULT_UI_SCALE: UiScale = 'medium';
export const UI_SCALE_KEY = 'cld.ui-scale';

export const parseUiScale = (raw: string | null): UiScale =>
  UI_SCALES.find((s) => s === raw) ?? DEFAULT_UI_SCALE;

export type NameplateSizes = (typeof NAMEPLATE_SIZES)[UiScale];
export const nameplateSizes = (scale: UiScale): NameplateSizes => NAMEPLATE_SIZES[scale];

function read(): UiScale {
  try {
    return parseUiScale(localStorage.getItem(UI_SCALE_KEY));
  } catch {
    return DEFAULT_UI_SCALE;
  }
}
let scale = read();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const uiScale = () => scale;
export const useUiScale = () => useSyncExternalStore(subscribe, uiScale);

function apply(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty('--ui-scale', String(UI_SCALE_FACTORS[scale]));
  document.documentElement.dataset.uiScale = scale;
}
apply();

export function setUiScale(next: string): void {
  scale = parseUiScale(next);
  try {
    localStorage.setItem(UI_SCALE_KEY, scale);
  } catch {
    // Private mode or a locked-down webview: this visit still remembers it.
  }
  apply();
  for (const l of listeners) l();
}

/** Tests: read the store again (after stubbing localStorage). */
export const reloadUiScale = (): void => {
  scale = read();
};
