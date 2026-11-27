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
        // asked.set: a socket that dropped while the step-up was proven has cleared the ask.
        (ok) => (ok && wire?.connected() ? (asked.set(msg.requestId, req), wire.send(req.msg)) : (asked.delete(msg.requestId), wire?.toast(stepUpFailedText(), 'error'))),
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
        // Put the start back: a socket that dropped while the step-up was proven has cleared it.
        starts.set(msg.requestId, req);
        set({ starting: { ...snapshot.starting, [startKey(msg.project, msg.task, msg.scriptId)]: true } });
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

/** Script lists that were loading when the socket dropped: asked again on the next connected state. */
const reask = new Map<string, { project: string; task: string }>();

/** The socket dropped: answers to what was asked go to the old socket, so nothing waits for them (the
 *  buttons work again, the loading script lists are asked again by runConnected); what is open stays. */
export function runConnectionLost(): void {
  for (const { key, msg } of asked.values()) if (snapshot.scripts[key] === 'loading') reask.set(key, msg);
  asked.clear();
  starts.clear();
  const scripts = Object.fromEntries(Object.entries(snapshot.scripts).filter(([, v]) => v !== 'loading'));
  set({ starting: {}, scripts });
}

export function runConnected(): void {
  const again = [...reask.values()];
  reask.clear();
  for (const { project, task } of again) requestScripts(project, task);
}

export function runResetForTests(): void {
  reask.clear();
  snapshot = { scripts: {}, starting: {}, open: {} };
  asked.clear();
  starts.clear();
}
