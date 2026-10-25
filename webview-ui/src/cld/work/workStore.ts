/**
 * T-0056: the read-only work view of a temp. One view at a time (the sheet),
 * opened from a temp character or a row of a lead's "+N" list. It asks the
 * daemon with `workView` and shows the `workContent` that follows: a Claude
 * temp's transcript (all of it once, then appends). Nothing here sends anything to the temp.
 */
import { useSyncExternalStore } from 'react';

import type { ChatItem, ClientMessage, WorkContent } from '../../../../core/src/messages.js';
import type { ModelBadge } from '../modelBadges.js';
import { serverText } from '../serverText.js';
import type { TempKind, TempRow, WorkRef } from '../temps.js';

/** The newest items kept (the server holds 150). */
export const WORK_ITEMS_MAX = 300;

export interface WorkOpen {
  ref: WorkRef;
  kind: TempKind;
  name: string;
  /** The lead's character, for 리더에게 가기; null: 외주. */
  leadId: number | null;
  model: ModelBadge | null;
  modelId: string | null;
}

export interface WorkSnapshot {
  open: WorkOpen | null;
  /** null: nothing has come yet. */
  items: ChatItem[] | null;
  title: string | null;
  error: string | null;
}

const EMPTY: WorkSnapshot = { open: null, items: null, title: null, error: null };

// ── Pure rules (unit-tested) ─────────────────────────────────

/** The same view: a `workContent` is for the open ref only. */
export function sameRef(a: WorkRef, b: { kind: string; agentId?: number; id?: string }): boolean {
  return a.kind === b.kind && a.agentId === b.agentId && a.id === b.id;
}

/** The snapshot after a `workContent`: ignored for another view; items replace
 *  or (append) follow, capped; an error shows. */
export function applyContent(snap: WorkSnapshot, msg: WorkContent): WorkSnapshot {
  if (!snap.open || !sameRef(snap.open.ref, msg)) return snap;
  const items = msg.append
    ? [...(snap.items ?? []), ...msg.items].slice(-WORK_ITEMS_MAX)
    : msg.items.slice(-WORK_ITEMS_MAX);
  return {
    ...snap,
    items,
    title: msg.title ?? snap.title,
    error: msg.error ? serverText(msg) : null,
  };
}

/** The request that opens or closes `ref`. */
export function viewMessage(ref: WorkRef, on: boolean): ClientMessage {
  return {
    type: 'workView',
    kind: ref.kind,
    ...(ref.agentId !== undefined && { agentId: ref.agentId }),
    ...(ref.id !== undefined && { id: ref.id }),
    on,
  };
}

// ── Store ────────────────────────────────────────────────────

let snapshot: WorkSnapshot = EMPTY;
const listeners = new Set<() => void>();
const set = (next: WorkSnapshot) => {
  snapshot = next;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const workGetSnapshot = () => snapshot;
export const useWork = () => useSyncExternalStore(subscribe, workGetSnapshot);

type Send = (msg: ClientMessage) => void;

/** Open `row`'s work view (another view closes first). False: nothing to read for it. */
export function openWork(row: TempRow, send: Send): boolean {
  if (!row.work) return false;
  if (snapshot.open) {
    if (sameRef(snapshot.open.ref, row.work)) return true;
    send(viewMessage(snapshot.open.ref, false));
  }
  set({
    ...EMPTY,
    open: { ref: row.work, kind: row.kind, name: row.name, leadId: row.leadId, model: row.model, modelId: row.modelId },
  });
  send(viewMessage(row.work, true));
  return true;
}

export function closeWork(send: Send): void {
  if (!snapshot.open) return;
  send(viewMessage(snapshot.open.ref, false));
  set(EMPTY);
}

export function workHandleMessage(msg: WorkContent): void {
  const next = applyContent(snapshot, msg);
  if (next !== snapshot) set(next);
}

/** Test helper. */
export function workResetForTests(): void {
  set(EMPTY);
}
