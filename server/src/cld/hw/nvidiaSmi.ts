/**
 * NVIDIA through nvidia-smi, only when the user turned it on (`--nvidia-smi`,
 * the installer's `nvidiaSmi` config). During a big training run a GPU query
 * can hang in uninterruptible sleep (D state, security T9/T16), so these rules
 * hold here (office-interface §7):
 * - an nvidia-smi of anyone's that has run for 2 s or more means the driver is
 *   stuck: no new one is started;
 * - ours gets 1.5 s; after that the sample goes on without the GPU, and the
 *   process is left alone (a D-state process cannot be killed, and kill-and-retry
 *   piles them up);
 * - never more than one of ours at a time.
 */
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { findOnPath } from '../providers/claudeProvider.js';
import type { Readings } from './hwSource.js';

/** WSL ships nvidia-smi here, outside the service's PATH. */
const WSL_NVIDIA_SMI = '/usr/lib/wsl/lib/nvidia-smi';

export const NVIDIA_QUERY =
  '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw';
export const NVIDIA_PROCESS_QUERY = '--query-compute-apps=pid,used_gpu_memory';
export const NVIDIA_TIMEOUT_MS = 1_500;
export const NVIDIA_STUCK_S = 2;
/** USER_HZ: the unit of /proc/<pid>/stat start times, 100 on every Linux ABI we run on. */
const CLK_TCK = 100;

export function findNvidiaSmi(envPath?: string): string | null {
  return (
    findOnPath(process.platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi', envPath) ??
    (fs.existsSync(WSL_NVIDIA_SMI) ? WSL_NVIDIA_SMI : null)
  );
}

/** `utilization, used MiB, total MiB, temp C, power W` (first GPU); `[N/A]` fields are left out. */
export function parseNvidiaCsv(out: string): Readings | null {
  const line = out.split('\n').find((l) => l.trim());
  const f = line?.split(',').map((s) => s.trim()) ?? [];
  if (f.length < 5) return null;
  const n = (s: string) => (s !== '' && Number.isFinite(Number(s)) ? Number(s) : null);
  const util = n(f[0]);
  const r: Record<string, number | null> = {
    gpuUtil: util === null ? null : util / 100,
    vramUsedMib: n(f[1]),
    vramTotalMib: n(f[2]),
    gpuTempC: n(f[3]),
    gpuPowerW: n(f[4]),
  };
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)) as Readings;
}

export function parseNvidiaProcesses(out: string): Array<{ pid: number; usedMib: number }> {
  return out
    .split('\n')
    .map((line) => line.split(',').map((s) => s.trim()))
    .filter(
      (f) =>
        f.length >= 2 &&
        Number.isInteger(Number(f[0])) &&
        Number(f[0]) > 0 &&
        Number.isFinite(Number(f[1])),
    )
    .map((f) => ({ pid: Number(f[0]), usedMib: Number(f[1]) }));
}

/** True when a process named nvidia-smi (anyone's) has run for `seconds` or more. By
 *  name, never by command line: a shell that merely mentions it is not a stuck query. */
export function nvidiaSmiStuck(seconds = NVIDIA_STUCK_S, proc = '/proc'): boolean {
  let uptime: number;
  let pids: string[];
  try {
    uptime = parseFloat(fs.readFileSync(path.join(proc, 'uptime'), 'utf-8'));
    pids = fs.readdirSync(proc).filter((d) => /^\d+$/.test(d));
  } catch {
    return false; // no /proc (Windows, macOS): only our own one-at-a-time rule applies
  }
  for (const pid of pids) {
    try {
      const stat = fs.readFileSync(path.join(proc, pid, 'stat'), 'utf-8');
      if (stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')) !== 'nvidia-smi') continue;
      const start = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]) / CLK_TCK;
      if (uptime - start >= seconds) return true;
    } catch {
      /* exited meanwhile */
    }
  }
  return false;
}

/**
 * The first GPU's total VRAM in MiB, once, for a GPU wrapper that has no sample to read (T-0094).
 * Through NvidiaSmi's guards: nothing when a query of anyone's already hangs, and never a wait past
 * its limit. Not spawnSync: that waits for the child's exit after the kill, which a D-state
 * nvidia-smi never delivers.
 */
export async function readTotalMib(
  bin: string | null,
  opts: { proc?: string; timeoutMs?: number } = {},
): Promise<number | null> {
  if (!bin) return null;
  const r = await new NvidiaSmi(bin, opts).read();
  return r && r !== 'stale' ? (r.vramTotalMib ?? null) : null;
}

export class NvidiaSmi {
  private child: ChildProcess | null = null;

  constructor(
    private readonly bin: string,
    private readonly opts: { proc?: string; timeoutMs?: number } = {},
  ) {}

  /** The GPU readings; 'stale' when the GPU did not answer in time or a query is
   *  already hanging; null when nvidia-smi failed. */
  read(): Promise<Readings | 'stale' | null> {
    return this.query([NVIDIA_QUERY, '--format=csv,noheader,nounits']).then((out) =>
      out === 'stale' ? 'stale' : out === null ? null : parseNvidiaCsv(out),
    );
  }

  readProcesses(): Promise<Array<{ pid: number; usedMib: number }> | 'stale' | null> {
    return this.query([NVIDIA_PROCESS_QUERY, '--format=csv,noheader,nounits']).then((out) =>
      out === null || out === 'stale' ? out : parseNvidiaProcesses(out),
    );
  }

  private query(args: string[]): Promise<string | 'stale' | null> {
    if (this.child || nvidiaSmiStuck(NVIDIA_STUCK_S, this.opts.proc))
      return Promise.resolve('stale');
    return new Promise((resolve) => {
      let out = '';
      const child = spawn(this.bin, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      this.child = child;
      const timer = setTimeout(() => {
        child.unref(); // left running on purpose, see above
        resolve('stale');
      }, this.opts.timeoutMs ?? NVIDIA_TIMEOUT_MS);
      const done = (r: string | null) => {
        clearTimeout(timer);
        this.child = null;
        resolve(r);
      };
      child.stdout?.on('data', (b: Buffer) => {
        if (out.length < 4096) out += b.toString('utf-8');
      });
      child.on('error', () => done(null));
      child.on('close', (code) => done(code === 0 ? out : null));
    });
  }
}
