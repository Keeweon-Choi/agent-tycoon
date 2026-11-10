/** Decision made before a shell is created or joined. No side effects. */
export interface ShellGateInput {
  enabled: boolean;
  privileged: boolean;
  registered: boolean;
  proofAt?: number;
  now: number;
  originAllowed: boolean;
  hostAllowed: boolean;
  rateAllowed: boolean;
  openCount: number;
}

export type ShellRefusal =
  'disabled' | 'session' | 'device' | 'proof' | 'origin' | 'host' | 'rate' | 'cap';
export const SHELL_PROOF_MS = 120_000;
/** The answer (403 { error }) when a dangerous action has no fresh step-up (S1). */
export const STEPUP_REQUIRED = 'stepup';
export const SHELL_MAX_PER_DEVICE = 3;

/** A step-up proof still inside its window (shared with every dangerous action, S1). */
export function proofFresh(proofAt: number | undefined, now: number): boolean {
  return proofAt !== undefined && proofAt <= now && now - proofAt <= SHELL_PROOF_MS;
}

export function shellRefusal(input: ShellGateInput): ShellRefusal | null {
  if (!input.enabled) return 'disabled';
  // First: a client over its limit learns nothing else about its request.
  if (!input.rateAllowed) return 'rate';
  if (!input.originAllowed) return 'origin';
  if (!input.hostAllowed) return 'host';
  if (!input.privileged) return 'session';
  if (!input.registered) return 'device';
  if (!proofFresh(input.proofAt, input.now)) return 'proof';
  if (input.openCount >= SHELL_MAX_PER_DEVICE) return 'cap';
  return null;
}
