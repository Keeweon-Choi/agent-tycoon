/** STAT-CARD: which character's detail view is open (null: none). One viewer, one view. */
import { useSyncExternalStore } from 'react';

let openId: number | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export const statDetailId = (): number | null => openId;
export const useStatDetailId = (): number | null => useSyncExternalStore(subscribe, statDetailId);
export function openStatDetail(agentId: number | null): void {
  if (openId === agentId) return;
  openId = agentId;
  listeners.forEach((l) => l());
}
