import type {
  HwGpu,
  HwReadingSource,
  HwSample,
  OfficeOrchestrator,
  SessionProcessState,
  UsageLimitWindow,
  UsageProvider,
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
  return isReset ? t('usage.unknownShort') : pct == null ? '—' : `${Math.round(pct)}%`;
}

/** A reset time as a local "11-06 20:00". */
function resetClock(resetAt: string | null | undefined): string | null {
  const at = resetAt ? new Date(resetAt) : null;
  if (!at || !Number.isFinite(at.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * MOBILE-QUEST: one window's reading both ways round, so the gauge's "남음 39%" and `agty status`'s weekPct 61
 * (the used share) read as one figure: "주간 61% 사용 · 남음 39% · 11-06 20:00 초기화". A passed reset or no figure says unknown.
 */
export function usageWindowTitle(w: UsageLimitWindow & { title?: string | null }): string {
  const window = w.title
    ? `${w.title} ${t('usage.win.7d')}`
    : w.id === '5h' || w.id === '7d'
      ? t(`usage.win.${w.id}`)
      : w.id;
  if (w.isReset) return t('usage.resetPassed', { window });
  if (typeof w.pct !== 'number' || !Number.isFinite(w.pct)) return t('usage.windowUnknown', { window });
  const used = Math.max(0, Math.min(100, Math.round(w.pct)));
  const time = resetClock(w.resetAt);
  return [
    t('usage.usedLeft', { window, used, left: 100 - used }),
    time ? t('usage.resetAt', { time }) : t('format.noReset'),
  ].join(' · ');
}

/** A per-model weekly window's label ("F 7d") and tooltip name ("Fable"). */
export const modelTag = (family: string): string => `${family.slice(0, 1).toUpperCase()} 7d`;
export const modelName = (family: string): string =>
  family.slice(0, 1).toUpperCase() + family.slice(1);

/** One reported window as the usage strip shows it: the provider's own window id, never a fixed slot. */
export const usageWindows = (
  p: UsageProvider,
): Array<UsageLimitWindow & { label: string; title: string | null }> => [
  ...p.windows.map((w) => ({ ...w, label: w.id, title: null })),
  ...(p.models ?? []).map((m) => ({
    id: `model:${m.family}`,
    pct: m.pct,
    resetAt: m.reset ?? null,
    label: modelTag(m.family),
    title: modelName(m.family),
  })),
];

/** The folded usage strip's figures for a provider: only the windows it reported ("7d 3%", "5h 77%",
 *  then "F 7d 0%" per model), rounded, a reset marker when a known reset elapsed, each with its raw percent for the tone. */
export function foldedFigures(p: UsageProvider): Array<{ text: string; pct: number | null }> {
  return usageWindows(p).map((w) => ({
    text: `${w.label} ${usageWindowText(w.pct, w.isReset)}`,
    pct: typeof w.pct === 'number' && Number.isFinite(w.pct) ? w.pct : null,
  }));
}

/** The folded usage strip as plain text: "Claude 7d 3%   Codex 5h 77% · 7d 19%". */
export function foldedUsageText(providers: ReadonlyArray<UsageProvider>): string {
  return providers
    .map(
      (p) =>
        `${p.name} ${
          foldedFigures(p)
            .map((f) => f.text)
            .join(' · ') || t('usage.none')
        }`,
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

export type OfficePanel = 'status' | 'dev' | 'files' | 'terminal';
/** The 현황판 window's tab strip (UI-DASH, owner 11-01 14:54: the orchestrators' and the development
 *  status in one dashboard, the old 작업실 being its 개발 tab; 파일 is the window's own mode, opened by
 *  the folder icon). The 터미널 has its own window and icon (T-0077). The HW tab is gone
 *  (building-a-1104, owner 11-04 20:28): the lobby board's full H/W screen reads better. */
export const desktopTabs: { id: Exclude<OfficePanel, 'terminal' | 'files'> }[] = [
  { id: 'status' },
  { id: 'dev' },
];

/** A tab's name in the strip. */
export const officeTabLabel = (tab: Exclude<OfficePanel, 'terminal'>): string =>
  tab === 'status' || tab === 'dev' ? t(`dash.tab.${tab}`) : t(`nav.tab.${tab}`);

/** A page's title: the dashboard is 현황판 on both its sections. */
export const panelTitle = (panel: OfficePanel): string =>
  panel === 'terminal' ? t('nav.terminal') : t(`nav.tab.${panel === 'dev' ? 'status' : panel}`);

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
