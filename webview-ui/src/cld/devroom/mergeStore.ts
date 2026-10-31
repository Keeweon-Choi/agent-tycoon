/**
 * P4 개발실 병합 tab: the daemon's answers to the pre-check (`repoMergeCheck`), the conflict list
 * (`repoConflicts`), the cleanup list (`repoCleanupList`) and the owner's `devroomSettings`, plus
 * `act`, one `repoAction` awaited so a few writes can run in order (resolve file by file, then
 * continue; remove folder by folder). Only the newest answer to a question counts.
 */
import { useSyncExternalStore } from 'react';

import type {
  ClientMessage,
  DevroomSettings,
  RepoAction,
  RepoActionResult,
  RepoCleanupListResult,
  RepoConflictsResult,
  RepoMergeCheckResult,
} from '../../../../core/src/messages.js';
import { MERGE_ACT_TIMEOUT_MS } from '../../constants.js';
import { t } from '../../i18n/index.js';

export interface MergeSnapshot {
  /** `project\0task` -> the pre-check. */
  checks: Record<string, RepoMergeCheckResult>;
  conflicts: Record<string, RepoConflictsResult>;
  /** project -> the 작업 폴더 정리 list (loading until the first answer). */
  cleanup: Record<string, RepoCleanupListResult | 'loading'>;
  /** The owner's auto-cleanup setting; the daemon's default (on) until it says. */
  autoCleanup: boolean;
}

/** The socket, bound by MergeTab (this store is imported by officeStore, which the Node tests load: no window here). */
export interface MergeWire {
  send: (msg: ClientMessage) => void;
  connected: () => boolean;
}
let wire: MergeWire = { send: () => undefined, connected: () => false };
export const bindMergeWire = (next: MergeWire): void => {
  wire = next;
};

let snapshot: MergeSnapshot = { checks: {}, conflicts: {}, cleanup: {}, autoCleanup: true };
const listeners = new Set<() => void>();
const set = (next: Partial<MergeSnapshot>) => {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
export const useMergeStore = () => useSyncExternalStore(subscribe, () => snapshot);

export const taskKey = (project: string, task: string): string => `${project}\0${task}`;

let seq = 0;
const newId = () => `mg-${Date.now().toString(36)}-${++seq}`;
/** The newest question per answer slot: an older answer is dropped. */
const latest = new Map<string, string>();
const answered = new Map<string, () => void>();
const waiting = new Map<string, (r: RepoActionResult) => void>();

export function requestCheck(project: string, task: string): void {
  const requestId = newId();
  latest.set(`check\0${taskKey(project, task)}`, requestId);
  wire.send({ type: 'repoMergeCheck', requestId, project, task });
}

/** Resolves when this question is answered (or at once when it was already replaced by a newer one). */
export function requestConflicts(project: string, task: string): Promise<void> {
  const requestId = newId();
  latest.set(`conflicts\0${taskKey(project, task)}`, requestId);
  return new Promise((resolve) => {
    answered.set(requestId, resolve);
    wire.send({ type: 'repoConflicts', requestId, project, task });
  });
}

export function requestCleanup(project: string): void {
  const requestId = newId();
  latest.set(`cleanup\0${project}`, requestId);
  set({ cleanup: { ...snapshot.cleanup, [project]: 'loading' } });
  wire.send({ type: 'repoCleanupList', requestId, project });
}

/** The owner's 병합 후 자동 정리: shown at once, the daemon's `devroomSettings` has the last word. */
export function setAutoCleanup(on: boolean): void {
  set({ autoCleanup: on });
  wire.send({ type: 'devroomSettingsSet', autoCleanupAfterMerge: on });
}

export function mergeHandleMessage(
  msg: RepoMergeCheckResult | RepoConflictsResult | RepoCleanupListResult | DevroomSettings,
): void {
  switch (msg.type) {
    case 'devroomSettings':
      set({ autoCleanup: msg.autoCleanupAfterMerge });
      return;
    case 'repoMergeCheckResult': {
      const key = taskKey(msg.project, msg.task);
      if (latest.get(`check\0${key}`) === msg.requestId) set({ checks: { ...snapshot.checks, [key]: msg } });
      return;
    }
    case 'repoConflictsResult': {
      const key = taskKey(msg.project, msg.task);
      if (latest.get(`conflicts\0${key}`) === msg.requestId) set({ conflicts: { ...snapshot.conflicts, [key]: msg } });
      answered.get(msg.requestId)?.();
      answered.delete(msg.requestId);
      return;
    }
    case 'repoCleanupListResult':
      if (latest.get(`cleanup\0${msg.project}`) === msg.requestId) set({ cleanup: { ...snapshot.cleanup, [msg.project]: msg } });
      return;
  }
}

/** Our own writes' answers (the others belong to repoStore and devroomStore). */
export function mergeHandleResult(msg: RepoActionResult): void {
  const done = waiting.get(msg.requestId);
  if (!done) return;
  waiting.delete(msg.requestId);
  done(msg);
}

/** One `repoAction`, answered or (no answer in time, or not connected) a failed result. */
export function act(action: Omit<RepoAction, 'type' | 'requestId'>): Promise<RepoActionResult> {
  const requestId = newId();
  const lost = (): RepoActionResult => ({
    type: 'repoActionResult',
    requestId,
    action: action.action,
    project: action.project,
    ok: false,
    error: t('merge.lost'),
  });
  if (!wire.connected()) return Promise.resolve(lost());
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(requestId);
      resolve(lost());
    }, MERGE_ACT_TIMEOUT_MS);
    waiting.set(requestId, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    wire.send({ type: 'repoAction', requestId, ...action });
  });
}
