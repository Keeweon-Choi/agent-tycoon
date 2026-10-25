/**
 * The job panel's engine jobs (T-0019): their logs and stops. Only jobs with
 * an `id` (the engine's) can be read or stopped here; starting one is the
 * `cld-gui job` CLI's alone.
 */
import { useSyncExternalStore } from 'react';

import type {
  ClientMessage,
  JobActionKind,
  JobActionResult,
  JobDigest,
} from '../../../core/src/messages.js';
import { t } from '../i18n/index.js';
import { serverText } from './serverText.js';

export interface JobSnapshot {
  /** id -> the log's last 64 KB, as the terminal last showed each line. */
  logs: Record<string, { text: string; truncated: boolean; digest?: JobDigest; path?: string }>;
  /** ids whose stop was sent and not answered yet. */
  stopping: Record<string, true>;
  /** id -> what went wrong last (Korean, from the daemon). */
  errors: Record<string, string>;
}

let snapshot: JobSnapshot = { logs: {}, stopping: {}, errors: {} };
const listeners = new Set<() => void>();
const pending = new Map<string, { action: JobActionKind; id: string }>();
let seq = 0;

const emit = () => listeners.forEach((l) => l());
export const jobSubscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const jobGetSnapshot = () => snapshot;
export const useJobStore = () => useSyncExternalStore(jobSubscribe, jobGetSnapshot);

export function jobRequest(
  send: (m: ClientMessage) => void,
  action: JobActionKind,
  id: string,
): void {
  if (action === 'stop') {
    if (snapshot.stopping[id]) return;
    snapshot = { ...snapshot, stopping: { ...snapshot.stopping, [id]: true } };
    emit();
  }
  const requestId = `job-${++seq}`;
  pending.set(requestId, { action, id });
  send({ type: 'jobAction', requestId, action, id });
}

/** A `jobActionResult`; `toast` reports a stop. */
export function jobHandleMessage(
  msg: JobActionResult,
  toast: (name: string, text: string, tone: 'ok' | 'error') => void,
): void {
  const req = pending.get(msg.requestId);
  if (!req) return;
  pending.delete(msg.requestId);
  const errors = { ...snapshot.errors };
  if (msg.ok) delete errors[req.id];
  else errors[req.id] = serverText(msg, t('jobStore.failed'));
  if (req.action === 'log') {
    const logs = { ...snapshot.logs };
    if (msg.ok)
      logs[req.id] = {
        text: msg.log ?? '',
        truncated: msg.truncated === true,
        ...(msg.digest && { digest: msg.digest }),
        ...(msg.logPath && { path: msg.logPath }),
      };
    snapshot = { ...snapshot, logs, errors };
  } else {
    const stopping = { ...snapshot.stopping };
    delete stopping[req.id];
    snapshot = { ...snapshot, stopping, errors };
    toast(
      req.id,
      msg.ok ? t('jobStore.stopped') : serverText(msg, t('jobStore.stopFailed')),
      msg.ok ? 'ok' : 'error',
    );
  }
  emit();
}

export function jobResetForTests(): void {
  snapshot = { logs: {}, stopping: {}, errors: {} };
  pending.clear();
}
