import type { ReactNode } from 'react';

import { MOBILE_CARD_ORDER_STORAGE_KEY } from '../constants.js';

/** Pure rules shared by the agent card bars — highlight tier and the mobile
 *  bar's drag-to-reorder order (DOM-free, so they run on the Node runner). */

/** Card highlight tiers: 'focused' = the agent's character is selected in the
 *  office (active background, no border); 'active' = its terminal pane is the
 *  one showing (background + accent border). */
export type CardVariant = 'default' | 'focused' | 'active';

/** One rule for both card bars: the showing terminal pane wins, then the
 *  character selected in the office. Pass activeId null where no pane shows
 *  (VS Code, or the mobile office page). */
export function cardVariant(
  agentId: number,
  { activeId, focusedId }: { activeId: number | null; focusedId: number | null },
): CardVariant {
  if (agentId === activeId) return 'active';
  if (agentId === focusedId) return 'focused';
  return 'default';
}

/** Saved order first (dropping closed agents), then any new agents appended
 *  in creation order — so a reorder survives launches and closes. */
export function mergeOrder(saved: readonly number[], live: readonly number[]): number[] {
  const liveSet = new Set(live);
  const ordered = saved.filter((id) => liveSet.has(id));
  const seen = new Set(ordered);
  for (const id of live) {
    if (!seen.has(id)) ordered.push(id);
  }
  return ordered;
}

/** The per-device card order (both bars share it); [] when nothing is saved or storage is blocked. */
export function loadSavedOrder(): number[] {
  try {
    const raw = localStorage.getItem(MOBILE_CARD_ORDER_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === 'number') : [];
  } catch {
    return [];
  }
}

export function saveOrder(ids: readonly number[]): void {
  try {
    localStorage.setItem(MOBILE_CARD_ORDER_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage full/blocked: the order still applies for this session.
  }
}

/**
 * The order with `dragId` moved to where the pointer is: before the first
 * other card whose midpoint lies past `x`, else last (a row's x, or a column's y: the caller picks the axis).
 * `midpointOf` returns a card's midpoint in the same coordinate space as `x`
 * (null for a card that isn't laid out, which is skipped).
 */
export function reorderByPointer(
  ids: readonly number[],
  dragId: number,
  midpointOf: (id: number) => number | null,
  x: number,
  groupOf?: (id: number) => number,
): number[] {
  // cld-gui (T-0036): with groups, the card only moves among its own group's
  // slots, so a drag never crosses into another group.
  const group = groupOf?.(dragId);
  const inGroup = (id: number) => !groupOf || groupOf(id) === group;
  const others = ids.filter((id) => id !== dragId && inGroup(id));
  let insertAt = others.length;
  for (let i = 0; i < others.length; i++) {
    const mid = midpointOf(others[i]);
    if (mid !== null && x < mid) {
      insertAt = i;
      break;
    }
  }
  const moved = [...others.slice(0, insertAt), dragId, ...others.slice(insertAt)];
  let next = 0;
  return ids.map((id) => (inGroup(id) ? moved[next++] : id));
}

/** cld-gui (T-0036): a card in cld mode — its group and name. */
export interface CardInfo {
  /** Group rank: lower groups come first. */
  group: number;
  /** The group's header ("오케스트레이터"). */
  groupLabel: string;
  name: string;
  /** cld-gui (T-0041): what the card adds under its name ("+N" temps, 퇴근). */
  extra?: ReactNode;
  /** The part of `extra` a compact card keeps beside its status dot (퇴근, 야근). */
  status?: ReactNode;
}

/** The phone's cards (owner 10-24): compact unless this device expanded them ('1' stored). */
export const cardsExpanded = (saved: string | null): boolean => saved === '1';
export const savedCardsExpanded = (expanded: boolean): string => (expanded ? '1' : '0');

/** cld-gui (T-0036): stable sort by group rank, keeping the order inside each group. */
export function groupOrder(ids: readonly number[], groupOf: (id: number) => number): number[] {
  return ids
    .map((id, i) => ({ id, i, g: groupOf(id) }))
    .sort((a, b) => a.g - b.g || a.i - b.i)
    .map(({ id }) => id);
}
