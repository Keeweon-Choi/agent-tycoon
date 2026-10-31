/**
 * The review loop's client side (steps ③–④): one task worktree's notes as the daemon
 * broadcasts them (`reviewNotes`), the writes (`reviewNoteWrite`) and the send
 * (`reviewSend`). Kept apart from repoStore so the loop can move to 개발실 as it is.
 */
import { useSyncExternalStore } from 'react';

import type {
  BoardTask,
  ReviewNote,
  ReviewNoteResult,
  ReviewNotes,
  ReviewNotesRequest,
  ReviewNoteWrite,
  ReviewSend,
  ReviewSendResult,
} from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import { serverText } from '../serverText.js';
import type { ToastSink } from './repoStore.js';
import type { DiffRow } from './repoText.js';

export interface NotesView {
  notes: ReviewNote[];
  /** The commit the last send saw (S1): the "지난 검토 뒤 바뀐 것" diff is against it. */
  sentHead?: string;
  error?: string;
}
export interface SentView {
  to: string;
  count: number;
  at: number;
}
export interface ReviewSnapshot {
  /** Key `project\0task`. */
  notes: Record<string, NotesView>;
  /** A send in flight (its requestId). */
  sending: Record<string, string>;
  /** The last send's answer, for "보냄 → web-worker". */
  sent: Record<string, SentView>;
}

type Send = (msg: ReviewNotesRequest | ReviewNoteWrite | ReviewSend) => void;

const empty: ReviewSnapshot = { notes: {}, sending: {}, sent: {} };
let snapshot = empty;
const listeners = new Set<() => void>();
let seq = 0;
const newRequestId = () => `rv-${Date.now().toString(36)}-${++seq}`;

export const reviewKey = (project: string, task: string): string => `${project}\0${task}`;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
export const reviewGetSnapshot = () => snapshot;
export const useReviewStore = () => useSyncExternalStore(subscribe, reviewGetSnapshot);
function set(next: Partial<ReviewSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
}
function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}

// ── Pure helpers ────────────────────────────────────────────

/** The unsent notes (what "의견 N개 보내기" sends). */
export const unsentNotes = (notes: readonly ReviewNote[]): ReviewNote[] =>
  notes.filter((n) => !n.sentAt);

/** A shift-click range: from the anchor's line to the clicked one, in either order. */
export function lineRange(
  anchor: number | null,
  line: number,
): { startLine?: number; line: number } {
  if (anchor === null || anchor === line) return { line };
  return { startLine: Math.min(anchor, line), line: Math.max(anchor, line) };
}

/**
 * One file's notes placed under the diff row that shows their last line (the new side).
 * A file-level note, or one whose line is not on the rows shown (paged out, or the diff
 * moved under it), is `loose`: shown above the diff so it is never lost.
 */
export function placeNotes(
  rows: readonly DiffRow[],
  notes: readonly ReviewNote[],
  file: string,
): { byRow: Map<string, ReviewNote[]>; loose: ReviewNote[] } {
  const rowOf = new Map<number, string>();
  for (const row of rows) if (row.newNo !== undefined) rowOf.set(row.newNo, row.key);
  const byRow = new Map<string, ReviewNote[]>();
  const loose: ReviewNote[] = [];
  for (const note of notes) {
    if (note.file !== file) continue;
    const key = note.line > 0 ? rowOf.get(note.line) : undefined;
    if (key === undefined) loose.push(note);
    else byRow.set(key, [...(byRow.get(key) ?? []), note]);
  }
  return { byRow, loose };
}

/** "12번째 줄", "3–5번째 줄", "파일 전체". */
export function noteWhere(note: { line: number; startLine?: number }): string {
  if (note.line === 0) return t('review.wholeFile');
  if (note.startLine !== undefined && note.startLine !== note.line)
    return t('review.lines', { start: note.startLine, end: note.line });
  return t('review.line', { line: note.line });
}

