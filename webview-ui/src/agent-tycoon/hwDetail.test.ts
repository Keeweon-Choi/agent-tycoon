import { beforeEach, describe, expect, it } from 'vitest';

import type { HwSample } from '../../../core/src/messages.js';
import { setLanguage } from '../i18n/index.js';
import {
  capSlots,
  cpuCoreRows,
  cpuFigures,
  degreesText,
  hwBars,
  hwDonuts,
  ramFigures,
} from './hwDetail.js';
import { hwViewModel } from './hwView.js';

beforeEach(() => setLanguage('en'));

// Invented numbers: a WSL host with LibreHardwareMonitor answering.
const host = (extra: Partial<HwSample> = {}): HwSample => ({
  type: 'hwSample',
  stale: false,
  warnings: [],
  cpuUtil: 0.23,
  cpuTempC: 58,
  cpuPowerW: 41.5,
  cpuCoresW: 33.8,
  cpuCoreMaxC: 64,
  cpuCoreAvgC: 55.5,
  cpuBusMhz: 100,
  cpuCores: [
    { name: 'P-Core #1', clockMhz: 4200, tempC: 48, util: 0.12 },
    { name: 'E-Core #1', clockMhz: 3166.4, tempC: 90, util: 0.4 },
    { name: 'E-Core #2' },
  ],
  ramUsedGib: 6,
  ramTotalGib: 16,
  ramDetail: { usedGib: 6, availableGib: 10, cachedGib: 3.5, swapUsedGib: 0.5, swapTotalGib: 2 },
  hostRamUsedGib: 21.5,
  hostRamTotalGib: 48,
  hostRamDetail: {
    usedGib: 21.5,
    availableGib: 26.5,
    util: 0.45,
    virtualUsedGib: 31.5,
    virtualTotalGib: 56,
  },
  disks: [
    { name: 'WSL', view: 'wsl', freeGib: 800, totalGib: 1000, warning: false },
    { name: 'C:', view: 'windows', freeGib: 300, totalGib: 900, warning: false },
    { name: 'D:', view: 'windows', freeGib: 40, totalGib: 2000, warnGib: 200, warning: true },
  ],
  gpus: [
    { name: 'Test GPU Alpha', tempC: 62, hotspotC: 71, vramUsedMib: 5120, vramTotalMib: 8192 },
    { name: 'Test GPU Beta', tempC: 47, vramUsedMib: 1536, vramTotalMib: 12288 },
  ],
  ...extra,
});

describe('donuts and bars', () => {
  it('RAM of the view shown, a VRAM ring per GPU, a ring per disk of the view', () => {
    const wsl = hwDonuts(hwViewModel(host(), 'wsl'));
    expect(wsl.map((d) => d.id)).toEqual([
      'ram',
      'vram:Test GPU Alpha',
      'vram:Test GPU Beta',
      'disk:WSL',
    ]);
    expect(wsl[0]).toMatchObject({ sub: '6/16G', detail: 'ram' });
    expect(wsl[1]).toMatchObject({ label: 'VRAM 1', sub: '5.0/8G', detail: 'gpu:Test GPU Alpha' });
    const windows = hwDonuts(hwViewModel(host(), 'windows'));
    expect(windows.map((d) => d.id)).toEqual([
      'ram',
      'vram:Test GPU Alpha',
      'vram:Test GPU Beta',
      'disk:C:',
      'disk:D:',
    ]);
    expect(windows[0].sub).toBe('21.5/48G');
    expect(windows.find((d) => d.id === 'disk:D:')?.tone).toBe('warn');
  });

  it('one GPU is plain VRAM; a GPU with no VRAM figures has no ring', () => {
    const one = hwDonuts(
      hwViewModel(host({ gpus: [{ name: 'G', vramUsedMib: 1, vramTotalMib: 2 }] }), 'wsl'),
    );
    expect(one.find((d) => d.id.startsWith('vram'))?.label).toBe('VRAM');
    const none = hwDonuts(hwViewModel(host({ gpus: [{ name: 'G', tempC: 40 }] }), 'wsl'));
    expect(none.some((d) => d.id.startsWith('vram'))).toBe(false);
  });

  it('bars: CPU, then each GPU temperature and hotspot; a missing reading has no bar', () => {
    const bars = hwBars(host(), hwViewModel(host(), 'wsl')).filter((b) => !b.blank);
    expect(bars.map((b) => [b.label, b.text, b.detail])).toEqual([
      ['CPU', '58°', 'cpu'],
      ['GPU 1', '62°', 'gpu:Test GPU Alpha'],
      ['Hotspot 1', '71°', 'gpu:Test GPU Alpha'],
      ['GPU 2', '47°', 'gpu:Test GPU Beta'],
    ]);
    // Two cells to a row: the CPU's row and Beta's missing hotspot are blank cells.
    expect(
      hwBars(host(), hwViewModel(host(), 'wsl')).map((b) => (b.blank ? '_' : b.label)),
    ).toEqual(['CPU', '_', 'GPU 1', 'Hotspot 1', 'GPU 2', '_']);
    const hot = hwBars(host({ cpuTempC: 96 }), hwViewModel(host(), 'wsl'));
    expect(hot[0]).toMatchObject({ text: '96° Critical', tone: 'critical' });
    expect(degreesText(null)).toBeNull();
    expect(degreesText(86.4)).toBe('86° Hot');
  });
});

