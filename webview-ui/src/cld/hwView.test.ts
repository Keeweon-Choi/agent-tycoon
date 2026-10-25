import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HwSample } from '../../../core/src/messages.js';
import { setLanguage } from '../i18n/index.js';
import { hwSections } from './format.js';
import {
  getHwPrefs,
  HW_PREFS_KEY,
  hwViewModel,
  openDetail,
  pickedItem,
  resetHwPrefs,
  setHwPrefs,
} from './hwView.js';

beforeEach(() => {
  setLanguage('en');
  resetHwPrefs();
});

// Invented numbers: a WSL host with LibreHardwareMonitor answering.
const wslHost = (extra: Partial<HwSample> = {}): HwSample => ({
  type: 'hwSample',
  stale: false,
  warnings: [],
  ramUsedGib: 3.2,
  ramTotalGib: 16,
  hostRamUsedGib: 21.5,
  hostRamTotalGib: 48,
  disks: [
    { name: 'WSL', view: 'wsl', freeGib: 800, totalGib: 1000, warning: false },
    { name: 'C:', view: 'windows', freeGib: 300, totalGib: 900, warning: false },
    { name: 'D:', view: 'windows', freeGib: 40, totalGib: 2000, warnGib: 200, warning: true },
    { name: 'E:', view: 'windows', freeGib: 1500, totalGib: 3700, warning: false },
  ],
  gpus: [
    { name: 'Test GPU Alpha', tempC: 62, hotspotC: 71, powerW: 138.5, util: 0.64 },
    { name: 'Test GPU Beta', tempC: 47, util: 0.09, vramUsedMib: 1536, vramTotalMib: 12288 },
  ],
  ...extra,
});

describe('hwViewModel', () => {
  it('WSL host with LHM: the toggle exists; the WSL view has the distro RAM and root disk', () => {
    const m = hwViewModel(wslHost(), 'wsl');
    expect(m.canToggle).toBe(true);
    expect(m.view).toBe('wsl');
    expect(m.ram).toEqual({ usedGib: 3.2, totalGib: 16 });
    expect(m.disks.map((d) => d.name)).toEqual(['WSL']);
    expect(m.disks[0]).toMatchObject({ usedGib: 200, usedFrac: 0.2, low: false });
  });

  it('the Windows view has the host RAM and the drives, the low one flagged', () => {
    const m = hwViewModel(wslHost(), 'windows');
    expect(m.view).toBe('windows');
    expect(m.ram).toEqual({ usedGib: 21.5, totalGib: 48 });
    expect(m.disks.map((d) => [d.name, d.low])).toEqual([
      ['C:', false],
      ['D:', true],
      ['E:', false],
    ]);
  });

  it('LHM down: OS view only, no toggle, every disk the host reported, whatever view was asked', () => {
    const m = hwViewModel(
      wslHost({ hostRamUsedGib: undefined, hostRamTotalGib: undefined, gpus: undefined }),
      'windows',
    );
    expect(m.canToggle).toBe(false);
    expect(m.view).toBe('wsl');
    expect(m.ram).toEqual({ usedGib: 3.2, totalGib: 16 });
    expect(m.disks.map((d) => d.name)).toEqual(['WSL', 'C:', 'D:', 'E:']);
    expect(m.gpus).toEqual([]);
  });

  it('Linux, macOS and Windows hosts: disks carry no view, so there is no toggle', () => {
    const m = hwViewModel(
      wslHost({ disks: [{ name: '~', freeGib: 100, totalGib: 500 }], hostRamTotalGib: 32 }),
      'windows',
    );
    expect(m.canToggle).toBe(false);
    expect(m.disks.map((d) => d.name)).toEqual(['~']);
  });

  it('the single-GPU fields make a one-card list for older daemons; two cards of one name stay apart', () => {
    const old = hwViewModel(
      wslHost({ gpus: undefined, gpuTempC: 55, gpuUtil: 0.5, vramUsedMib: 100, vramTotalMib: 200 }),
      'wsl',
    );
    expect(old.gpus).toMatchObject([{ key: 'GPU', tempC: 55, util: 0.5, vramTotalMib: 200 }]);
    const twins = hwViewModel(wslHost({ gpus: [{ name: 'Same' }, { name: 'Same' }] }), 'wsl');
    expect(twins.gpus.map((g) => g.key)).toEqual(['Same', 'Same #2']);
  });

  it('a disk without a reading is left out; an unknown size still lists the free space', () => {
    const m = hwViewModel(
      wslHost({
        disks: [
          { name: 'X:', freeGib: null },
          { name: 'Y:', freeGib: 5 },
        ],
      }),
      'wsl',
    );
    expect(m.disks).toMatchObject([{ name: 'Y:', usedGib: null, usedFrac: null }]);
  });
});

