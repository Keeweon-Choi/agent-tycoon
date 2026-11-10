/**
 * hw-every-os: the H/W screen's missing-sensor fixes as the office sees them. `askSensorPlan` asks
 * the daemon for the installer's consent text; `installSensorTool` runs the install after the owner
 * pressed it (a remote device is asked for the step-up proof, then the request goes once more);
 * `setNvidiaSmi` flips the nvidia-smi opt-in (the next hwSample shows it).
 */
import { useSyncExternalStore } from 'react';

import type { HwSensorToolState } from '../../../core/src/messages.js';
import { stepUpFailedText } from './auth/authApi.js';
import { requestStepUp } from './auth/stepUp.js';

export interface SensorToolSnapshot {
  phase: 'idle' | 'asking' | HwSensorToolState['phase'];
  lines: string[];
  canInstall: boolean;
  ok: boolean;
  /** A refusal's code, or the step-up's own failure text. */
  error: string | null;
}

const IDLE: SensorToolSnapshot = {
  phase: 'idle',
  lines: [],
  canInstall: false,
  ok: false,
  error: null,
};
let snapshot = IDLE;
const listeners = new Set<() => void>();
const set = (next: SensorToolSnapshot) => {
  snapshot = next;
  listeners.forEach((l) => l());
};

const send = (msg: Record<string, unknown>) =>
  // Loaded on use: the transport touches `window`, and this store is imported by Node-run tests.
  void import('../transport/index.js').then(({ transport }) => transport.send(msg as never));

/** The request a remote device's step-up retries, once: the install or turning nvidia-smi on. */
let retryAfterStepUp: (() => void) | null = null;

export function sensorToolHandleMessage(msg: HwSensorToolState): void {
  if (msg.phase === 'refused' && msg.error === 'stepup' && retryAfterStepUp) {
    const again = retryAfterStepUp;
    retryAfterStepUp = null;
    const failed = () => set({ ...snapshot, phase: 'refused', error: stepUpFailedText() });
    void requestStepUp().then((ok) => (ok ? again() : failed()), failed);
    return;
  }
  if (msg.phase !== 'running') retryAfterStepUp = null;
  set({
    phase: msg.phase,
    lines: msg.lines ?? [],
    canInstall: msg.canInstall === true,
    ok: msg.ok === true,
    error: msg.error ?? null,
  });
}

export function askSensorPlan(): void {
  set({ ...IDLE, phase: 'asking' });
  send({ type: 'hwSensorTool', action: 'plan' });
}

/** The owner pressed install under the consent text. */
export function installSensorTool(retry = true): void {
  retryAfterStepUp = retry ? () => installSensorTool(false) : null;
  set({ ...snapshot, phase: 'running', error: null });
  send({ type: 'hwSensorTool', action: 'install', consent: true });
}

export function setNvidiaSmi(on: boolean, retry = true): void {
  retryAfterStepUp = on && retry ? () => setNvidiaSmi(true, false) : null;
  send({ type: 'hwSensorTool', action: on ? 'nvidiaOn' : 'nvidiaOff' });
}

export const closeSensorTool = (): void => set(IDLE);

export const useSensorTool = (): SensorToolSnapshot =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => snapshot,
  );
