/**
 * The HW sample (T-0003, T-0013, T-0030): the daemon's own sampler. It
 * reads CPU load, memory and the home disk from the OS everywhere, plus one
 * sensor source per OS:
 * - Linux: sysfs (hwmon and the GPU's DRM device), nothing to install;
 * - Windows and WSL: LibreHardwareMonitor's data.json, on the port the
 *   installer's `--hw-sensors` step set up or found (`--lhm-port`);
 * - macOS: none (powermetrics needs root, the SMC needs native code).
 * NVIDIA through nvidia-smi only when the user turned it on, and only when the
 * OS source left the GPU empty. Every reading names its source (`sources`).
 * Sampled only while someone views (Office.wake).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { koText } from '../../../../core/src/cld/serverText.js';
import type {
  HwCpuCore,
  HwRamDetail,
  HwReadingSource,
  HwSample,
} from '../../../../core/src/messages.js';
import { configDirectory } from '../configPath.js';
import { readDxgUsers } from '../engine/gpu.js';
import { maskText } from '../mask.js';
import { shortProcessCommand } from './commandDisplay.js';
import { LhmReader } from './lhm.js';
import { NvidiaSmi } from './nvidiaSmi.js';
import { readSysfs } from './sysfs.js';

/** The sensor fields a source can add to a sample. */
export type Readings = Partial<
  Pick<
    HwSample,
    | 'cpuTempC'
    | 'cpuPowerW'
    | 'cpuCores'
    | 'cpuCoresW'
    | 'cpuCoreMaxC'
    | 'cpuCoreAvgC'
    | 'cpuBusMhz'
    | 'hostRamDetail'
    | 'gpuTempC'
    | 'gpuHotspotC'
    | 'gpuPowerW'
    | 'gpuUtil'
    | 'vramUsedMib'
    | 'vramTotalMib'
    | 'hostRamUsedGib'
    | 'hostRamTotalGib'
    | 'gpus'
  >
>;
type Sample = Omit<HwSample, 'type'>;
export type HwPlatform = 'linux' | 'wsl' | 'win32' | 'darwin' | 'other';

const GIB = 1024 ** 3;
const round1 = (x: number) => Math.round(x * 10) / 10;
const isSet = (v: unknown) => v !== null && v !== undefined;

export interface HwDiskConfig {
  diskPercentWarn: number;
  diskFreeWarnGib: number;
}
export function readHwConfig(home = os.homedir()): HwDiskConfig {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(
      fs.readFileSync(path.join(configDirectory(home), 'hw.json'), 'utf-8'),
    ) as Record<string, unknown>;
  } catch {
    /* defaults */
  }
  const number = (key: keyof HwDiskConfig, fallback: number) =>
    typeof raw?.[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= 0
      ? (raw[key] as number)
      : fallback;
  return {
    diskPercentWarn: number('diskPercentWarn', 10),
    diskFreeWarnGib: number('diskFreeWarnGib', 100),
  };
}

/** Linux /proc/meminfo: used, cache, available and swap; null off Linux or when unreadable. */
export function readRamDetail(proc = '/proc'): HwRamDetail | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(proc, 'meminfo'), 'utf-8');
  } catch {
    return null;
  }
  const kib = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kib('MemTotal');
  const available = kib('MemAvailable');
  if (total === null || available === null) return null;
  const cache = kib('Cached');
  const buffers = kib('Buffers') ?? 0;
  const swapTotal = kib('SwapTotal');
  const swapFree = kib('SwapFree');
  return {
    usedGib: round1((total - available) / GIB),
    availableGib: round1(available / GIB),
    ...(cache === null ? {} : { cachedGib: round1((cache + buffers) / GIB) }),
    ...(swapTotal === null || swapFree === null
      ? {}
      : {
          swapUsedGib: round1((swapTotal - swapFree) / GIB),
          swapTotalGib: round1(swapTotal / GIB),
        }),
  };
}

/** Linux /proc: the top 5 by CPU (lifetime average, like `ps`), for `cld-gui hw` on demand only. */
export function readTopProcesses(
  proc = '/proc',
): Array<{ pid: number; cpuPct: number; rssMib: number; command: string }> {
  const rows: Array<{ pid: number; cpuPct: number; rssMib: number; command: string }> = [];
  let uptime = 0;
  try {
    uptime = Number(fs.readFileSync(path.join(proc, 'uptime'), 'utf-8').split(' ')[0]);
  } catch {
    return rows;
  }
  for (const name of fs.readdirSync(proc).filter((x) => /^\d+$/.test(x))) {
    try {
      const stat = fs.readFileSync(path.join(proc, name, 'stat'), 'utf-8');
      const parts = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = Number(parts[11]) + Number(parts[12]);
      const lifetime = Math.max(0.1, uptime - Number(parts[19]) / 100);
      const status = fs.readFileSync(path.join(proc, name, 'status'), 'utf-8');
      const rssMib = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) / 1024;
      const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
      const command =
        parts[0] === 'D'
          ? comm
          : fs.readFileSync(path.join(proc, name, 'cmdline'), 'utf-8').replace(/\0/g, ' ').trim() ||
            comm;
      rows.push({
        pid: Number(name),
        cpuPct: Math.round(ticks / lifetime),
        rssMib: Math.round(rssMib),
        command: shortProcessCommand(maskText(command.replace(/[\r\n]+/g, ' '))),
      });
    } catch {
      /* process exited or is unreadable */
    }
  }
  return rows.sort((a, b) => b.cpuPct - a.cpuPct || b.rssMib - a.rssMib).slice(0, 5);
}

