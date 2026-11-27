/**
 * ROOM-FOLD: every room thread with replies is folded until the reader opens it. What the reader did is
 * kept per browser: thread id -> whether it is open, and how many replies it had when they last had it
 * open (what a folded thread then counts as new).
 */
import { useSyncExternalStore } from 'react';

import { ROOM_FOLD_KEY, ROOM_FOLD_MAX } from '../../constants.js';

export interface FoldEntry {
  open: boolean;
  seen: number;
}
export type FoldState = Record<string, FoldEntry>;

const remember = (state: FoldState, id: string, entry: FoldEntry): FoldState =>
  // ponytail: the newest ROOM_FOLD_MAX threads are kept (insertion order), the oldest are forgotten (folded again)
  Object.fromEntries(
    Object.entries({ ...Object.fromEntries(Object.entries(state).filter(([key]) => key !== id)), [id]: entry }).slice(
      -ROOM_FOLD_MAX,
    ),
  );

export const isOpen = (state: FoldState, id: string): boolean => state[id]?.open === true;

/** The reader opened the thread (it had `count` replies): it stays open until they fold it. */
export const openThread = (state: FoldState, id: string, count: number): FoldState =>
  isOpen(state, id) ? state : remember(state, id, { open: true, seen: count });

/** The reader folded the thread by hand (it had `count` replies): later replies count as new. */
export const foldThread = (state: FoldState, id: string, count: number): FoldState =>
  remember(state, id, { open: false, seen: count });

/** Replies that came after the reader last had the thread open (0 for an open thread or one never opened). */
export const unseenReplies = (state: FoldState, id: string, count: number): number => {
  const entry = state[id];
  return entry && !entry.open ? Math.max(0, count - entry.seen) : 0;
};

export function parseFold(raw: string | null): FoldState {
  try {
    const value: unknown = raw ? JSON.parse(raw) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(([, e]) => {
        const entry = e as Partial<FoldEntry> | null;
        return !!entry && typeof entry.open === 'boolean' && Number.isInteger(entry.seen) && entry.seen! >= 0;
      }),
    ) as FoldState;
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
  if (next === state) return;
  state = next;
  try {
    localStorage.setItem(ROOM_FOLD_KEY, JSON.stringify(next));
  } catch {
    /* blocked store: what was opened lasts until the page closes */
  }
  listeners.forEach((l) => l());
}

export function useThreadFold() {
  const folds = useSyncExternalStore(subscribe, () => state);
  return {
    folds,
    fold: (id: string, count: number) => set(foldThread(state, id, count)),
    open: (id: string, count: number) => set(openThread(state, id, count)),
  };
}
