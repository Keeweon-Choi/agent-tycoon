/**
 * DV4 (M1 새 워크트리, M2 앉히기): the owner's own way to make a worktree and seat an agent in
 * it, beside the Lead's delegate_task. One `repoAction worktreeNew` with `seat` (the daemon gives
 * the Task's worktree to the agent, starts or restarts it there, then sends the first instruction);
 * a `stepup` answer proves this device once and sends it again. The worktree then opens on the
 * agent's 터미널 (T-70). The pure parts (the folder, the
 * agents' lines, the bases) are in devroomState.ts.
 */
import { useEffect, useSyncExternalStore } from 'react';

import type { RepoAction, RepoActionResult } from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import { stepUpFailedText } from '../auth/authApi.js';
import { requestStepUp } from '../auth/stepUp.js';
import { cldToast } from '../officeStore.js';
import { resultToast } from '../repo/repoText.js';
import type { Group, Row } from './devroomData.js';
import type { SeatAgent } from './devroomState.js';
import { openDevRoom } from './devroomStore.js';

// ── The one request and its answer ─────────────────────────────────

type Done = (result: RepoActionResult) => void;
type Send = (msg: RepoAction) => void;
const sent = new Map<string, { msg: RepoAction; send: Send; retried: boolean; done: Done }>();
let seq = 0;

/** Send one worktreeNew; `done` hears its answer (after one step-up when a remote device needs it). False: not connected, nothing sent. */
export function seatSend(send: Send, connected: boolean, fields: Omit<RepoAction, 'type' | 'requestId' | 'action'>, done: Done): boolean {
  if (!connected) return false;
  const msg: RepoAction = { type: 'repoAction', requestId: `seat-${Date.now().toString(36)}-${++seq}`, action: 'worktreeNew', ...fields };
  sent.set(msg.requestId, { msg, send, retried: false, done });
  send(msg);
  return true;
}

export function seatHandleResult(msg: RepoActionResult): void {
  const s = sent.get(msg.requestId);
  if (!s) return;
  sent.delete(msg.requestId);
  if (msg.error !== 'stepup' || s.retried) return s.done(msg.error === 'stepup' ? { ...msg, error: stepUpFailedText() } : msg);
  const lost = () => s.done({ ...msg, error: stepUpFailedText() });
  void requestStepUp().then((ok) => {
    if (!ok) return lost();
    const again = { ...s.msg, requestId: `${s.msg.requestId}-2` };
    sent.set(again.requestId, { msg: again, send: s.send, retried: true, done: s.done });
    s.send(again);
  }, lost);
}

/** The worktree to open once its card is in the list (its repoState may come after the answer). */
let opening: { project: string; task: string; agent: string | null } | null = null;
export const openWhenShown = (project: string, task: string, agent: string | null) => {
  opening = { project, task, agent };
};
/** T-70: the seated agent whose pane the board opens on its 터미널 when its worktree opens (like Orca). */
let seatedFor: string | null = null;
/** The board: true once when `name` is the agent just seated (it then shows its pane, 터미널 on). */
export function takeSeated(name: string): boolean {
  if (seatedFor !== name) return false;
  seatedFor = null;
  return true;
}
/** Rail and phone: a worktree just made opens once its card is in the list (its repoState may come after the answer). */
export function useOpenWhenShown(groups: readonly Group[]): void {
  useEffect(() => {
    if (!opening || !groups.some((g) => g.project === opening?.project && g.rows.some((r) => r.wt.task === opening?.task))) return;
    const o = opening;
    opening = null;
    openSeated(o.project, o.task, o.agent);
  }, [groups]);
}
/** Worktree `task` opened on `agent`'s pane (its 터미널). */
function openSeated(project: string, task: string, agent: string | null): void {
  seatedFor = agent;
  openDevRoom(project, task);
}

// ── M2: the chip being dragged, and the one question before a restart ──────────

export interface SeatAsk {
  project: string;
  agent: SeatAgent;
  /** The card's folder and Task. */
  task: string;
  taskId: string;
  branch: string;
}
export interface SeatUi {
  dragging: SeatAgent | null;
  asking: SeatAsk | null;
  /** Touch: the chip held, whose work-space sheet is open. */
  picking: string | null;
}
let ui: SeatUi = { dragging: null, asking: null, picking: null };
const uiListeners = new Set<() => void>();
export const setSeatUi = (next: Partial<SeatUi>) => {
  ui = { ...ui, ...next };
  uiListeners.forEach((l) => l());
};
export const useSeatUi = () =>
  useSyncExternalStore(
    (l) => {
      uiListeners.add(l);
      return () => void uiListeners.delete(l);
    },
    () => ui,
  );

/** The toast of the answer, and what opens after it. */
export function answered(project: string, msg: RepoActionResult, open: string | null, agent: string | null = null): void {
  const { text, tone } = resultToast(msg);
  cldToast(project, text, tone);
  if (msg.ok && open) openWhenShown(project, open, agent);
}

/** M2: seat `agent` in card `row` (asked once when that restarts it). */
export function seatOn(send: Send, connected: boolean, group: Group, row: Row, agent: SeatAgent): void {
  // It sits there already: a running one just opens its pane (an off one is started there).
  if (row.wt.assignee === agent.name && agent.state !== 'off') return openSeated(group.project, row.wt.task, agent.name);
  if (!row.wt.taskId) return cldToast(group.project, t('devroom.newSpace.noTask'), 'error');
  const ask = { project: group.project, agent, task: row.wt.task, taskId: row.wt.taskId, branch: row.wt.branch };
  if (agent.restarts) setSeatUi({ asking: ask, picking: null });
  else seatNow(send, connected, ask);
}

export function seatNow(send: Send, connected: boolean, a: { project: string; agent: SeatAgent; task: string; taskId: string }): void {
  setSeatUi({ asking: null, picking: null });
  const ok = seatSend(send, connected, { project: a.project, taskId: a.taskId, assignee: a.agent.name, seat: true }, (msg) => answered(a.project, msg, a.task, a.agent.name));
  if (!ok) cldToast(a.project, t('messenger.error.disconnectedSend'), 'error');
}