export function hwPlatform(platform: string = process.platform, procVersion?: string): HwPlatform {
  if (platform === 'linux') {
    let v = procVersion;
    try {
      v ??= fs.readFileSync('/proc/version', 'utf-8');
    } catch {
      v = '';
    }
    return /microsoft/i.test(v) ? 'wsl' : 'linux';
  }
  return platform === 'win32' || platform === 'darwin' ? platform : 'other';
}

export interface HwSourceOptions {
  home?: string;
  platform?: HwPlatform;
  /** Windows/WSL: LHM's web server port, set up or found by the installer; null = no LHM. */
  lhmPort?: number | null;
  /** nvidia-smi's path when the user turned the GPU query on; null = never run. */
  nvidiaSmi?: string | null;
  /** sysfs root, `/sys` (tests). */
  sysRoot?: string;
  diskPaths?: Array<{ name: string; path: string }>;
  procRoot?: string;
  /** Test doubles for the LHM and nvidia-smi readers. */
  lhm?: Pick<LhmReader, 'read'> | null;
  nvidia?: (Pick<NvidiaSmi, 'read'> & Partial<Pick<NvidiaSmi, 'readProcesses'>>) | null;
}

export class HwSource {
  private lastCpu: { idle: number; total: number } | null = null;
  /** Each logical CPU's counters at the last sample, for its load; and the cores built from them. */
  private lastCores: Array<{ idle: number; total: number }> = [];
  private osCores: HwCpuCore[] = [];
  private readonly platform: HwPlatform;
  private readonly lhm: Pick<LhmReader, 'read'> | null;
  private readonly nvidia:
    (Pick<NvidiaSmi, 'read'> & Partial<Pick<NvidiaSmi, 'readProcesses'>>) | null;

  constructor(private readonly opts: HwSourceOptions = {}) {
    this.platform = opts.platform ?? hwPlatform();
    const lhmOs = this.platform === 'win32' || this.platform === 'wsl';
    this.lhm =
      opts.lhm !== undefined
        ? opts.lhm
        : lhmOs && opts.lhmPort
          ? new LhmReader(opts.lhmPort, this.platform === 'wsl')
          : null;
    this.nvidia =
      opts.nvidia !== undefined
        ? opts.nvidia
        : opts.nvidiaSmi
          ? new NvidiaSmi(opts.nvidiaSmi)
          : null;
  }

  async sample(now = Date.now()): Promise<Sample> {
    const s = this.builtin(now);
    const sources = s.sources!;
    const add = (r: Readings | null, source: HwReadingSource) => {
      for (const [k, v] of Object.entries(r ?? {}))
        if (isSet(v) && !isSet((s as Record<string, unknown>)[k])) {
          (s as Record<string, unknown>)[k] = v;
          sources[k] = source;
        }
    };
    if (this.platform === 'linux') {
      add(readSysfs(this.opts.sysRoot), 'sysfs');
      s.sensorsHint = !isSet(s.cpuTempC);
    } else if (this.platform === 'win32' || this.platform === 'wsl') {
      const r = this.lhm ? await this.lhm.read(now) : null;
      add(r, 'lhm');
      s.lhm = r !== null;
      s.sensorsHint = r === null;
    }
    // No LHM per-core readings: the OS's own logical CPUs (clock, load).
    if (!isSet(s.cpuCores) && this.osCores.length) {
      s.cpuCores = this.osCores;
      sources.cpuCores = 'os';
    }
    if (this.nvidia && (!isSet(s.vramUsedMib) || !isSet(s.vramTotalMib))) {
      const g = await this.nvidia.read();
      if (g === 'stale') s.warnings.push(koText('nvidia_stale'));
      else add(g, 'nvidia-smi');
    }
    // WSL: the /dev/dxg openers (its --query-compute-apps names no process).
    if (this.platform === 'wsl')
      s.gpuProcesses = readDxgUsers(this.opts.procRoot).map(({ pid, usedMib, cmd }) => ({
        pid,
        usedMib,
        cmd,
      }));
    else {
      const procs = this.nvidia?.readProcesses ? await this.nvidia.readProcesses() : null;
      s.gpuProcesses = procs === 'stale' ? null : procs;
      if (procs === 'stale' && !s.warnings.some((w) => w.includes('nvidia-smi 응답 없음')))
        s.warnings.push(koText('nvidia_stale'));
    }
    return s;
  }