describe('pickedItem', () => {
  const items = hwViewModel(wslHost(), 'wsl').gpus;
  it('the picked one is shown alone; none, or one that is gone, shows all', () => {
    expect(pickedItem(items, 'Test GPU Beta')?.name).toBe('Test GPU Beta');
    expect(pickedItem(items, null)).toBeNull();
    expect(pickedItem(items, 'Removed GPU')).toBeNull();
  });
});

describe('openDetail', () => {
  const m = hwViewModel(wslHost(), 'windows');
  it('CPU and RAM always exist; a GPU or disk only while it is there', () => {
    expect(openDetail(m, 'cpu')).toEqual({ kind: 'cpu' });
    expect(openDetail(m, 'ram')).toEqual({ kind: 'ram' });
    expect(openDetail(m, 'gpu:Test GPU Beta')).toMatchObject({
      kind: 'gpu',
      gpu: { name: 'Test GPU Beta' },
    });
    expect(openDetail(m, 'disk:D:')).toMatchObject({ kind: 'disk', disk: { name: 'D:' } });
  });

  it('the picked item gone (a disk of the other side after the toggle, a removed GPU): all shown', () => {
    const wsl = hwViewModel(wslHost(), 'wsl');
    expect(openDetail(wsl, 'disk:D:')).toBeNull();
    expect(openDetail(m, 'gpu:Removed')).toBeNull();
    expect(openDetail(m, 'nonsense')).toBeNull();
    expect(openDetail(m, null)).toBeNull();
  });
});

describe('the remembered detail', () => {
  const stored = (v: unknown) => {
    const data = new Map<string, string>([[HW_PREFS_KEY, JSON.stringify(v)]]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, x: string) => void data.set(k, x),
    });
    return data;
  };
  afterEach(() => vi.unstubAllGlobals());
  const read = getHwPrefs;

  it("one detail at a time, saved with the view; the earlier release's GPU pick is read as a detail", () => {
    stored({ view: 'windows', gpu: 'Test GPU Beta', disk: 'D:' });
    resetHwPrefs();
    expect(read()).toEqual({ view: 'windows', detail: 'gpu:Test GPU Beta' });
    const data = stored({ view: 'wsl', detail: 'cpu' });
    resetHwPrefs();
    expect(read().detail).toBe('cpu');
    setHwPrefs({ detail: 'ram' });
    expect(JSON.parse(data.get(HW_PREFS_KEY)!)).toEqual({ view: 'wsl', detail: 'ram' });
  });
});

describe('HW tab rows follow the view', () => {
  const rows = (hw: HwSample, view: 'wsl' | 'windows') =>
    hwSections(hw, view)
      .flatMap((s) => s.rows.map((r) => `${s.title}|${r.label}|${r.text}`))
      .join('\n');

  it('WSL view: the distro RAM and its disk; Windows view: the host RAM and the drives', () => {
    const wsl = rows(wslHost(), 'wsl');
    expect(wsl).toContain('|RAM|3.2 / 16 GiB');
    expect(wsl).toContain('|WSL|200 / 1000 GiB (20%)');
    expect(wsl).not.toContain('Windows RAM');
    expect(wsl).not.toContain('|C:|');
    const windows = rows(wslHost(), 'windows');
    expect(windows).toContain('|Windows RAM|21.5 / 48 GiB');
    expect(windows).toContain('|D:|1960 / 2000 GiB (98%)');
    expect(windows).not.toContain('|WSL|');
  });

  it('the CPU and memory cards carry the fold the tab hangs their detail on', () => {
    const folds = hwSections(wslHost({ cpuTempC: 50 }), 'wsl').map((s) => [s.title, s.fold]);
    expect(folds).toContainEqual(['CPU', 'cpu']);
    expect(folds).toContainEqual(['Memory · disks', 'ram']);
  });

  it('several GPUs get a card each, all of them regardless of the view', () => {
    const titles = hwSections(wslHost(), 'windows').map((s) => s.title);
    expect(titles).toEqual(['GPU · Test GPU Alpha', 'GPU · Test GPU Beta', 'Memory · disks']);
  });
});

describe('gpu fallbacks', () => {
  it('nvidia-smi VRAM in the single fields fills the first GPU; same-named GPUs get distinct cards', () => {
    const twins = wslHost({
      gpus: [
        { name: 'Test GPU', tempC: 50 },
        { name: 'Test GPU', tempC: 40 },
      ],
      vramUsedMib: 900,
      vramTotalMib: 8192,
    });
    const [first, second] = hwViewModel(twins, 'wsl').gpus;
    expect(first).toMatchObject({ vramUsedMib: 900, vramTotalMib: 8192 });
    expect(second.vramUsedMib).toBeUndefined();
    const titles = hwSections(twins)
      .map((s) => s.title)
      .filter((x) => x.startsWith('GPU'));
    expect(new Set(titles).size).toBe(titles.length);
  });
});
