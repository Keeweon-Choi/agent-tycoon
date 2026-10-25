/**
 * LibreHardwareMonitor's web server (`/data.json`) on Windows, read natively or
 * from WSL (T-0030). The tree is computer -> hardware -> sensor type -> sensor;
 * a sensor node has `SensorId` (`/intelcpu/0/temperature/16`), `Type`
 * (`Temperature`, `Power`, `Load`, `SmallData`), `Text` (`CPU Package`) and its
 * value as text in Windows' number format (`"54.0 °C"`, `"54,0 °C"`).
 *
 * The port is the one the installer set up or found (`--lhm-port`); without it
 * nothing is read. From WSL, 127.0.0.1 reaches Windows only in mirrored
 * networking; in the default NAT mode Windows' own curl.exe reads its localhost
 * (an inbound connection to the host is blocked by its firewall).
 */
import * as fs from 'fs';

import type { HwCpuCore, HwGpu } from '../../../../core/src/messages.js';
import { findOnPath } from '../providers/claudeProvider.js';
import { spawnJson } from '../spawnJson.js';
import type { Readings } from './hwSource.js';

/** After a failed read, LHM is tried again this much later (no curl.exe every 2 s for a closed LHM). */
export const LHM_RETRY_MS = 30_000;
const TIMEOUT_MS = 1_500;
const CURL_EXE = '/mnt/c/Windows/System32/curl.exe';

interface Sensor {
  id: string;
  type: string;
  text: string;
  value: number | null;
}

/** First number in a value (`"1749.0 MB"`, `"54,0 °C"`, or a plain number). */
function value(...xs: unknown[]): number | null {
  for (const x of xs) {
    if (typeof x === 'number' && Number.isFinite(x)) return x;
    const m = typeof x === 'string' ? /-?\d+(?:[.,]\d+)?/.exec(x) : null;
    if (m) return Number(m[0].replace(',', '.'));
  }
  return null;
}

function sensors(json: unknown, names: Map<string, string> = new Map()): Sensor[] {
  const out: Sensor[] = [];
  const stack: unknown[] = [json];
  while (stack.length) {
    const n = stack.pop();
    if (typeof n !== 'object' || n === null) continue;
    const o = n as Record<string, unknown>;
    // A hardware node (`/gpu-nvidia/0`) carries the device's name as its Text.
    if (typeof o.HardwareId === 'string' && typeof o.Text === 'string')
      names.set(o.HardwareId, o.Text);
    if (typeof o.SensorId === 'string' && typeof o.Type === 'string')
      out.push({
        id: o.SensorId,
        type: o.Type,
        text: typeof o.Text === 'string' ? o.Text : '',
        value: value(o.RawValue, o.Value),
      });
    if (Array.isArray(o.Children)) stack.push(...o.Children);
  }
  return out;
}

const CPU = /^\/(intelcpu|amdcpu)\/\d+\//;
/** A core's clock / temperature sensor: `P-Core #1`, `E-Core #3` (hybrid Intel), `CPU Core #2` (Intel), `Core #2`, `Core #2 (CCD1)` (Zen). Not `... Distance to TjMax` or `... (SMU)`. */
const CORE_NAME = /^(?:([PE])-|CPU )?Core #(\d+)(?: \(CCD\d+\))?$/;
/** A core's load: `CPU Core #7`, or one per thread, `CPU Core #1 Thread #2`. Counted in the order the cores are listed. */
const CORE_LOAD = /^CPU Core #(\d+)(?: Thread #\d+)?$/;
const lastIndex = (id: string) => Number(id.slice(id.lastIndexOf('/') + 1));

/**
 * Per-core clock, temperature and load of one CPU, matched by sensor type and name, never by id
 * or count. A core named by number (`Core #2`, `CPU Core #2`) takes the load of `CPU Core #2`.
 * A hybrid core (`P-Core #1`, `E-Core #1`) has no number of its own in the load names, which count
 * the cores in clock order (P-cores first): it takes the load at its position, but only when there
 * are exactly as many loads as cores; otherwise its load is left out rather than guessed.
 */
