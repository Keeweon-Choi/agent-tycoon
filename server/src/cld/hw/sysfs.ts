/**
 * Linux sensors straight from sysfs: no tool, no root (T-0030).
 *
 * `/sys/class/hwmon/hwmonN/` holds one chip each: `name` is its driver,
 * `tempN_input` millidegrees C with an optional `tempN_label`, and
 * `powerN_average` / `powerN_input` microwatts. Thermal zones register hwmon
 * chips of their own, so `/sys/class/thermal` adds nothing here. An amdgpu's
 * `device/` is its PCI device, which also carries `gpu_busy_percent` and
 * `mem_info_vram_used` / `mem_info_vram_total` (bytes, the DRM card's files).
 *
 * Not read: CPU power (RAPL `energy_uj` is root-only since CVE-2020-8694) and
 * NVIDIA's proprietary driver, which has no hwmon (nvidia-smi, opt-in).
 */
import * as fs from 'fs';
import * as path from 'path';

import type { Readings } from './hwSource.js';

/** CPU chips in order of trust; ARM boards report the SoC as `cpu_thermal`. */
const CPU_CHIPS = ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal'];
/** The package or die sensor of a CPU chip, else its first temperature. */
const CPU_LABELS = ['Package id 0', 'Tdie', 'Tctl'];
const GPU_CHIPS = ['amdgpu', 'nouveau', 'xe', 'i915'];

const round1 = (x: number) => Math.round(x * 10) / 10;

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8').trim();
  } catch {
    return null;
  }
}

function num(file: string): number | null {
  const s = read(file);
  const n = s === null || s === '' ? NaN : Number(s);
  return Number.isFinite(n) ? n : null;
}

interface Temp {
  label: string | null;
  c: number;
}

function temps(dir: string, files: string[]): Temp[] {
  const out: Array<Temp & { n: number }> = [];
  for (const f of files) {
    const m = /^temp(\d+)_input$/.exec(f);
    const milli = m ? num(path.join(dir, f)) : null;
    if (m && milli !== null)
      out.push({
        n: Number(m[1]),
        label: read(path.join(dir, `temp${m[1]}_label`)),
        c: round1(milli / 1000),
      });
  }
  return out.sort((a, b) => a.n - b.n);
}

interface Chip {
  dir: string;
  name: string;
  files: string[];
}

function chips(root: string): Chip[] {
  const base = path.join(root, 'class/hwmon');
  let entries: string[];
  try {
    entries = fs.readdirSync(base);
  } catch {
    return [];
  }
  const out: Chip[] = [];
  for (const e of entries.sort()) {
    const dir = path.join(base, e);
    try {
      out.push({ dir, name: read(path.join(dir, 'name')) ?? '', files: fs.readdirSync(dir) });
    } catch {
      /* not a chip directory */
    }
  }
  return out;
}

/** What the hwmon chips under `root` (normally `/sys`) say about the CPU and the GPU. */
export function readSysfs(root = '/sys'): Readings {
  const all = chips(root);
  const out: Readings = {};
  for (const name of CPU_CHIPS) {
    const chip = all.find((c) => c.name === name);
    const t = chip ? temps(chip.dir, chip.files) : [];
    const pick = CPU_LABELS.map((l) => t.find((x) => x.label === l)).find(Boolean) ?? t[0];
    if (pick) {
      out.cpuTempC = pick.c;
      break;
    }
  }
  // ponytail: one GPU, the one with the most VRAM (a discrete card over an APU); per-GPU rows if anyone has two.
  const gpus = all
    .filter((c) => GPU_CHIPS.includes(c.name))
    .map((c) => ({ c, vram: num(path.join(c.dir, 'device/mem_info_vram_total')) ?? 0 }))
    .sort((a, b) => b.vram - a.vram || GPU_CHIPS.indexOf(a.c.name) - GPU_CHIPS.indexOf(b.c.name));
  const gpu = gpus[0]?.c;
  if (!gpu) return out;
  const t = temps(gpu.dir, gpu.files);
  const edge = t.find((x) => x.label === 'edge') ?? t[0];
  if (edge) out.gpuTempC = edge.c;
  const junction = t.find((x) => x.label === 'junction');
  if (junction) out.gpuHotspotC = junction.c;
  const uw = num(path.join(gpu.dir, 'power1_average')) ?? num(path.join(gpu.dir, 'power1_input'));
  if (uw !== null) out.gpuPowerW = round1(uw / 1e6);
  const busy = num(path.join(gpu.dir, 'device/gpu_busy_percent'));
  if (busy !== null) out.gpuUtil = busy / 100;
  const used = num(path.join(gpu.dir, 'device/mem_info_vram_used'));
  const total = num(path.join(gpu.dir, 'device/mem_info_vram_total'));
  if (used !== null && total !== null) {
    out.vramUsedMib = Math.round(used / 2 ** 20);
    out.vramTotalMib = Math.round(total / 2 ** 20);
  }
  return out;
}
