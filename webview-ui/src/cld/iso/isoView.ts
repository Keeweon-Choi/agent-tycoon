/**
 * ISO-PILOT (owner 10-26 00:17): the office as an isometric building, behind a switch
 * (설정 > 화면 "아이소메트릭 (시험)", per browser, off by default). Off, nothing isometric runs
 * and the office is the top-down one, untouched. Per browser: `cld.office-iso` ('on').
 */
import { useSyncExternalStore } from 'react';

export const OFFICE_ISO_KEY = 'cld.office-iso';

let on = (() => {
  try {
    return localStorage.getItem(OFFICE_ISO_KEY) === 'on';
  } catch {
    return false;
  }
})();
const listeners = new Set<() => void>();

export const isoOn = () => on;
export const useIsoView = () =>
  useSyncExternalStore((l) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  }, isoOn);
export function setIsoView(next: boolean): void {
  on = next;
  try {
    localStorage.setItem(OFFICE_ISO_KEY, next ? 'on' : 'off');
  } catch {
    // Private mode: this visit still remembers it.
  }
  for (const l of listeners) l();
}