function cpuCores(all: Sensor[]): HwCpuCore[] {
  const mine = all
    .filter((s) => CPU.test(s.id) && s.value !== null)
    .sort((a, b) => lastIndex(a.id) - lastIndex(b.id));
  const cores = new Map<string, { core: HwCpuCore; n: number; hybrid: boolean }>();
  for (const type of ['Clock', 'Temperature'])
    for (const s of mine.filter((x) => x.type === type)) {
      const m = CORE_NAME.exec(s.text);
      if (!m) continue;
      const key = `${m[1] ?? ''}${m[2]}`;
      const entry = cores.get(key) ?? {
        core: { name: s.text.replace(/ \(CCD\d+\)$/, '') },
        n: Number(m[2]),
        hybrid: m[1] !== undefined,
      };
      cores.set(key, entry);
      if (type === 'Clock') entry.core.clockMhz = Math.round(s.value!);
      else entry.core.tempC = s.value!;
    }
  const loads = new Map<number, number[]>();
  for (const s of mine.filter((x) => x.type === 'Load')) {
    const m = CORE_LOAD.exec(s.text);
    if (m) loads.set(Number(m[1]), [...(loads.get(Number(m[1])) ?? []), s.value!]);
  }
  const util = (n: number) => {
    const l = loads.get(n);
    return l ? Math.round(l.reduce((a, b) => a + b, 0) / l.length) / 100 : undefined;
  };
  // No clock or temperature per core (some boards): the load sensors name the cores.
  if (!cores.size)
    return [...loads.keys()]
      .sort((a, b) => a - b)
      .map((n) => ({ name: `Core #${n}`, util: util(n)! }));
  const list = [...cores.values()];
  const byPosition =
    list.filter((c) => c.hybrid).length === loads.size
      ? [...loads.keys()].sort((a, b) => a - b)
      : [];
  let hybridSeen = 0;
  return list.map(({ core, n, hybrid }) => {
    const u = hybrid ? util(byPosition[hybridSeen++]) : util(n);
    return u === undefined ? core : { ...core, util: u };
  });
}
/** GPU hardware kinds, the one shown first: a discrete card before an integrated one. */
const GPUS = ['gpu-nvidia', 'gpu-amd', 'gpu-intel', 'gpu-intel-integrated'];