/** Rows a range covers (the highlighted ones). */
export const inRange = (
  no: number | undefined,
  sel: { startLine?: number; line: number } | null,
): boolean =>
  no !== undefined && !!sel && sel.line > 0 && no >= (sel.startLine ?? sel.line) && no <= sel.line;

/**
 * Step ⑤: the Tasks that went into review since the board before (a Worker's update_task).
 * Nothing on the first board of a load: a reload is not a transition.
 */
export function newlyInReview(
  before: { tasks: BoardTask[] } | null,
  after: { tasks: BoardTask[] },
): BoardTask[] {
  if (!before) return [];
  const was = new Map(before.tasks.map((task) => [task.id, task.status]));
  return after.tasks.filter(
    (task) => task.status === 'review' && was.has(task.id) && was.get(task.id) !== 'review',
  );
}

// ── Wire ────────────────────────────────────────────────────

/** Ask for (and follow) one task worktree's notes. */
export function reviewOpen(project: string, task: string, send: Send): void {
  send({ type: 'reviewNotesRequest', requestId: newRequestId(), project, task });
}

export function reviewAdd(
  project: string,
  task: string,
  note: { file: string; line: number; startLine?: number; body: string },
  send: Send,
): void {
  send({
    type: 'reviewNoteWrite',
    requestId: newRequestId(),
    project,
    task,
    op: 'add',
    side: 'new',
    file: note.file,
    line: note.line,
    ...(note.startLine !== undefined && { startLine: note.startLine }),
    body: note.body,
  });
}

export function reviewEdit(
  project: string,
  task: string,
  id: string,
  body: string,
  send: Send,
): void {
  send({ type: 'reviewNoteWrite', requestId: newRequestId(), project, task, op: 'edit', id, body });
}

export function reviewDelete(project: string, task: string, id: string, send: Send): void {
  send({ type: 'reviewNoteWrite', requestId: newRequestId(), project, task, op: 'delete', id });
}

/** "의견 N개 보내기": once at a time per worktree. */
export function reviewSendNotes(project: string, task: string, send: Send): void {
  const key = reviewKey(project, task);
  if (snapshot.sending[key]) return;
  const requestId = newRequestId();
  set({ sending: { ...snapshot.sending, [key]: requestId } });
  send({ type: 'reviewSend', requestId, project, task });
}

export function reviewHandleMessage(
  msg: ReviewNotes | ReviewNoteResult | ReviewSendResult,
  toast: ToastSink,
  now = Date.now(),
): void {
  const key = reviewKey(msg.project, msg.task);
  switch (msg.type) {
    case 'reviewNotes':
      set({
        notes: {
          ...snapshot.notes,
          [key]: msg.ok
            ? { notes: msg.notes, ...(msg.sentHead && { sentHead: msg.sentHead }) }
            : {
                notes: snapshot.notes[key]?.notes ?? [],
                error: serverText(msg, t('repo.loadFailed')),
              },
        },
      });
      return;
    case 'reviewNoteResult':
      if (!msg.ok) toast(msg.task, serverText(msg, t('repo.loadFailed')), 'error');
      return;
    case 'reviewSendResult': {
      if (snapshot.sending[key] !== msg.requestId) return;
      const sending = without(snapshot.sending, key);
      if (!msg.ok) {
        set({ sending });
        toast(msg.task, serverText(msg, t('review.sendFailed')), 'error');
        return;
      }
      const sent = { to: msg.to ?? '', count: msg.count ?? 0, at: now };
      set({ sending, sent: { ...snapshot.sent, [key]: sent } });
      toast(msg.task, t('review.sentToast', { name: sent.to, count: sent.count }), 'ok');
    }
  }
}

/** The socket dropped: a send's answer can no longer arrive. */
export function reviewConnectionLost(): void {
  if (Object.keys(snapshot.sending).length) set({ sending: {} });
}

/** Test helper. */
export function reviewResetForTests(): void {
  snapshot = empty;
  listeners.forEach((listener) => listener());
}
