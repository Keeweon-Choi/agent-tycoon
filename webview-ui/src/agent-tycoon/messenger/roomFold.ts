/** ROOM-FOLD: which room threads are folded (thread id -> its reply count when it was folded), per browser. */
import { useSyncExternalStore } from 'react';

import { ROOM_FOLD_KEY, ROOM_FOLD_MAX } from '../../constants.js';

export type FoldState = Record<string, number>;

export const unfoldThread = (state: FoldState, id: string): FoldState =>
  Object.fromEntries(Object.entries(state).filter(([key]) => key !== id));

export const foldThread = (state: FoldState, id: string, count: number): FoldState =>
  // ponytail: the newest ROOM_FOLD_MAX folds are kept (insertion order), the oldest are forgotten
  Object.fromEntries(Object.entries({ ...unfoldThread(state, id), [id]: count }).slice(-ROOM_FOLD_MAX));

/** Replies that came after the thread was folded (0 for an open thread). */
export const unseenReplies = (state: FoldState, id: string, count: number): number =>
  id in state ? Math.max(0, count - state[id]) : 0;

export function parseFold(raw: string | null): FoldState {
  try {
    const value: unknown = raw ? JSON.parse(raw) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, n]) => Number.isInteger(n) && (n as number) >= 0)) as FoldState;
  } catch {
    return {};
  }
}

const read = (): FoldState => {
  try {
    return parseFold(localStorage.getItem(ROOM_FOLD_KEY));
  } catch {
    return {};
  }
};
let state = read();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

function set(next: FoldState): void {
  state = next;
  try {
    localStorage.setItem(ROOM_FOLD_KEY, JSON.stringify(next));
  } catch {
    /* blocked store: the folds last until the page closes */
  }
  listeners.forEach((l) => l());
}

export function useThreadFold() {
  const folds = useSyncExternalStore(subscribe, () => state);
  return {
    folds,
    fold: (id: string, count: number) => set(foldThread(state, id, count)),
    unfold: (id: string) => set(unfoldThread(state, id)),
  };
}
