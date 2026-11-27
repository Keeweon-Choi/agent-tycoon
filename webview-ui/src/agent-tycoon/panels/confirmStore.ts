/**
 * T-182: whether the 현황판's 요약 shows 차례대로 확인하기 in place of its boxes, and for which project (the
 * issue board's 검토 column opens it on its own project; the 요약 row follows the 요약's project filter).
 * A visit only: never stored.
 */
import { useSyncExternalStore } from 'react';

import { showOffice } from '../hud/hudStore.js';

export interface ConfirmOpen {
  open: boolean;
  /** One project only (opened from that project's issue board), else the 요약's filter. */
  project: string | null;
}

let state: ConfirmOpen = { open: false, project: null };
const listeners = new Set<() => void>();
const set = (next: ConfirmOpen) => {
  state = next;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const get = () => state;
export const useConfirmOpen = () => useSyncExternalStore(subscribe, get, get);

export function openConfirm(project: string | null = null): void {
  set({ open: true, project });
  showOffice('status');
}
export const closeConfirm = () => set({ open: false, project: null });
