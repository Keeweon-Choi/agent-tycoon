import { beforeEach, describe, expect, it } from 'vitest';

import type { HwSample } from '../../../core/src/messages.js';
import { setLanguage, t } from '../i18n/index.js';
import {
  desktopTabs,
  foldedUsageText,
  hwClock,
  hwSections,
  percentTone,
  resetCountdown,
  stateLabel,
  timeAgo,
  usageWindowText,
} from './format.js';

beforeEach(() => setLanguage('ko'));

const sample = (extra: Partial<HwSample>): HwSample => ({
  type: 'hwSample',
  stale: false,
  disks: [],
  warnings: [],
  ...extra,
});
const show = (hw: HwSample) =>
  hwSections(hw).map((s) => [
    s.title,
    s.rows.map((r) => `${r.label} ${r.text}${r.source ? ` · ${r.source}` : ''}`),
  ]);

describe('HW panel rows (T-0030)', () => {
  it('formats Korean weekdays and a one-second clock tick', () => {
    const a = new Date(2026, 9, 22, 12, 19, 5);
    expect(hwClock(a)).toBe('2026-10-22 (\ubaa9) 12:19:05');
    expect(hwClock(new Date(a.getTime() + 1000))).toBe('2026-10-22 (\ubaa9) 12:19:06');
  });

  it('shows four complete drives and Windows RAM without question marks', () => {
    const hw = sample({
      ramUsedGib: 12,
      ramTotalGib: 32,
      hostRamUsedGib: 34.6,
      hostRamTotalGib: 44.5,
      disks: [
        { name: 'WSL', freeGib: 100, totalGib: 200, warning: false },
        { name: 'C:', freeGib: 150, totalGib: 500, warning: false },
        { name: 'D:', freeGib: 100, totalGib: 1000, warning: true },
        { name: 'E:', freeGib: 300, totalGib: 600, warning: false },
      ],
    });
    const rows = hwSections(hw).find(
      (s) => s.title === '\uba54\ubaa8\ub9ac · \ub514\uc2a4\ud06c',
    )!.rows;
    expect(rows.map((r) => r.label)).toEqual(['RAM', 'Windows RAM', 'WSL', 'C:', 'D:', 'E:']);
    expect(rows.map((r) => r.text).join(' ')).not.toContain('?');
    expect(rows.find((r) => r.label === 'D:')?.tone).toBe('warn');
  });
  it('names the source of each reading and leaves out what was not measured', () => {
    const hw = sample({
      cpuTempC: 54.4,
      cpuUtil: 0.11,
      ramUsedGib: 12.7,
      ramTotalGib: 31.3,
      disks: [{ name: '~', freeGib: 887, warnGib: null }],
      sources: { cpuTempC: 'lhm', cpuUtil: 'os', ramUsedGib: 'os', disks: 'os' },
    });
    expect(show(hw)).toEqual([
      ['CPU', ['\uc628\ub3c4 54 °C · LHM', '\uc0ac\uc6a9\ub960 11% · OS']],
      [
        '\uba54\ubaa8\ub9ac · \ub514\uc2a4\ud06c',
        ['RAM 12.7 / 31.3 GiB · OS', '~ 887 GiB \ub0a8\uc74c · OS'],
      ],
    ]);
  });

  it('a GPU card only with GPU readings; utilizations are fractions; each reading names its source', () => {
    const hw = sample({
      gpuTempC: 48,
      gpuHotspotC: 96,
      gpuUtil: 0.37,
      vramUsedMib: 1596,
      vramTotalMib: 8192,
      sources: { gpuTempC: 'lhm', gpuHotspotC: 'lhm', gpuUtil: 'lhm', vramUsedMib: 'lhm' },
    });
    const [gpu] = hwSections(hw);
    expect(gpu.title).toBe('GPU');
    expect(gpu.rows.map((r) => [r.text, r.tone])).toEqual([
      ['48 °C', null],
      ['96 °C', 'critical'],
      ['37%', null],
      ['1596 / 8192 MiB', null],
    ]);
    expect(gpu.rows.every((r) => r.source === 'LHM')).toBe(true);
    expect(hwSections(sample({}))).toEqual([]);
  });

  it('a disk at or under its own warn line is flagged; one without a reading is left out', () => {
    const rows = hwSections(
      sample({
        disks: [
          { name: 'D:', freeGib: 100, warnGib: 186 },
          { name: 'E:', freeGib: 1731, warnGib: null },
          { name: 'F:', freeGib: null },
        ],
      }),
    )[0].rows;
    expect(rows.map((r) => [r.label, r.tone])).toEqual([
      ['D:', 'warn'],
      ['E:', null],
    ]);
  });
});

