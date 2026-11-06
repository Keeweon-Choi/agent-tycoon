/**
 * DV2 개발실 실행 row: the daemon's answers about each worktree's scripts and picks
 * (runScriptsResult), the runs being started (jobStart, with one step-up retry for a remote
 * session, as the engine's actions do) and which run is open where (the right pane, the bottom
 * drawer) for this visit. Logs and stops are jobStore.ts's (the existing jobAction).
 */
import { useSyncExternalStore } from 'react';

import type { ClientMessage, JobStartResult, RunPick, RunScriptsResult } from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import { stepUpFailedText } from '../auth/authApi.js';
import { requestStepUp } from '../auth/stepUp.js';
import { serverText } from '../serverText.js';
import { pickKey } from './devroomStore.js';

export interface RunSnapshot {
  /** pickKey -> the last answer about that worktree ('loading' while asked). */
  scripts: Readonly<Record<string, RunScriptsResult | 'loading'>>;
  /** `<pickKey>\0<script>` being started now. */
  starting: Readonly<Record<string, true>>;
  /** pickKey -> the run open in the right pane and in the bottom drawer (a script key). */
  open: Readonly<Record<string, { side?: string; drawer?: string }>>;
}

let snapshot: RunSnapshot = { scripts: {}, starting: {}, open: {} };
const listeners = new Set<() => void>();
const set = (next: Partial<RunSnapshot>) => {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
export const runGetSnapshot = () => snapshot;
export const useRunStore = () => useSyncExternalStore(subscribe, runGetSnapshot);

let wire: { send: (m: ClientMessage) => void; connected: () => boolean; toast: (text: string, tone: 'ok' | 'error') => void } | null = null;
export const bindRunWire = (w: typeof wire) => {
  wire = w;
};

let seq = 0;
const asked = new Map<string, { key: string; msg: Extract<ClientMessage, { type: 'runScripts' }>; retried: boolean }>();
const starts = new Map<string, { msg: Extract<ClientMessage, { type: 'jobStart' }>; retried: boolean }>();

export const startKey = (project: string, task: string, script: string) => `${pickKey(project, task)}\0${script}`;

/** Read worktree `task`'s scripts and the picks ('' = the project's own folder); with `picks`, save them first. */
export function requestScripts(project: string, task: string, picks?: RunPick[]): void {
  if (!wire?.connected()) return;
  const key = pickKey(project, task);
  const requestId = `run-${++seq}`;
  const msg = {
    type: 'runScripts' as const,
    requestId,
    project,
    task,
    ...(picks && { picks: picks.map(({ script, role }) => ({ script, role })) }),
  };
  asked.set(requestId, { key, msg, retried: false });
  if (snapshot.scripts[key] === undefined) set({ scripts: { ...snapshot.scripts, [key]: 'loading' } });
  wire.send(msg);
}

/** Press a run button: the daemon picks the command; the run opens where its role shows. */
export function startRun(project: string, task: string, script: string, place: 'side' | 'drawer'): void {
  const sk = startKey(project, task, script);
  openRun(project, task, script, place);
  if (!wire?.connected() || snapshot.starting[sk]) return;
  const requestId = `run-${++seq}`;
  const msg = { type: 'jobStart' as const, requestId, project, task, scriptId: script };
  starts.set(requestId, { msg, retried: false });
  set({ starting: { ...snapshot.starting, [sk]: true } });
  wire.send(msg);
}

export function openRun(project: string, task: string, script: string, place: 'side' | 'drawer'): void {
  const key = pickKey(project, task);
  set({ open: { ...snapshot.open, [key]: { ...snapshot.open[key], [place]: script } } });
}

export function closeRun(project: string, task: string, place: 'side' | 'drawer'): void {
  const key = pickKey(project, task);
  const next = { ...snapshot.open[key] };
  delete next[place];
  set({ open: { ...snapshot.open, [key]: next } });
}

export function runHandleMessage(msg: RunScriptsResult | JobStartResult): void {
  if (msg.type === 'runScriptsResult') {
    const req = asked.get(msg.requestId);
    if (!req) return;
    // S1: saving picks from a remote session wants a step-up too (a re-pick lets a changed script run).
    if (msg.error === 'stepup') {
      const again = !req.retried;
      req.retried = true;
      void (again ? requestStepUp() : Promise.resolve(false)).then(
        (ok) => (ok && wire?.connected() ? wire.send(req.msg) : (asked.delete(msg.requestId), wire?.toast(stepUpFailedText(), 'error'))),
        () => (asked.delete(msg.requestId), wire?.toast(stepUpFailedText(), 'error')),
      );
      return;
    }
    asked.delete(msg.requestId);
    set({ scripts: { ...snapshot.scripts, [req.key]: msg } });
    return;
  }
  const req = starts.get(msg.requestId);
  if (!req) return;
  // S1: a remote session's run wants a step-up; prove, then send the same start once more.
  if (msg.error === 'stepup' && !req.retried) {
    void requestStepUp().then(
      (ok) => {
        if (!ok || !wire?.connected()) return finish(msg, stepUpFailedText());
        req.retried = true;
        wire.send(req.msg);
      },
      () => finish(msg, stepUpFailedText()),
    );
    return;
  }
  finish(msg, msg.ok ? null : serverText(msg, t('devroom.run.startFailed')));
}

function finish(msg: JobStartResult, error: string | null): void {
  starts.delete(msg.requestId);
  const starting = { ...snapshot.starting };
  delete starting[startKey(msg.project, msg.task, msg.scriptId)];
  set({ starting });
  if (error) wire?.toast(error, 'error');
}

export function runResetForTests(): void {
  snapshot = { scripts: {}, starting: {}, open: {} };
  asked.clear();
  starts.clear();
}
