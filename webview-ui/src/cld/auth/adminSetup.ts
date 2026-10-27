import { ADMIN_SETUP_COMMAND } from '../../constants.js';

export type AdminSetup =
  | { kind: 'relay'; directPort: number; externalPort: number }
  | { kind: 'firewall'; firewall: 'windows' | 'wsl-mirrored'; ports: number[] };

export interface AdminSetupResult {
  ok: boolean;
  exitCode: number;
  canceled?: boolean;
}

type TauriBridge = {
  invoke: (command: string, args: { request: AdminSetup }) => Promise<AdminSetupResult>;
};

const bridge = (): TauriBridge | null => {
  if (typeof window === 'undefined') return null;
  const candidate = (window as Window & { __TAURI_INTERNALS__?: Partial<TauriBridge> }).__TAURI_INTERNALS__;
  return typeof candidate?.invoke === 'function' ? candidate as TauriBridge : null;
};

/** Only the installed desktop app exposes this bridge; a browser keeps the copy-only flow. */
export const canRunAdminSetup = (): boolean => bridge() !== null;

/** Sends typed data only. The Rust command owns validation and all PowerShell text. */
export const runAdminSetup = (request: AdminSetup): Promise<AdminSetupResult> => {
  const current = bridge();
  if (!current) return Promise.reject(new Error('Desktop administrator setup is unavailable.'));
  return current.invoke(ADMIN_SETUP_COMMAND, { request });
};