/** data.json -> the readings it has, or null when it is not LHM's tree. */
export function parseLhm(json: unknown): Readings | null {
  const names = new Map<string, string>();
  const all = sensors(json, names);
  if (!all.length) return null;
  const pick = (hw: (id: string) => boolean, type: string, texts: string[]): number | null => {
    for (const text of texts) {
      const s = all.find((x) => x.type === type && x.text === text && hw(x.id));
      if (s && s.value !== null) return s.value;
    }
    return null;
  };
  const cpu = (id: string) => CPU.test(id);
  const out: Record<string, number | null> = {
    // Intel names the package; Zen names the control temperature (Tctl/Tdie) and its power "Package".
    cpuTempC: pick(cpu, 'Temperature', [
      'CPU Package',
      'Core (Tctl/Tdie)',
      'Core (Tdie)',
      'Core (Tctl)',
      'Core Max',
    ]),
    cpuPowerW: pick(cpu, 'Power', ['CPU Package', 'Package']),
    cpuCoresW: pick(cpu, 'Power', ['CPU Cores', 'Cores', 'Cores (SMU)']),
    // Intel names them; Zen has the CCD dies' max and average.
    cpuCoreMaxC: pick(cpu, 'Temperature', ['Core Max', 'CCDs Max (Tdie)']),
    cpuCoreAvgC: pick(cpu, 'Temperature', ['Core Average', 'CCDs Average (Tdie)']),
    cpuBusMhz: pick(cpu, 'Clock', ['Bus Speed']),
  };
  const cores = cpuCores(all);
  const hostUsed = pick((id) => id.startsWith('/ram/'), 'Data', ['Memory Used']);
  const hostAvailable = pick((id) => id.startsWith('/ram/'), 'Data', ['Memory Available']);
  if (hostUsed !== null && hostAvailable !== null) {
    // LHM's "GB" is 1024³ bytes (27.6 + 20.2 = 47.8 on a 51 320 053 760-byte host).
    out.hostRamUsedGib = hostUsed;
    out.hostRamTotalGib = Math.round((hostUsed + hostAvailable) * 10) / 10;
  }
  // Every GPU, a discrete card before an integrated one (the first fills the single-GPU fields).
  const gpuIds = GPUS.flatMap((k) =>
    [
      ...new Set(
        all
          .filter((s) => s.id.startsWith(`/${k}/`))
          .map((s) => s.id.split('/').slice(0, 3).join('/')),
      ),
    ].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
  );
  const gpus = gpuIds.map((gpuId) => {
    const gpu = (id: string) => id.startsWith(`${gpuId}/`);
    const load = pick(gpu, 'Load', ['GPU Core']);
    const g = {
      name: names.get(gpuId) ?? gpuId,
      tempC: pick(gpu, 'Temperature', ['GPU Core']),
      hotspotC: pick(gpu, 'Temperature', ['GPU Hot Spot']),
      powerW: pick(gpu, 'Power', ['GPU Package', 'GPU Power', 'GPU Total']),
      util: load === null ? null : Math.round(load) / 100,
      vramUsedMib: pick(gpu, 'SmallData', ['GPU Memory Used', 'D3D Dedicated Memory Used']),
      vramTotalMib: pick(gpu, 'SmallData', ['GPU Memory Total', 'D3D Dedicated Memory Total']),
    };
    for (const k of ['vramUsedMib', 'vramTotalMib'] as const)
      if (g[k] !== null) g[k] = Math.round(g[k]);
    return Object.fromEntries(Object.entries(g).filter(([, v]) => v !== null)) as unknown as HwGpu;
  });
  if (gpus.length) {
    const g = gpus[0];
    Object.assign(out, {
      gpuTempC: g.tempC ?? null,
      gpuHotspotC: g.hotspotC ?? null,
      gpuPowerW: g.powerW ?? null,
      gpuUtil: g.util ?? null,
      vramUsedMib: g.vramUsedMib ?? null,
      vramTotalMib: g.vramTotalMib ?? null,
    });
  }
  const readings = Object.fromEntries(
    Object.entries(out).filter(([, v]) => v !== null),
  ) as Readings;
  if (gpus.length) readings.gpus = gpus;
  if (cores.length) readings.cpuCores = cores;
  if (hostUsed !== null && hostAvailable !== null) {
    // `/vram/` is Windows' virtual memory (commit), not a GPU's.
    const load = pick((id) => id.startsWith('/ram/'), 'Load', ['Memory']);
    const virt = (text: string) => pick((id) => id.startsWith('/vram/'), 'Data', [text]);
    const vUsed = virt('Memory Used');
    const vAvailable = virt('Memory Available');
    readings.hostRamDetail = {
      usedGib: hostUsed,
      availableGib: hostAvailable,
      ...(load === null ? {} : { util: Math.round(load) / 100 }),
      ...(vUsed !== null && vAvailable !== null
        ? { virtualUsedGib: vUsed, virtualTotalGib: Math.round((vUsed + vAvailable) * 10) / 10 }
        : {}),
    };
  }
  return readings;
}

async function httpJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Windows' curl.exe from WSL, by absolute path: the service's PATH has no Windows folders. */
function curlJson(url: string): Promise<unknown> {
  const exe = findOnPath('curl.exe') ?? (fs.existsSync(CURL_EXE) ? CURL_EXE : null);
  // ponytail: C: and /mnt/c assumed when curl.exe is not on PATH; a custom automount root needs PATH.
  if (!exe) return Promise.reject(new Error('curl.exe not found'));
  return spawnJson(exe, ['-s', '-m', '1', url], { timeoutMs: TIMEOUT_MS + 1_000 });
}

export class LhmReader {
  private retryAt = 0;

  constructor(
    private readonly port: number,
    private readonly wsl: boolean,
    private readonly get: { http: typeof httpJson; curl: typeof curlJson } = {
      http: httpJson,
      curl: curlJson,
    },
  ) {}

  /** The readings, or null while LHM does not answer (then again after LHM_RETRY_MS). */
  async read(now = Date.now()): Promise<Readings | null> {
    if (now < this.retryAt) return null;
    let json: unknown = null;
    try {
      json = await this.get.http(`http://127.0.0.1:${this.port}/data.json`);
    } catch {
      if (this.wsl)
        json = await this.get.curl(`http://localhost:${this.port}/data.json`).catch(() => null);
    }
    const r = json === null ? null : parseLhm(json);
    if (!r) this.retryAt = now + LHM_RETRY_MS;
    return r;
  }
}
