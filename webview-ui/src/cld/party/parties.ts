/**
 * FEAT-PARTY-V2 (owner 11-06 17:49): the parties the owner composes in the party column. The default party
 * is everyone (the screen's own, never stored, never deleted); the others are the daemon's (`parties`,
 * parties.json), so the desktop app and the phone see the same ones. A member is a look key (lookNameOf: a
 * character's name, `emp:<id>`), stable across restarts where agent ids are not. Which party this device
 * shows is a per-device choice (localStorage). The edits are pure (tested), then sent whole (`setParties`).
 */
import { useSyncExternalStore } from 'react';

import { PARTY_DEFAULT_ID, PARTY_MAX, PARTY_MEMBER_MAX, PARTY_NAME_MAX } from '../../../../core/src/constants.js';
import type { Parties, Party, SetParties } from '../../../../core/src/messages.js';
import { PARTY_SELECTED_STORAGE_KEY } from '../../constants.js';

export type { Party };
/** The default party's id (the daemon refuses it as a stored one). */
export const ALL_PARTY = PARTY_DEFAULT_ID;

// ── The edits (pure) ──

const cleanName = (name: string) => name.trim().slice(0, PARTY_NAME_MAX);

/** A new party named `name` (its members to come), or the list as it was when full or unnamed. */
export function createParty(list: readonly Party[], name: string, id: string, members: string[] = []): Party[] {
  const n = cleanName(name);
  if (!n || list.length >= PARTY_MAX || id === ALL_PARTY || list.some((p) => p.id === id)) return [...list];
  return [...list, { id, name: n, members: [...new Set(members)] }];
}

export function renameParty(list: readonly Party[], id: string, name: string): Party[] {
  const n = cleanName(name);
  return list.map((p) => (p.id === id && n ? { ...p, name: n } : p));
}

/** Add `key` to the party (while it has room), or take it out when it is in. */
export function toggleMember(list: readonly Party[], id: string, key: string): Party[] {
  return list.map((p) => {
    if (p.id !== id) return p;
    if (p.members.includes(key)) return { ...p, members: p.members.filter((m) => m !== key) };
    return p.members.length >= PARTY_MEMBER_MAX ? p : { ...p, members: [...p.members, key] };
  });
}

export const deleteParty = (list: readonly Party[], id: string): Party[] => list.filter((p) => p.id !== id);

/** The party shown: the chosen one while it exists, else everyone. */
export const currentParty = (list: readonly Party[], selected: string | null): Party | null =>
  list.find((p) => p.id === selected) ?? null;

/** The ids a party shows, in the column's order: everyone for the default party, else its members. */
export function partyIds(ids: readonly number[], party: Party | null, keyOf: (id: number) => string | undefined): number[] {
  if (!party) return [...ids];
  const members = new Set(party.members);
  return ids.filter((id) => {
    const key = keyOf(id);
    return key !== undefined && members.has(key);
  });
}

// ── The store ──

let parties: Party[] = [];
let selected: string | null = (() => {
  try {
    return localStorage.getItem(PARTY_SELECTED_STORAGE_KEY);
  } catch {
    return null;
  }
})();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export const partiesNow = (): Party[] => parties;
export const useParties = (): Party[] => useSyncExternalStore(subscribe, partiesNow);
export const selectedNow = (): string | null => selected;
export const useSelectedParty = (): string | null => useSyncExternalStore(subscribe, selectedNow);

/** `parties` from the daemon: the full list replaces what was held. */
export function partiesHandleMessage(msg: Parties): void {
  parties = msg.parties;
  emit();
}

/** Show party `id` on this device (ALL_PARTY or null: everyone). */
export function selectParty(id: string | null): void {
  selected = id === ALL_PARTY ? null : id;
  try {
    if (selected) localStorage.setItem(PARTY_SELECTED_STORAGE_KEY, selected);
    else localStorage.removeItem(PARTY_SELECTED_STORAGE_KEY);
  } catch {
    // Storage blocked: the choice holds for this page.
  }
  emit();
}

/** Apply an edit here at once and send the whole list (the daemon answers everyone with what it kept). */
export function saveParties(next: Party[], send: (msg: SetParties) => void): void {
  parties = next;
  emit();
  send({ type: 'setParties', parties: next });
}

export const newPartyId = (): string => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
