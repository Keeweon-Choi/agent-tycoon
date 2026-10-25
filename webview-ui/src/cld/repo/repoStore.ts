/**
 * The repository panel's state (T-0020): the latest `repoState` per project,
 * the open file diffs, and the write flow of T-0010's office actions: ask ->
 * confirmation -> one `repoAction` -> busy until its `repoActionResult` -> toast.
 * Nothing is sent before the confirmation, nothing is queued for a later
 * reconnect, and a card that is busy takes no second action.
 *
 * Toasts go through the one toast the app has (officeStore's); the caller hands
 * the sink in so this module does not import officeStore.
 */
import { useSyncExternalStore } from 'react';

import type {
  RepoAction,
  RepoActionResult,
  RepoDiff,
  RepoDiffRequest,
  RepoState,
  RepoWorktreeDetail,
  RepoWorktreeRequest,
} from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import { stepUpFailedText } from '../auth/authApi.js';
import { requestStepUp } from '../auth/stepUp.js';
import { serverLine, serverText } from '../serverText.js';
import type { RepoConfirm } from './repoText.js';
import { confirmAction, resultToast } from './repoText.js';

export type ToastSink = (name: string, text: string, tone: 'ok' | 'info' | 'error') => void;

export interface DiffView {
  text: string;
  /** More follows (the "더 보기" link). */
  nextOffset?: number;
  /** The diff goes on past what the daemon pages through. */
  limited?: boolean;
  loading: boolean;
  error?: string;
}

/** W4: what one task worktree changed (key `project\0task`). */
export interface DetailView {
  files: NonNullable<RepoWorktreeDetail['files']>;
  commits: NonNullable<RepoWorktreeDetail['commits']>;
  filesTruncated: boolean;
  guard?: string;
  loading: boolean;
  error?: string;
}

export interface RepoSnapshot {
  states: Record<string, RepoState>;
  diffs: Record<string, DiffView>;
  details: Record<string, DetailView>;
  confirm: RepoConfirm | null;
  /** project -> requestId of its running write. */
  busy: Record<string, string>;
}

const empty: RepoSnapshot = { states: {}, diffs: {}, details: {}, confirm: null, busy: {} };
let snapshot = empty;
const listeners = new Set<() => void>();
/** Diff requests in flight: which view their answer belongs to, and whether it adds to it. */
const pending = new Map<string, { key: string; append: boolean }>();
/** W4: detail requests in flight (requestId -> detail key). */
const pendingDetails = new Map<string, string>();
/** W3: what each running write sent, so a `stepup` answer can send it once more after the proof. */
const sentWrites = new Map<string, { msg: RepoAction; send: (msg: RepoAction) => void; retried: boolean }>();
let requestSeq = 0;

export const repoSubscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const repoGetSnapshot = () => snapshot;
export const useRepoStore = () => useSyncExternalStore(repoSubscribe, repoGetSnapshot);

function set(next: Partial<RepoSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
}

/** `task`: a file of that task worktree's changes (W4), not of the project's own status. */
export const diffKey = (project: string, path: string, staged: boolean, task?: string): string =>
  `${project}\0${task !== undefined ? `task:${task}` : staged ? 'staged' : 'worktree'}\0${path}`;
export const detailKey = (project: string, task: string): string => `${project}\0${task}`;

const newRequestId = () => `${Date.now().toString(36)}-${++requestSeq}`;

export function repoHandleMessage(
  msg: RepoState | RepoDiff | RepoActionResult | RepoWorktreeDetail,
  toast: ToastSink,
): void {
  switch (msg.type) {
    case 'repoState': {
      // A diff of a file that is no longer in the list has nothing left to show.
      const paths = new Set((msg.files ?? []).map((f) => f.path));
      const diffs = Object.fromEntries(
        Object.entries(snapshot.diffs).filter(([key]) => {
          const [project, side, path] = key.split('\0');
          return project !== msg.project || side.startsWith('task:') || paths.has(path);
        }),
      );
      set({ states: { ...snapshot.states, [msg.project]: msg }, diffs });
      return;
    }
    case 'repoWorktreeDetail': {
      const key = detailKey(msg.project, msg.task);
      if (pendingDetails.get(msg.requestId) !== key) return;
      pendingDetails.delete(msg.requestId);
      const view: DetailView = msg.ok
        ? { files: msg.files ?? [], commits: msg.commits ?? [], filesTruncated: !!msg.filesTruncated, ...(msg.guard && { guard: serverLine(msg.guard) }), loading: false }
        : { files: [], commits: [], filesTruncated: false, loading: false, error: serverText(msg, t('repo.loadFailed')) };
      set({ details: { ...snapshot.details, [key]: view } });
      return;
    }
    case 'repoDiff': {
      const request = pending.get(msg.requestId);
      if (!request) return; // not ours, or closed meanwhile
      pending.delete(msg.requestId);
      const before = snapshot.diffs[request.key];
      if (!before) return;
      const view: DiffView = msg.ok
        ? {
            text: request.append ? before.text + (msg.text ?? '') : serverLine(msg.text ?? ''),
            ...(msg.nextOffset !== undefined ? { nextOffset: msg.nextOffset } : {}),
            ...(msg.limited ? { limited: true } : {}),
            loading: false,
          }
        : { ...before, loading: false, error: serverText(msg, t('repo.loadFailed')) };
      set({ diffs: { ...snapshot.diffs, [request.key]: view } });
      return;
    }
    case 'repoActionResult': {
      const project = Object.keys(snapshot.busy).find((p) => snapshot.busy[p] === msg.requestId);
      if (project === undefined) return; // not ours, or already given up on
      const sent = sentWrites.get(msg.requestId);
      sentWrites.delete(msg.requestId);
      // S1 (W3: a protected branch's merge from a remote device): prove this device, then once more.
      if (msg.error === 'stepup' && sent && !sent.retried) {
        void requestStepUp().then(
          (ok) => {
            if (!ok) return stepUpLost(project, toast);
            const requestId = newRequestId();
            sentWrites.set(requestId, { ...sent, msg: { ...sent.msg, requestId }, retried: true });
            set({ busy: { ...snapshot.busy, [project]: requestId } });
            sent.send({ ...sent.msg, requestId });
          },
          () => stepUpLost(project, toast),
        );
        return;
      }
      if (msg.error === 'stepup') return stepUpLost(project, toast);
      const busy = { ...snapshot.busy };
      delete busy[project];
      set({ busy });
      const { text, tone } = resultToast(msg);
      toast(project, text, tone);
    }
  }
}

