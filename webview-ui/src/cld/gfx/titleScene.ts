/** GFX: when the title scene shows (TitleScene.tsx draws it). */
import { useSyncExternalStore } from 'react';

import { OPEN_TARGET_KEY, parseNoticeUrl } from '../../../../core/src/cld/notices.js';
import { isHomeScreenApp } from '../auth/authApi.js';

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
// ponytail: an installed (Home-Screen) app never shows it by itself: iOS drops sessionStorage when
// it relaunches a suspended app, so "first open of a session" would be every resume there. The
// Lobby button still opens it; a per-app "seen today" stamp if the owner wants it back on launch.
const installed = () => {
  try {
    return isHomeScreenApp();
  } catch {
    return false;
  }
};
state.open =
  state.atStart &&
  tryRead(() => sessionStorage.getItem(SEEN_KEY)) === null &&
  !deepLink() &&
  !installed();
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
