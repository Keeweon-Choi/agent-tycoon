/**
 * What the hardware views show of one HW sample: the WSL or the Windows side of
 * RAM and disks, every GPU as a list, and the one item picked to show larger
 * (pure; the lobby board and the 현황판 HW tab both read it).
 */
import { useSyncExternalStore } from 'react';

import type { HwDisk, HwGpu, HwSample } from '../../../core/src/messages.js';

export type HwViewKind = 'wsl' | 'windows';

export interface HwGpuItem extends HwGpu {
  /** Stable within a sample: the name, `#2` after it for a second card of the same name. */
  key: string;
}
export interface HwDiskItem extends HwDisk {
  key: string;
  usedGib: number | null;
  /** Used share, 0-1; null when the size is unknown. */
  usedFrac: number | null;
  /** At or under its own warn line. */
  low: boolean;
}
export interface HwViewModel {
  /** Both a WSL and a Windows view exist (WSL with LibreHardwareMonitor answering). */
  canToggle: boolean;
  /** The side shown: always `wsl` while there is only one. */
  view: HwViewKind;
  ram: { usedGib: number | null; totalGib: number | null };
  disks: HwDiskItem[];
  gpus: HwGpuItem[];
}

const num = (x: number | null | undefined): number | null => (typeof x === 'number' ? x : null);

/** Every GPU of the sample; older daemons (and Linux, nvidia-smi) only fill the single-GPU fields. */
function gpuList(hw: HwSample): HwGpuItem[] {
  const list: HwGpu[] = hw.gpus?.length
    ? // nvidia-smi only fills the single VRAM fields: they belong to the first GPU.
      hw.gpus.map((g, i) =>
        i === 0
          ? {
              ...g,
              vramUsedMib: g.vramUsedMib ?? hw.vramUsedMib,
              vramTotalMib: g.vramTotalMib ?? hw.vramTotalMib,
            }
          : g,
      )
    : [
        {
          name: 'GPU',
          tempC: hw.gpuTempC,
          hotspotC: hw.gpuHotspotC,
          powerW: hw.gpuPowerW,
          util: hw.gpuUtil,
          vramUsedMib: hw.vramUsedMib,
          vramTotalMib: hw.vramTotalMib,
        },
      ].filter((g) => Object.values(g).some((v) => typeof v === 'number'));
  const seen = new Map<string, number>();
  return list.map((g) => {
    const n = (seen.get(g.name) ?? 0) + 1;
    seen.set(g.name, n);
    return { ...g, key: n > 1 ? `${g.name} #${n}` : g.name };
  });
}

function diskItem(d: HwDisk): HwDiskItem {
  const total = num(d.totalGib);
  const free = num(d.freeGib);
  const usedGib = total !== null && free !== null ? total - free : null;
  return {
    ...d,
    key: d.name,
    usedGib,
    usedFrac: usedGib !== null && total! > 0 ? Math.max(0, Math.min(1, usedGib / total!)) : null,
    low: d.warning === true || (free !== null && d.warnGib != null && free < d.warnGib),
  };
}

export function hwViewModel(hw: HwSample, wanted: HwViewKind): HwViewModel {
  const canToggle =
    num(hw.hostRamTotalGib) !== null &&
    num(hw.ramTotalGib) !== null &&
    hw.disks.some((d) => d.view === 'wsl');
  const view = canToggle ? wanted : 'wsl';
  const windows = view === 'windows';
  return {
    canToggle,
    view,
    ram: windows
      ? { usedGib: num(hw.hostRamUsedGib), totalGib: num(hw.hostRamTotalGib) }
      : { usedGib: num(hw.ramUsedGib), totalGib: num(hw.ramTotalGib) },
    // Without two views every disk the host reported is listed.
    disks: hw.disks
      .filter((d) => !canToggle || (d.view ?? view) === view)
      .filter((d) => d.freeGib != null)
      .map(diskItem),
    gpus: gpuList(hw),
  };
}

/** The picked item (shown larger), or null when none is picked or it is gone: then all are shown. */
export function pickedItem<T extends { key: string }>(items: T[], key: string | null): T | null {
  return (key !== null && items.find((i) => i.key === key)) || null;
}

/** What a detail view can be about; `gpu:` and `disk:` carry the item's key. */
export const DETAIL_CPU = 'cpu';
export const DETAIL_RAM = 'ram';
export const gpuDetail = (key: string): string => `gpu:${key}`;
export const diskDetail = (key: string): string => `disk:${key}`;

export type HwOpen =
  | { kind: 'cpu' }
  | { kind: 'ram' }
  | { kind: 'gpu'; gpu: HwGpuItem }
  | { kind: 'disk'; disk: HwDiskItem };

/**
 * The one detail open, or null when none is or its item is gone (a disk of the other side after
 * the toggle, a GPU that left): then everything is shown again.
 */
export function openDetail(m: HwViewModel, key: string | null): HwOpen | null {
  if (key === DETAIL_CPU) return { kind: 'cpu' };
  if (key === DETAIL_RAM) return { kind: 'ram' };
  const gpu = key?.startsWith('gpu:') ? pickedItem(m.gpus, key.slice(4)) : null;
  if (gpu) return { kind: 'gpu', gpu };
  const disk = key?.startsWith('disk:') ? pickedItem(m.disks, key.slice(5)) : null;
  return disk ? { kind: 'disk', disk } : null;
}

// ── The choice, remembered per device ─────────────────────────

export interface HwPrefs {
  view: HwViewKind;
  /** The detail open (`cpu`, `ram`, `gpu:<key>`, `disk:<key>`), null = all of it. */
  detail: string | null;
}
export const HW_PREFS_KEY = 'cld.board.hw';

function readPrefs(): HwPrefs {
  const fallback: HwPrefs = { view: 'wsl', detail: null };
  try {
    // `gpu` / `disk` are the earlier release's picks (one each); the GPU one wins.
    const raw = JSON.parse(localStorage.getItem(HW_PREFS_KEY) ?? 'null') as {
      view?: unknown;
      detail?: unknown;
      gpu?: unknown;
      disk?: unknown;
    } | null;
    const old =
      typeof raw?.gpu === 'string'
        ? gpuDetail(raw.gpu)
        : typeof raw?.disk === 'string'
          ? diskDetail(raw.disk)
          : null;
    return {
      view: raw?.view === 'windows' ? 'windows' : 'wsl',
      detail: typeof raw?.detail === 'string' ? raw.detail : old,
    };
  } catch {
    return fallback;
  }
}

let prefs: HwPrefs | null = null;
const listeners = new Set<() => void>();
export const getHwPrefs = (): HwPrefs => (prefs ??= readPrefs());

export function setHwPrefs(patch: Partial<HwPrefs>): void {
  prefs = { ...getHwPrefs(), ...patch };
  try {
    localStorage.setItem(HW_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // A locked-down browser keeps the choice for this visit only.
  }
  listeners.forEach((l) => l());
}

/** The remembered choice; the wall board, its full view and the HW tab share it. */
export function useHwPrefs(): HwPrefs {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, getHwPrefs);
}

/** Tests: forget what was read. */
export function resetHwPrefs(): void {
  prefs = null;
}