describe('capSlots (the wall board)', () => {
  it('everything that fits; else the last slot is the "+n"', () => {
    expect(capSlots([1, 2, 3, 4], 4)).toEqual({ shown: [1, 2, 3, 4], more: 0 });
    expect(capSlots([1, 2, 3, 4, 5, 6, 7], 4)).toEqual({ shown: [1, 2, 3], more: 4 });
    expect(capSlots([1, 2, 3], null)).toEqual({ shown: [1, 2, 3], more: 0 });
  });
});

describe('CPU detail', () => {
  it('overall figures in order, leaving out what is missing', () => {
    expect(cpuFigures(host()).map((f) => [f.id, f.text])).toEqual([
      ['util', '23%'],
      ['temp', '58°'],
      ['power', '42W'],
      ['coresW', '34W'],
      ['max', '64°'],
      ['avg', '56°'],
      ['bus', '100MHz'],
    ]);
    expect(
      cpuFigures(host({ cpuCoresW: undefined, cpuBusMhz: undefined, cpuCoreMaxC: 96 })).map(
        (f) => f.id,
      ),
    ).toEqual(['util', 'temp', 'power', 'max', 'avg']);
  });

  it('a row per core: clock, temperature, load; a core with nothing keeps its name', () => {
    const { rows, more } = cpuCoreRows(host());
    expect(more).toBe(0);
    expect(rows[0]).toMatchObject({ name: 'P-Core #1', clock: '4200', temp: '48°', load: '12%' });
    expect(rows[1]).toMatchObject({ clock: '3166', tempTone: 'warn', loadFrac: 0.4 });
    expect(rows[2]).toMatchObject({ name: 'E-Core #2', clock: null, temp: null, load: null });
  });

  it('too many cores for the board: the last slot is "+n"', () => {
    const cores = Array.from({ length: 30 }, (_, i) => ({ name: `CPU #${i + 1}` }));
    const { rows, more } = cpuCoreRows(host({ cpuCores: cores }), 21);
    expect([rows.length, more]).toEqual([20, 10]);
  });

  it('no per-core readings (no LHM, an older daemon): no rows', () => {
    expect(cpuCoreRows(host({ cpuCores: undefined })).rows).toEqual([]);
  });
});

describe('RAM detail', () => {
  const figs = (hw: HwSample, view: 'wsl' | 'windows') =>
    ramFigures(hw, view, hwViewModel(hw, view).ram).map((f) => `${f.label}|${f.text}`);

  it('WSL: used, cache, available, swap', () => {
    expect(figs(host(), 'wsl')).toEqual([
      'Used|6/16G',
      'Cache|3.5G',
      'Available|10G',
      'Swap|0.5/2G',
    ]);
  });

  it('Windows: used, available, load, and the virtual memory', () => {
    expect(figs(host(), 'windows')).toEqual([
      'Used|21.5/48G',
      'Available|26.5G',
      'Usage|45%',
      'Virtual memory|31.5/56G',
    ]);
  });

  it('a side with no detail reads as used / total; a Windows-only host uses its LHM figures', () => {
    expect(figs(host({ ramDetail: undefined, hostRamDetail: undefined }), 'wsl')).toEqual([
      'Used|6/16G',
    ]);
    const win = host({ ramDetail: undefined, disks: [{ name: 'C:', freeGib: 1, totalGib: 2 }] });
    expect(figs(win, 'wsl')[0]).toBe('Used|6/16G');
    expect(figs(win, 'wsl')).toContain('Virtual memory|31.5/56G');
  });
});
