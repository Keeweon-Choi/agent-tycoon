/**
 * macOS GPU load without root: `ioreg -r -d 1 -c IOAccelerator` lists each GPU's
 * accelerator with a `PerformanceStatistics` dictionary, which has
 * `"Device Utilization %"` on Apple Silicon (AGXAccelerator) and on recent Intel
 * and AMD drivers (older Intel ones say `"GPU Activity(%)"`). Temperatures and
 * power are not there: they need powermetrics (root) or the SMC (native code).
 * Run only while someone views, killed after IOREG_TIMEOUT_MS.
 */
import { execFile } from 'child_process';

import type { Readings } from './hwSource.js';

export const IOREG_BIN = '/usr/sbin/ioreg';
export const IOREG_ARGS = ['-r', '-d', '1', '-c', 'IOAccelerator'];
const IOREG_TIMEOUT_MS = 1_500;
const IOREG_MAX_BYTES = 1024 * 1024;

/** The busiest accelerator's utilisation (a Mac with two GPUs shows the one at work), or null. */
export function parseIoreg(out: string): Readings | null {
  const loads = [...out.matchAll(/"(?:Device Utilization %|GPU Activity\(%\))"\s*=\s*(\d+)/g)].map(
    (m) => Number(m[1]),
  );
  if (!loads.length) return null;
  return { gpuUtil: Math.min(100, Math.max(...loads)) / 100 };
}

/** One ioreg run; null when it fails, times out or says nothing. Never throws. */
export function readIoreg(bin = IOREG_BIN, timeoutMs = IOREG_TIMEOUT_MS): Promise<Readings | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        bin,
        IOREG_ARGS,
        { timeout: timeoutMs, maxBuffer: IOREG_MAX_BYTES, encoding: 'utf-8' },
        (err, stdout) => resolve(err ? null : parseIoreg(stdout)),
      );
    } catch {
      resolve(null);
    }
  });
}
