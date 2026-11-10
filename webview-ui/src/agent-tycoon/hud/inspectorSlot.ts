/** hud-v3 P0: where the inspector draws (hud/Inspector.tsx): the agty desktop party bar's slot, or null. */
import { useSyncExternalStore } from 'react';

let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

/** The party bar's own (null on unmount). */
export function setInspectorSlot(el: HTMLElement | null): void {
  if (slot === el) return;
  slot = el;
  for (const l of listeners) l();
}

export const useInspectorSlot = (): HTMLElement | null =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => slot,
  );
