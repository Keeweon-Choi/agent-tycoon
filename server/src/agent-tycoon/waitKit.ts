/**
 * Test helper: `vi.waitFor` with the patience a loaded machine needs.
 * vitest's own default is one second, which a busy CPU (the deploy gate runs
 * the suite on two nice'd cores) overruns on the first real process or socket.
 * It returns the moment the condition holds, so a generous timeout costs
 * nothing on an idle machine; it only delays the report of a real failure.
 * Never used at runtime.
 */
import { vi } from 'vitest';

export const WAIT_FOR_MS = 30_000;

export function waitFor<T>(
  check: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
): Promise<T> {
  return vi.waitFor(check, { timeout: WAIT_FOR_MS, interval: 25, ...options });
}