  private builtin(now: number): Sample {
    let idle = 0;
    let total = 0;
    const counters = os.cpus().map((c) => {
      const t = c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
      idle += c.times.idle;
      total += t;
      return { idle: c.times.idle, total: t, speed: c.speed };
    });
    const before = this.lastCores;
    this.lastCores = counters;
    this.osCores = counters.map((c, i) => {
      const p = before.length === counters.length ? before[i] : null;
      const core: HwCpuCore = { name: `CPU #${i + 1}` };
      if (c.speed > 0) core.clockMhz = c.speed;
      if (p && c.total > p.total)
        core.util = round1((1 - (c.idle - p.idle) / (c.total - p.total)) * 100) / 100;
      return core;
    });
    const prev = this.lastCpu;
    this.lastCpu = { idle, total };
    const cpuUtil =
      prev && total > prev.total
        ? round1((1 - (idle - prev.idle) / (total - prev.total)) * 100) / 100
        : null;
    const config = readHwConfig(this.opts.home);
    const disks: Sample['disks'] = [];
    const paths =
      this.opts.diskPaths ??
      (this.platform === 'win32'
        ? [
            { name: 'C:', path: 'C:\\' },
            { name: 'D:', path: 'D:\\' },
            { name: 'E:', path: 'E:\\' },
          ]
        : this.platform === 'wsl'
          ? [
              { name: 'WSL', path: '/' },
              ...['c', 'd', 'e'].map((d) => ({ name: `${d.toUpperCase()}:`, path: `/mnt/${d}` })),
            ]
          : [{ name: '~', path: this.opts.home ?? os.homedir() }]);
    for (const drive of paths) {
      try {
        const st = fs.statfsSync(drive.path);
        const totalGib = Math.round((st.blocks * st.bsize) / GIB);
        const freeGib = Math.round((st.bavail * st.bsize) / GIB);
        const warnGib =
          drive.name === 'D:'
            ? (totalGib * config.diskPercentWarn) / 100
            : drive.name === 'WSL' || drive.name === 'C:'
              ? config.diskFreeWarnGib
              : null;
        disks.push({
          name: drive.name,
          // WSL has two views of the machine: the distro (its root) and Windows (the /mnt drives).
          ...(this.platform === 'wsl' ? { view: drive.name === 'WSL' ? 'wsl' : 'windows' } : {}),
          freeGib,
          totalGib,
          warnGib,
          warning: warnGib !== null && freeGib < warnGib,
        });
      } catch {
        /* absent drive */
      }
    }
    const s: Sample = {
      ts: new Date(now).toISOString(),
      stale: false,
      ramUsedGib: round1((os.totalmem() - os.freemem()) / GIB),
      ramTotalGib: round1(os.totalmem() / GIB),
      disks,
      warnings: [...disks.filter((d) => d.warning).map((d) => koText('disk_low', { name: d.name }))],
      sources: { ramUsedGib: 'os', ramTotalGib: 'os' },
    };
    if (this.platform === 'linux' || this.platform === 'wsl') {
      const ram = readRamDetail(this.opts.procRoot);
      if (ram) {
        s.ramDetail = ram;
        s.sources!.ramDetail = 'os';
      }
    }
    if (cpuUtil !== null) {
      s.cpuUtil = cpuUtil;
      s.sources!.cpuUtil = 'os';
    }
    if (disks.length) s.sources!.disks = 'os';
    return s;
  }
}

/** The per-core and memory detail only the boards read; `cld-gui hw` prints a sample without them. */
const DETAIL_FIELDS = [
  'cpuCores',
  'cpuCoresW',
  'cpuCoreMaxC',
  'cpuCoreAvgC',
  'cpuBusMhz',
  'ramDetail',
  'hostRamDetail',
] as const;
export function withoutDetail(hw: Omit<HwSample, 'type'>): Omit<HwSample, 'type'> {
  const out = { ...hw, sources: { ...hw.sources } };
  for (const k of DETAIL_FIELDS) {
    delete out[k];
    delete out.sources[k];
  }
  return hw.sources ? out : { ...out, sources: undefined };
}

/** Whether a sample holds any reading at all (a sample of nothing is "no sample"). */
export const hasHwReadings = (s: Sample): boolean =>
  s.disks.length > 0 ||
  Object.entries(s).some(
    ([k, v]) => typeof v === 'number' && !['ts', 'sources'].includes(k) && Number.isFinite(v),
  );
