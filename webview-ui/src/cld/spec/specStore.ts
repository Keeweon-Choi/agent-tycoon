/**
 * SPT-P1A: the one piece of spec tracking in the main bundle. `specChanged` carries a project's
 * Registry revision; a mounted 개요 or 문서 tab reads it and fetches again. Nothing polls.
 */
import { useSyncExternalStore } from 'react';

import type { SpecChanged } from '../../../../core/src/messages.js';

let revs: Record<string, number> = {};
const listeners = new Set<() => void>();

export function specHandleMessage(msg: SpecChanged): void {
  revs = { ...revs, [msg.project]: msg.rev };
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
export const useSpecRev = (project: string): number => useSyncExternalStore(subscribe, () => revs[project] ?? 0);