function stepUpLost(project: string, toast: ToastSink): void {
  const busy = { ...snapshot.busy };
  delete busy[project];
  set({ busy });
  toast(project, stepUpFailedText(), 'error');
}

/** Open a file's diff (or, with `more`, load its next page). */
export function repoRequestDiff(
  project: string,
  path: string,
  staged: boolean,
  send: (msg: RepoDiffRequest) => void,
  more = false,
  task?: string,
): void {
  const key = diffKey(project, path, staged, task);
  const before = snapshot.diffs[key];
  if (before?.loading) return;
  const offset = more ? before?.nextOffset : undefined;
  if (more && offset === undefined) return;
  const requestId = newRequestId();
  pending.set(requestId, { key, append: more });
  // Loading the next page keeps the page(s) shown, and the link that is being used.
  set({
    diffs: {
      ...snapshot.diffs,
      [key]: more && before ? { ...before, loading: true } : { text: '', loading: true },
    },
  });
  send({
    type: 'repoDiffRequest',
    requestId,
    project,
    ...(task !== undefined ? { task } : {}),
    path,
    staged,
    ...(offset !== undefined ? { offset } : {}),
  });
}

/** W4: ask what task worktree `task` changed (again when it changed; the old answer stays shown meanwhile). */
export function repoRequestDetail(project: string, task: string, send: (msg: RepoWorktreeRequest) => void): void {
  const key = detailKey(project, task);
  const before = snapshot.details[key];
  if (before?.loading) return;
  const requestId = newRequestId();
  pendingDetails.set(requestId, key);
  set({ details: { ...snapshot.details, [key]: { ...(before ?? { files: [], commits: [], filesTruncated: false }), loading: true } } });
  send({ type: 'repoWorktreeRequest', requestId, project, task });
}

export function repoCloseDetail(project: string, task: string): void {
  const key = detailKey(project, task);
  if (!(key in snapshot.details)) return;
  const details = { ...snapshot.details };
  delete details[key];
  for (const [id, k] of pendingDetails) if (k === key) pendingDetails.delete(id);
  set({ details });
}

export function repoCloseDiff(project: string, path: string, staged: boolean, task?: string): void {
  const key = diffKey(project, path, staged, task);
  if (!(key in snapshot.diffs)) return;
  const diffs = { ...snapshot.diffs };
  delete diffs[key];
  for (const [id, request] of pending) if (request.key === key) pending.delete(id);
  set({ diffs });
}

/** A button: ask before anything is sent. Ignored while that project is busy. */
export function repoAsk(confirm: RepoConfirm): void {
  if (snapshot.busy[confirm.project] !== undefined) return;
  set({ confirm });
}

/** 취소, Escape, the backdrop: nothing is sent. */
export function repoCancel(): void {
  if (snapshot.confirm) set({ confirm: null });
}

/**
 * The confirmation's button: send one repoAction and mark the project busy
 * until its result. While disconnected nothing is sent (the same write must
 * not reach git twice) and the user is told.
 */
export function repoConfirmNow(
  send: (msg: RepoAction) => void,
  connected: boolean,
  toast: ToastSink,
): void {
  const confirm = snapshot.confirm;
  if (!confirm) return;
  if (!connected) {
    set({ confirm: null });
    toast(confirm.project, t('messenger.error.disconnectedSend'), 'error');
    return;
  }
  const requestId = newRequestId();
  set({ confirm: null, busy: { ...snapshot.busy, [confirm.project]: requestId } });
  const msg: RepoAction = { type: 'repoAction', requestId, ...confirmAction(confirm) };
  sentWrites.set(requestId, { msg, send, retried: false });
  send(msg);
}

/** The socket dropped: results of running writes can no longer arrive here. */
export function repoConnectionLost(toast: ToastSink): void {
  const projects = Object.keys(snapshot.busy);
  if (!projects.length) return;
  set({ busy: {} });
  toast(
    projects.join(', '),
    t('repo.resultLost'),
    'error',
  );
}

/** Test helper: back to the empty snapshot. */
export function repoResetForTests(): void {
  pending.clear();
  pendingDetails.clear();
  sentWrites.clear();
  snapshot = empty;
  listeners.forEach((listener) => listener());
}
