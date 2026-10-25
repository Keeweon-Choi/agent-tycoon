/** GFX: when the title scene shows (TitleScene.tsx draws it). */
import { useSyncExternalStore } from 'react';

import { OPEN_TARGET_KEY, parseNoticeUrl } from '../../../../core/src/cld/notices.js';
import { LAYOUT_UNITS_PER_PX, LOBBY_ART } from '../../constants.js';
import SPOTS from './lobbySpots.json';

export const TITLE_KEY = 'cld.title-scene';
const SEEN_KEY = 'cld.title-seen';

const tryRead = (read: () => string | null): string | null => {
  try {
    return read();
  } catch {
    return null;
  }
};

let state = {
  /** Show it on the first open of a session (per browser, on unless 'off'). */
  atStart: tryRead(() => localStorage.getItem(TITLE_KEY)) !== 'off',
  open: false,
};
/** Opened for something else: a notice's link (a conversation, a job, a character), straight or
 *  carried through the login. The lobby would cover what the user came to see. */
const deepLink = () =>
  tryRead(() =>
    parseNoticeUrl(location.search) ? '1' : sessionStorage.getItem(OPEN_TARGET_KEY),
  ) !== null;
/** A reload of this page (the session goes on): no lobby again. A new window, tab or a launch of
 *  the installed app is a new session (its own sessionStorage) and shows it. */
const reloaded = () => {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined;
    return nav?.type === 'reload';
  } catch {
    return false;
  }
};
const seen = () => tryRead(() => sessionStorage.getItem(SEEN_KEY)) !== null;
/** Every fresh launch, installed apps included (owner 10-25 22:27); never over a notice or deep
 *  link, never again on a reload within the session. */
export function lobbyAtLaunch(o: {
  atStart: boolean;
  seen: boolean;
  deepLink: boolean;
  reloaded: boolean;
}): boolean {
  return o.atStart && !o.seen && !o.deepLink && !o.reloaded;
}
state.open = lobbyAtLaunch({
  atStart: state.atStart,
  seen: seen(),
  deepLink: deepLink(),
  reloaded: reloaded(),
});
// A session opened for a link counts as seen: its reloads stay on what it came to show.
if (!state.open)
  try {
    sessionStorage.setItem(SEEN_KEY, '1');
  } catch {
    // No storage: nothing to remember.
  }
const listeners = new Set<() => void>();
const set = (next: Partial<typeof state>) => {
  state = { ...state, ...next };
  for (const l of listeners) l();
};
export const useTitleScene = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => state,
  );
export const showTitleScene = () => set({ open: true });
export function closeTitleScene(): void {
  try {
    sessionStorage.setItem(SEEN_KEY, '1');
  } catch {
    // No storage: it shows again on the next open, nothing worse.
  }
  set({ open: false });
}
export function setTitleAtStart(on: boolean): void {
  try {
    localStorage.setItem(TITLE_KEY, on ? 'on' : 'off');
  } catch {
    // Private mode: this visit still remembers it.
  }
  set({ atStart: on });
}

export type LobbyArtKind = keyof typeof SPOTS;

/** A picture placed on a whole device px is still resampled when that px is not also a whole
 *  layout unit (Blink lays boxes out in 1/64 CSS px: at dpr 1.25 only every 5th device px is
 *  both, at 1.5 every 3rd, at 2.625 every 21st); the same goes for its size. The step. */
function exactStep(dpr: number): number {
  for (let q = 1; q < LAYOUT_UNITS_PER_PX; q++) {
    const units = (q * LAYOUT_UNITS_PER_PX) / dpr;
    if (Math.abs(units - Math.round(units)) < 1e-6) return q;
  }
  return 1;
}
/** v (CSS px) moved to the nearest device px that is also a whole layout unit. */
export function snapExact(v: number, dpr: number): number {
  const q = exactStep(dpr);
  return (Math.round((v * dpr) / q) * q) / dpr;
}
/** n device px rounded up to a size that is a whole number of layout units (a canvas that big,
 *  its picture in it at n px, is drawn 1:1). */
export const exactDevicePx = (n: number, dpr: number): number => {
  const q = exactStep(dpr);
  return Math.ceil(n / q) * q;
};

/** The left edge of the cast at the counter (CSS px), for the menu to keep clear of. */
export function lobbyCastLeft(w: number, h: number): number {
  const { art, s, left } = lobbyCover(w, h);
  return left + (Math.min(...SPOTS[art].desk.xs) - LOBBY_ART.castHalfArtPx) * s;
}

/** The picture for a window, and where it lands (CSS px, a centred cover). */
export function lobbyCover(w: number, h: number): { art: LobbyArtKind; s: number; left: number; top: number } {
  const art: LobbyArtKind = w / h > LOBBY_ART.wideMinAspect ? 'wide' : 'tall';
  const { w: iw, h: ih } = SPOTS[art];
  const s = Math.max(w / iw, h / ih);
  return { art, s, left: (w - iw * s) / 2, top: (h - ih * s) / 2 };
}