const now = Date.parse('2026-10-21T10:00:00Z');
describe('formatters', () => {
  it('formats elapsed time and missing dates', () => {
    expect(timeAgo('2026-10-21T09:48:00Z', now)).toBe('12\ubd84 \uc804');
    expect(timeAgo('2026-10-20T08:00:00Z', now)).toBe('1\uc77c \uc804');
    expect(timeAgo(null, now)).toBe('\uae30\ub85d \uc5c6\uc74c');
  });
  it('formats limit countdowns', () => {
    expect(resetCountdown('2026-10-21T12:13:00Z', now)).toBe(
      '2\uc2dc\uac04 13\ubd84 \ub4a4 \ucd08\uae30\ud654',
    );
    expect(resetCountdown('2026-10-21T09:00:00Z', now)).toBe('\uace7 \ucd08\uae30\ud654');
    expect(resetCountdown('2026-10-21T10:00:30Z', now)).toBe('1\ubd84 \ub4a4 \ucd08\uae30\ud654');
    expect(resetCountdown('2026-10-23T11:05:00Z', now)).toBe(
      '2\uc77c 1\uc2dc\uac04 5\ubd84 \ub4a4 \ucd08\uae30\ud654',
    );
  });
  it('uses exact percentage thresholds', () => {
    expect(percentTone(69.9)).toBe('normal');
    expect(percentTone(70)).toBe('warn');
    expect(percentTone(85)).toBe('critical');
  });
  it("folds usage to each provider's two figures", () => {
    expect(
      foldedUsageText([
        ['Claude', { fiveHourPct: 1, sevenDayPct: 66 }],
        ['Codex', { fiveHourPct: 72.6, sevenDayPct: 27.2 }],
      ]),
    ).toBe('Claude 5h 1% · 7d 66%   Codex 5h 73% · 7d 27%');
    expect(
      foldedUsageText([
        ['Claude', { fiveHourPct: Number.NaN }],
        ['Codex', null],
      ]),
    ).toBe('Claude 5h — · 7d —   Codex 5h — · 7d —');
  });
  it('adds the per-model weekly windows right after 7d', () => {
    expect(
      foldedUsageText([
        [
          'Claude',
          { fiveHourPct: 1, sevenDayPct: 66, models: [{ family: 'fable', pct: 0, reset: null }] },
        ],
      ]),
    ).toBe('Claude 5h 1% · 7d 66% · F 7d 0%');
  });
  it('renders a reset window as its reset label, never a made-up percentage', () => {
    expect(usageWindowText(73, true)).toBe(t('usage.reset'));
    expect(usageWindowText(73, true)).not.toContain('0%');
    expect(usageWindowText(73, true)).not.toContain('73%');
  });
  it('labels process and activity states in Korean', () => {
    expect(stateLabel('running', true)).toBe('\uc77c\ud558\ub294 \uc911');
    expect(stateLabel('running', false)).toBe('\uc26c\ub294 \uc911');
    expect(stateLabel('running', null)).toBe('\uc0c1\ud0dc \ud655\uc778 \uc911');
    expect(stateLabel('off')).toBe('\uaebc\uc9d0');
  });
});

it('UI-C1: the status board window\'s tab strip is status board and HW; files is the folder icon\'s mode', () => {
  expect(desktopTabs.map((tab) => tab.id)).toEqual(['status', 'hw']);
});
