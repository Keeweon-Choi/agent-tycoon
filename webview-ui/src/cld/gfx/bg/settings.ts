/**
 * BACKGROUND setting as the screen sees it: what the daemon last sent (`officeBackground`), kept
 * for every screen alike (the daemon stores it, so phone and PC agree). Until the daemon has said,
 * and for a read-only connection that cannot change it, the default holds. A change is sent and
 * shown at once; the daemon's answer (or its refusal, with the stored look) replaces it.
 */
import { useSyncExternalStore } from 'react';

import {
  type BackgroundSettings,
  DEFAULT_BACKGROUND,
  nextSeed,
  parseBackground,
} from '../../../../../core/src/cld/background.js';
import type { ServerMessage } from '../../../../../core/src/messages.js';

let state: BackgroundSettings = DEFAULT_BACKGROUND;
const listeners = new Set<() => void>();
const set = (next: BackgroundSettings) => {
  if (next.time === state.time && next.mix === state.mix && next.seed === state.seed) return;
  state = next;
  listeners.forEach((l) => l());
};

export const backgroundSettings = (): BackgroundSettings => state;
export const useBackgroundSettings = (): BackgroundSettings =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    backgroundSettings,
    backgroundSettings,
  );

export function backgroundHandleMessage(msg: ServerMessage): void {
  if (msg.type !== 'officeBackground') return;
  const next = parseBackground(msg);
  if (next) set(next);
}

/** Change one or more fields (`reroll`: a new seed); the daemon keeps it for every screen. */
export function setBackground(patch: Partial<BackgroundSettings> & { reroll?: boolean }): void {
  const { reroll, ...fields } = patch;
  const next = { ...state, ...fields, ...(reroll && { seed: nextSeed(state.seed) }) };
  set(next);
  // Loaded on use: the transport touches `window`, and this store is imported by Node-run tests.
  void import('../../../transport/index.js').then(({ transport }) =>
    transport.send({ type: 'setOfficeBackground', ...next }),
  );
}

/** Test seam: back to the default. */
export const resetBackground = () => set(DEFAULT_BACKGROUND);
