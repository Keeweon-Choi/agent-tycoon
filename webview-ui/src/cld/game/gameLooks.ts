/**
 * GAME-UI-1 G3: the terminal drawer's per-agent look and activity (the card bar's), published by the app
 * for the game surfaces that sit outside its props (the party roster, the job runner). Like waiting.ts.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { AgentAppearance, TabStatus } from '../../components/AgentCard.js';
import { fatigueFor, useCldStore } from '../officeStore.js';
import { useWaitReasons } from '../waiting.js';
import { contextLeft, type PartyState, partyState } from './gameState.js';
import type { IconName } from './parts.js';

export interface GameLooks {
  getAppearance: (agentId: number) => AgentAppearance;
  statusFor: (agentId: number) => TabStatus | null;
}

let current: GameLooks | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function publishGameLooks(next: GameLooks): void {
  if (current?.getAppearance === next.getAppearance && current.statusFor === next.statusFor) return;
  current = next;
  listeners.forEach((l) => l());
}
export const useGameLooks = (): GameLooks | null => useSyncExternalStore(subscribe, () => current);

/**
 * A number that goes up each time `value` changes in a way `when(prev, next)` accepts, after the first
 * render: a part keys its one-shot animation on it, so nothing plays on mount or on a reload.
 */
export function useChangeKey<T>(value: T, when: (prev: T, next: T) => boolean = (a, b) => a !== b): number {
  const prev = useRef(value);
  const [key, setKey] = useState(0);
  useEffect(() => {
    if (prev.current !== value && when(prev.current, value)) setKey((k) => k + 1);
    prev.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return key;
}

// ── The party roster (Party.tsx, PartyWindow.tsx) ──
/** Open or not (one viewer, one window). */
let partyOpen = false;
export function openParty(next: boolean): void {
  if (partyOpen === next) return;
  partyOpen = next;
  listeners.forEach((l) => l());
}
export const usePartyOpen = () => useSyncExternalStore(subscribe, () => partyOpen);

export const STATE_ICON: Record<PartyState, IconName> = { work: 'hammer', ask: 'ask', lock: 'lock', rest: 'zzz' };

/** One member's state and what is left of its context (null: it has not said, Codex). */
export function useMember(id: number): { state: PartyState; left: number | null } {
  const store = useCldStore();
  const reasons = useWaitReasons();
  const looks = useGameLooks();
  return {
    state: partyState(reasons[id], looks?.statusFor(id) ?? null),
    left: contextLeft(fatigueFor(id, store)?.value),
  };
}

