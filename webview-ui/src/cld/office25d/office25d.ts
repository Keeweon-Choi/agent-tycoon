/**
 * 2.5D PILOT (owner 10-25 22:27): the office drawn in a three-quarter style from the owner's
 * converted art, behind a switch (설정 > 화면, off by default). Off, nothing here runs and the
 * office is pixel-identical to before.
 *
 * Only the pictures change: the saved layout, the tile grid, walking and collision are the same
 * (the footprint stays the world truth; see layoutSerializer.visualPlacement). Per browser:
 * `cld.office-25d` ('on' to draw it).
 */
import { useSyncExternalStore } from 'react';

export const OFFICE_25D_KEY = 'cld.office-25d';

let on = (() => {
  try {
    return localStorage.getItem(OFFICE_25D_KEY) === 'on';
  } catch {
    return false;
  }
})();
const listeners = new Set<() => void>();

/** Whether the switch is on (the art may still be loading: see skins.ts). */
export const office25dOn = () => on;
export const useOffice25d = () =>
  useSyncExternalStore((l) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  }, office25dOn);
/** Called after every flip of the switch. */
export function onOffice25d(l: () => void): void {
  listeners.add(l);
}
export function setOffice25d(next: boolean): void {
  on = next;
  try {
    localStorage.setItem(OFFICE_25D_KEY, next ? 'on' : 'off');
  } catch {
    // Private mode: this visit still remembers it.
  }
  for (const l of listeners) l();
}
