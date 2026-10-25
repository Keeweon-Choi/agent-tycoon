/**
 * Engine state and the action flow (T-0018), the same way as T-0010's office
 * actions: ask, confirm, one request per project until its result, a toast,
 * nothing queued while disconnected. add/edit come from a form (the form is
 * the confirmation); a folder that does not exist asks before it is made.
 */
import { useSyncExternalStore } from 'react';

import type {
  EngineAction,
  EngineActionKind,
  EngineProject,
  EngineState,
  ServerMessage,
} from '../../../core/src/messages.js';
import { t } from '../i18n/index.js';
import { stepUpFailedText } from './auth/authApi.js';
import { requestStepUp } from './auth/stepUp.js';
import { engineToast } from './engine.js';

type Fields = Partial<Omit<EngineAction, 'type' | 'requestId' | 'action' | 'name'>>;

export interface EngineConfirm {
  action: EngineActionKind;
  name: string;
  fields?: Fields;
  /** The folder-creation question instead of the action's own. */
  mkdir?: string;
}

export interface EngineSnapshot {
  state: EngineState | null;
  confirm: EngineConfirm | null;
  /** Project name -> its running request. */
  busy: Record<
    string,
    { requestId: string; action: EngineActionKind; fields?: Fields; retried?: boolean }
  >;
  toast: { id: number; name: string; text: string; tone: 'ok' | 'info' | 'error' } | null;
  /** The add form (name null) or a project's 설정 form. */
  form: { name: string | null; newOffice?: boolean } | null;
}

const empty: EngineSnapshot = { state: null, confirm: null, busy: {}, toast: null, form: null };
let snapshot = empty;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const set = (next: Partial<EngineSnapshot>) => {
  snapshot = { ...snapshot, ...next };
  emit();
};

export const engineSubscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const engineGetSnapshot = () => snapshot;
export const useEngineStore = () => useSyncExternalStore(engineSubscribe, engineGetSnapshot);
export const useEngineProject = (name: string): EngineProject | undefined =>
  useEngineStore().state?.projects.find((p) => p.name === name);

let toastSeq = 0;
let requestSeq = 0;
const toast = (name: string, t: { text: string; tone: 'ok' | 'info' | 'error' }) => ({
  id: ++toastSeq,
  name,
  ...t,
});

export function engineHandleMessage(msg: ServerMessage): void {
  if (msg.type === 'engineState') {
    set({ state: msg });
    return;
  }
  if (msg.type !== 'engineActionResult') return;
  const run = snapshot.busy[msg.name];
  if (!run || run.requestId !== msg.requestId) return; // not ours, or given up on
  // S1: a remote session's risky action wants a step-up; prove, then send the same action once more.
  if (msg.error === 'stepup' && !run.retried && lastOut) {
    const out = lastOut;
    void requestStepUp().then(
      (ok) => (ok ? resend(out, msg.name, run) : stepUpFailed(msg.name)),
      () => stepUpFailed(msg.name),
    );
    return;
  }
  const busy = { ...snapshot.busy };
  delete busy[msg.name];
  if (msg.folderMissing && run.fields?.folder && (msg.action === 'add' || msg.action === 'edit')) {
    // Ask before the folder is made, then send the same request with mkdir.
    set({
      busy,
      confirm: { action: msg.action, name: msg.name, fields: run.fields, mkdir: run.fields.folder },
    });
    return;
  }
  set({ busy, toast: toast(msg.name, engineToast(msg)) });
}

/** A card's button: ask before anything is sent. Ignored while that project is busy. */
export function engineAsk(action: EngineActionKind, name: string): void {
  if (snapshot.busy[name]) return;
  set({ confirm: { action, name } });
}

export function engineCancel(): void {
  if (snapshot.confirm) set({ confirm: null });
}

export const engineOpenForm = (name: string | null, options: { newOffice?: boolean } = {}) =>
  set({ form: { name, ...options } });
export const engineCloseForm = () => set({ form: null });

/** The socket the last request went out on, for the one step-up retry (S1). */
let lastOut: ((msg: EngineAction) => void) | null = null;

function resend(
  out: (msg: EngineAction) => void,
  name: string,
  run: NonNullable<EngineSnapshot['busy'][string]>,
): void {
  const requestId = `${Date.now().toString(36)}-e${++requestSeq}`;
  set({ busy: { ...snapshot.busy, [name]: { ...run, requestId, retried: true } } });
  out({ type: 'engineAction', requestId, action: run.action, name, ...run.fields });
}

function stepUpFailed(name: string): void {
  const busy = { ...snapshot.busy };
  delete busy[name];
  set({ busy, toast: toast(name, { text: stepUpFailedText(), tone: 'error' }) });
}

function send(
  out: (msg: EngineAction) => void,
  connected: boolean,
  action: EngineActionKind,
  name: string,
  fields: Fields = {},
): void {
  if (!connected) {
    set({
      confirm: null,
      toast: toast(name, { text: t('engine.disconnectedBeforeSend'), tone: 'error' }),
    });
    return;
  }
  const requestId = `${Date.now().toString(36)}-e${++requestSeq}`;
  lastOut = out;
  set({
    confirm: null,
    form: null,
    busy: { ...snapshot.busy, [name]: { requestId, action, fields } },
  });
  out({ type: 'engineAction', requestId, action, name, ...fields });
}

/** The confirmation's button (or the folder question's 만들기). */
export function engineConfirm(out: (msg: EngineAction) => void, connected: boolean): void {
  const c = snapshot.confirm;
  if (!c) return;
  send(out, connected, c.action, c.name, c.mkdir ? { ...c.fields, mkdir: true } : c.fields);
}

/** The form's 추가 / 저장 (D3b: or the 'Lead 로' dialog): the form itself was the confirmation. */
export function engineSubmit(
  out: (msg: EngineAction) => void,
  connected: boolean,
  action: 'add' | 'edit' | 'promote',
  name: string,
  fields: Fields,
): void {
  if (snapshot.busy[name]) return;
  if (action === 'edit' && Object.keys(fields).length === 0) {
    set({ form: null });
    return;
  }
  send(out, connected, action, name, fields);
}

/** The socket dropped: results of running actions can no longer arrive. */
export function engineConnectionLost(): void {
  const names = Object.keys(snapshot.busy);
  if (!names.length) return;
  set({
    busy: {},
    toast: toast(names.join(', '), {
      text: t('engine.disconnectedBeforeResult'),
      tone: 'error',
    }),
  });
}

export function engineDismissToast(id: number): void {
  if (snapshot.toast?.id === id) set({ toast: null });
}

export function engineResetForTests(): void {
  snapshot = empty;
  emit();
}
