/**
 * O4: the permission mode NEW agents start with (F-11), as the office sees it: the stored answer,
 * `''` until the owner has been asked. The first-run Intro step (IntroBubble) and the Settings
 * row both read and change it here. It is a default for agents made afterwards; each agent's own
 * settings change an existing one.
 */
import { useSyncExternalStore } from 'react';

import type { ServerMessage } from '../../../core/src/messages.js';
import { stepUpFailedText } from './auth/authApi.js';
import { requestStepUp } from './auth/stepUp.js';

export type NewAgentMode = 'ask' | 'bypass';

export interface BypassSnapshot {
  /** The stored default for new agents; null until the server has said (never ask before that), '' unanswered. */
  mode: NewAgentMode | '' | null;
  /** The last refused save (read_only, stepup, write_failed), for the control that sent it. */
  error: string | null;
}

let snapshot: BypassSnapshot = { mode: null, error: null };
const listeners = new Set<() => void>();
const set = (next: BypassSnapshot) => {
  snapshot = next;
  listeners.forEach((l) => l());
};

/** The one fn the Intro asks "should I be up?" of: loaded and unanswered. */
export const bypassUnanswered = (s: BypassSnapshot): boolean => s.mode === '';

/** The visible first choice is Bypass, but an unanswered server value remains unanswered until clicked. */
export const preferredBypassMode = (mode: BypassSnapshot['mode']): NewAgentMode =>
  mode === 'ask' ? 'ask' : 'bypass';

/** Mid-save step-up retry: the mode the refused request asked for. */
let lastAsked: NewAgentMode | null = null;

export function bypassHandleMessage(msg: ServerMessage): void {
  if (msg.type !== 'newAgentPermission') return;
  if (msg.error === 'stepup' && lastAsked) {
    const again = lastAsked;
    lastAsked = null; // one retry
    void requestStepUp().then(
      (ok) => (ok ? chooseBypass(again, false) : set({ ...snapshot, mode: msg.mode, error: stepUpFailedText() })),
      () => set({ ...snapshot, mode: msg.mode, error: stepUpFailedText() }),
    );
    return;
  }
  lastAsked = null;
  set({ mode: msg.mode, error: msg.error ?? null });
}

export const useBypass = (): BypassSnapshot =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => snapshot,
  );

/**
 * Save the owner's choice. A remote device choosing bypass is answered `stepup` by the daemon: the
 * proof is asked and the request sent once more. The confirmation is the server's `newAgentPermission`
 * (a refusal carries `error`), never this call.
 */
export function chooseBypass(mode: NewAgentMode, retry = true): void {
  lastAsked = retry ? mode : null;
  if (retry && snapshot.error) set({ ...snapshot, error: null });
  // Loaded on use: the transport touches `window`, and this store is imported by Node-run tests.
  void import('../transport/index.js').then(({ transport }) =>
    transport.send({ type: 'newAgentPermissionRequest', mode }),
  );
}

/** Nothing to choose here: this connection is read-only, or the daemon runs without --allow-actions (it would refuse). */
export const bypassReadOnly = (cld: {
  officeReadOnly: boolean;
  officeSnapshot: { readOnly: boolean } | null;
}): boolean => cld.officeReadOnly || cld.officeSnapshot?.readOnly !== false;
