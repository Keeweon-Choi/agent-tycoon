import type {
  HwGpu,
  HwReadingSource,
  HwSample,
  OfficeOrchestrator,
  SessionProcessState,
  UsageWindow,
} from '../../../core/src/messages.js';
import { t } from '../i18n/index.js';
import { type HwViewKind, hwViewModel } from './hwView.js';

export function timeAgo(value: string | null | undefined, now = Date.now()): string {
  if (!value) return t('format.noRecord');
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return t('format.noRecord');
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return t('format.justNow');
  if (minutes < 60) return t('format.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('format.hoursAgo', { count: hours });
  return t('format.daysAgo', { count: Math.floor(hours / 24) });
}

export function resetCountdown(value: string | null | undefined, now = Date.now()): string {
  if (!value) return t('format.noReset');
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return t('format.noReset');
  const minutes = Math.max(0, Math.ceil((then - now) / 60_000));
  if (minutes === 0) return t('format.resetSoon');
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const duration = [
    days && t('format.days', { count: days }),
    hours && t('format.hours', { count: hours }),
    mins && t('format.minutes', { count: mins }),
  ]
    .filter(Boolean)
    .join(' ');
  return t('format.resetIn', { duration });
}

export function percentTone(pct: number | null | undefined): 'normal' | 'warn' | 'critical' {
  if (pct != null && pct >= 85) return 'critical';
  if (pct != null && pct >= 70) return 'warn';
  return 'normal';
}

export function usageWindowText(
  pct: number | null | undefined,
  isReset: boolean | null | undefined,
): string {
  return isReset ? t('usage.reset') : pct == null ? '—' : `${Math.round(pct)}%`;
}

/** Claude's per-model weekly window label ("F 7d") and tooltip name ("Fable"). */
export const modelTag = (family: string): string => `${family.slice(0, 1).toUpperCase()} 7d`;
export const modelName = (family: string): string =>
  family.slice(0, 1).toUpperCase() + family.slice(1);

/** The folded usage strip's figures for a provider: "5h 1%" and "7d 66%" (then "F 7d 0%" per model)
 *  (rounded; a reset marker when a known reset elapsed), each with its raw percent for the tone. */
export function foldedFigures(
  w: UsageWindow | null | undefined,
): Array<{ text: string; pct: number | null }> {
  return (
    [
      ['5h', w?.fiveHourPct, w?.fiveHourIsReset],
      ['7d', w?.sevenDayPct, w?.sevenDayIsReset],
      ...(w?.models ?? []).map((m) => [modelTag(m.family), m.pct, null] as const),
    ] as const
  ).map(([window, raw, isReset]) => {
    const pct = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    return {
      text: `${window} ${isReset ? t('usage.reset') : pct == null ? '—' : `${Math.round(pct)}%`}`,
      pct,
    };
  });
}

/** The folded usage strip as plain text: "Claude 5h 1% · 7d 66%   Codex 5h 73% · 7d 27%". */
export function foldedUsageText(
  providers: ReadonlyArray<[string, UsageWindow | null | undefined]>,
): string {
  return providers
    .map(
      ([name, w]) =>
        `${name} ${foldedFigures(w)
          .map((f) => f.text)
          .join(' · ')}`,
    )
    .join('   ');
}

export function stateLabel(state: SessionProcessState, busy: boolean | null = null): string {
  if (state === 'running')
    return busy === true
      ? t('format.state.working')
      : busy === false
        ? t('format.state.resting')
        : t('format.state.checking');
  return t('format.state.off');
}

export function isOff(orchestrator: OfficeOrchestrator): boolean {
  return orchestrator.state === 'off';
}

export type OfficePanel = 'status' | 'files' | 'hw' | 'terminal';
/** The 현황판 window's tab strip (UI-C1: jobs and Codex live in the 작업실; 파일 is the window's own
 *  mode, opened by the folder icon). The 터미널 has its own window and icon (T-0077). */
export const desktopTabs: { id: Exclude<OfficePanel, 'terminal' | 'files'> }[] = [
  { id: 'status' },
  { id: 'hw' },
];

export const panelTitle = (panel: OfficePanel): string =>
  panel === 'terminal' ? t('nav.terminal') : t(`nav.tab.${panel}`);

/** T-0030: shown while temperatures are missing and the installer can add a sensor tool. */
export const hwSensorsHint = (): string => t('format.hwSensorsHint');

const SOURCE_LABEL: Record<HwReadingSource, string> = {
  lhm: 'LHM',
  sysfs: 'sysfs',
  'nvidia-smi': 'nvidia-smi',
  os: 'OS',
};

/** A temperature's tone: the display default (ADR-0014, T-0030), 85 °C warn, 95 °C critical. */
export const tempTone = (c: number): 'warn' | 'critical' | null =>
  c >= 95 ? 'critical' : c >= 85 ? 'warn' : null;

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export function hwClock(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} (${t(`settings.weekday.${WEEKDAYS[date.getDay()]}`)}) ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export interface HwRow {
  key: string;
  label: string;
  text: string;
  /** Where the reading came from, as shown. */
  source: string | null;
  /** Display default (ADR-0014): 85 °C warn, 95 °C critical; a disk at or under its own warn line. */
  tone: 'warn' | 'critical' | null;
}

/** The HW panel: each reading with its source; empty readings and empty cards are left out. */
export function hwSections(
  hw: HwSample,
  view: HwViewKind = 'wsl',
): Array<{ title: string; rows: HwRow[]; fold?: 'cpu' | 'ram' }> {
  const source = (key: string) => {
    const s = hw.sources?.[key];
    return s ? (SOURCE_LABEL[s] ?? s) : null;
  };
  const row = (key: string, label: string, text: string | null, tone: HwRow['tone'] = null) =>
    text === null ? null : { key, label, text, source: source(key), tone };
  const temp = (key: 'cpuTempC' | 'gpuTempC' | 'gpuHotspotC', label: string) => {
    const c = hw[key];
    if (c == null) return null;
    return row(key, label, `${c.toFixed(0)} °C`, tempTone(c));
  };
  const fmt = (x: number | null | undefined, f: (x: number) => string) => (x == null ? null : f(x));
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const watts = (x: number) => `${Math.round(x)} W`;
  const pair = (a: number | null | undefined, b: number | null | undefined, unit: string) =>
    a == null || b == null ? null : `${a} / ${b} ${unit}`;
  const model = hwViewModel(hw, view);
  const windows = model.view === 'windows';
  const disks = model.disks.map((d) => {
    const r = row(
      'disks',
      d.name,
      d.usedGib !== null && d.totalGib != null && d.totalGib > 0
        ? `${d.usedGib} / ${d.totalGib} GiB (${Math.round((d.usedGib / d.totalGib) * 100)}%)`
        : fmt(d.freeGib, (x) => t('format.gibLeft', { amount: x })),
    );
    return r && { ...r, key: `disk:${d.name}`, tone: d.low ? ('warn' as const) : null };
  });
  const gpuRows = (g: HwGpu, key: (k: string) => string) => {
    const temp = (c: number | null | undefined, label: string, k: string) =>
      c == null ? null : row(key(k), label, `${c.toFixed(0)} °C`, tempTone(c));
    return [
      temp(g.tempC, t('format.temp'), 'gpuTempC'),
      temp(g.hotspotC, t('format.hotspot'), 'gpuHotspotC'),
      row(key('gpuPowerW'), t('format.power'), fmt(g.powerW, watts)),
      row(key('gpuUtil'), t('format.utilization'), fmt(g.util, pct)),
      row(key('vramUsedMib'), 'VRAM', pair(g.vramUsedMib, g.vramTotalMib, 'MiB')),
    ];
  };
  // One GPU keeps its single card (and the sources of the single-GPU fields); several get a card each.
  const gpuSections =
    hw.gpus && hw.gpus.length > 1
      ? model.gpus.map((g) => ({
          title: `GPU · ${g.key}`,
          rows: gpuRows(g, (k) => `${k}:${g.key}`).map(
            (r) => r && { ...r, source: source('gpus') },
          ),
        }))
      : [{ title: 'GPU', rows: gpuRows(model.gpus[0] ?? { name: 'GPU' }, (k) => k) }];
  const sections = [
    {
      title: 'CPU',
      fold: 'cpu' as const,
      rows: [
        temp('cpuTempC', t('format.temp')),
        row('cpuPowerW', t('format.power'), fmt(hw.cpuPowerW, watts)),
        row('cpuUtil', t('format.utilization'), fmt(hw.cpuUtil, pct)),
      ],
    },
    ...gpuSections,
    {
      title: t('format.memoryDisk'),
      fold: 'ram' as const,
      rows: [
        // Two views: the chosen side's RAM. One view: whatever RAM the sample has.
        ...(model.canToggle
          ? [
              row(
                windows ? 'hostRamUsedGib' : 'ramUsedGib',
                windows ? 'Windows RAM' : 'RAM',
                pair(model.ram.usedGib, model.ram.totalGib, 'GiB'),
              ),
            ]
          : [
              row('ramUsedGib', 'RAM', pair(hw.ramUsedGib, hw.ramTotalGib, 'GiB')),
              row(
                'hostRamUsedGib',
                'Windows RAM',
                pair(hw.hostRamUsedGib, hw.hostRamTotalGib, 'GiB'),
              ),
            ]),
        ...(windows
          ? []
          : [
              row(
                'swapUsedGib',
                t('format.swap'),
                fmt(hw.swapUsedGib, (x) => `${x} GiB`),
              ),
            ]),
        ...disks,
      ],
    },
  ];
  return sections
    .map((s) => ({ ...s, rows: s.rows.filter((r): r is HwRow => r !== null) }))
    .filter((s) => s.rows.length > 0);
}
