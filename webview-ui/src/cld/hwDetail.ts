/**
 * What the hardware views draw as donuts, temperature bars and detail rows, as plain data
 * (pure; the lobby board and the 현황판 HW tab read the same figures).
 */
import type { HwSample } from '../../../core/src/messages.js';
import { t } from '../i18n/index.js';
import { donutFrac, pctText } from './board/board.js';
import { tempTone } from './format.js';
import {
  DETAIL_CPU,
  DETAIL_RAM,
  diskDetail,
  gpuDetail,
  type HwViewKind,
  type HwViewModel,
} from './hwView.js';

export type HwTone = 'warn' | 'critical' | null;

/** One labelled reading, with how full it is (0-1) when that means something. */
export interface HwFigure {
  id: string;
  label: string;
  text: string;
  frac: number | null;
  tone: HwTone;
}

const unit = (x: number) => Math.max(0, Math.min(1, x));

/** "62°", with " Hot" / " Critical" from 85 / 95 degrees; null when there is no reading. */
export function degreesText(c: number | null | undefined): string | null {
  if (c == null) return null;
  const tone = tempTone(c);
  return `${Math.round(c)}°${tone === 'critical' ? t('board.criticalSuffix') : tone === 'warn' ? t('board.hotSuffix') : ''}`;
}

/** The first `slots` items, the last slot becoming "+n" when they do not all fit. */
export function capSlots<T>(
  items: readonly T[],
  slots: number | null,
): { shown: T[]; more: number } {
  if (slots === null || items.length <= slots) return { shown: [...items], more: 0 };
  const keep = Math.max(0, slots - 1);
  return { shown: items.slice(0, keep), more: items.length - keep };
}

// ── The overview: donuts and temperature bars ───────────────

export interface HwDonut {
  id: string;
  label: string;
  /** "21.5/48G" */
  sub: string;
  frac: number | null;
  tone: HwTone;
  /** The full name, for a title. */
  title: string;
  /** The detail a tap opens. */
  detail: string;
}

const gib = (x: number) => String(Math.round(x * 10) / 10);

/** RAM of the view shown, VRAM per GPU, and every disk of the view: one donut each. */
export function hwDonuts(m: HwViewModel): HwDonut[] {
  const out: HwDonut[] = [];
  const { usedGib, totalGib } = m.ram;
  out.push({
    id: 'ram',
    label: 'RAM',
    sub: usedGib != null && totalGib != null ? `${gib(usedGib)}/${gib(totalGib)}G` : '-',
    frac: donutFrac(usedGib, totalGib),
    tone: null,
    title: m.view === 'windows' ? 'Windows RAM' : 'RAM',
    detail: DETAIL_RAM,
  });
  m.gpus.forEach((g, i) => {
    if (g.vramUsedMib == null || g.vramTotalMib == null) return;
    out.push({
      id: `vram:${g.key}`,
      label: m.gpus.length > 1 ? `VRAM ${i + 1}` : 'VRAM',
      sub: `${(g.vramUsedMib / 1024).toFixed(1)}/${Math.round(g.vramTotalMib / 1024)}G`,
      frac: donutFrac(g.vramUsedMib, g.vramTotalMib),
      tone: null,
      title: g.name,
      detail: gpuDetail(g.key),
    });
  });
  for (const d of m.disks)
    out.push({
      id: `disk:${d.key}`,
      label: d.name,
      sub: d.freeGib != null ? `${d.freeGib}G` : '-',
      frac: d.usedFrac,
      tone: d.low ? 'warn' : null,
      title: d.name,
      detail: diskDetail(d.key),
    });
  return out;
}

export interface HwBar {
  id: string;
  /** An empty cell that keeps a GPU's temperature and hotspot on one row. */
  blank?: boolean;
  label: string;
  c: number;
  text: string;
  tone: HwTone;
  title: string;
  detail: string;
}

/**
 * CPU, then each GPU's temperature and hotspot, two cells to a row (the CPU's row and a GPU's
 * missing reading are `blank` cells); a reading it does not have has no bar.
 */
export function hwBars(hw: HwSample, m: HwViewModel): HwBar[] {
  const out: HwBar[] = [];
  const blank = (id: string) =>
    out.push({ id, blank: true, label: '', c: 0, text: '', tone: null, title: '', detail: '' });
  const bar = (
    id: string,
    label: string,
    c: number | null | undefined,
    title: string,
    detail: string,
  ) => {
    if (c == null) return false;
    out.push({ id, label, c, text: degreesText(c)!, tone: tempTone(c), title, detail });
    return true;
  };
  if (bar('cpu', 'CPU', hw.cpuTempC, 'CPU', DETAIL_CPU)) blank('blank:cpu');
  m.gpus.forEach((g, i) => {
    if (g.tempC == null && g.hotspotC == null) return;
    const n = m.gpus.length > 1 ? ` ${i + 1}` : '';
    if (!bar(`gpu:${g.key}`, `GPU${n}`, g.tempC, g.name, gpuDetail(g.key)))
      blank(`blank:gpu:${g.key}`);
    if (!bar(`hot:${g.key}`, `${t('board.hotspot')}${n}`, g.hotspotC, g.name, gpuDetail(g.key)))
      blank(`blank:hot:${g.key}`);
  });
  return out;
}

// ── CPU detail ──────────────────────────────────────────────

/** The CPU's overall figures (usage, temperature, power, the cores' power, max, average, bus). */
export function cpuFigures(hw: HwSample): HwFigure[] {
  const temp = (id: string, label: string, c: number | null | undefined): HwFigure | null =>
    c == null ? null : { id, label, text: degreesText(c)!, frac: unit(c / 100), tone: tempTone(c) };
  const watts = (id: string, label: string, w: number | null | undefined): HwFigure | null =>
    w == null ? null : { id, label, text: `${Math.round(w)}W`, frac: null, tone: null };
  return [
    hw.cpuUtil == null
      ? null
      : {
          id: 'util',
          label: t('format.utilization'),
          text: pctText(hw.cpuUtil),
          frac: unit(hw.cpuUtil),
          tone: null,
        },
    temp('temp', t('format.temp'), hw.cpuTempC),
    watts('power', t('format.power'), hw.cpuPowerW),
    watts('coresW', t('hwDetail.coresPower'), hw.cpuCoresW),
    temp('max', t('hwDetail.coreMax'), hw.cpuCoreMaxC),
    temp('avg', t('hwDetail.coreAvg'), hw.cpuCoreAvgC),
    hw.cpuBusMhz == null
      ? null
      : {
          id: 'bus',
          label: t('hwDetail.bus'),
          text: `${Math.round(hw.cpuBusMhz)}MHz`,
          frac: null,
          tone: null,
        },
  ].filter((f): f is HwFigure => f !== null);
}

export interface HwCoreRow {
  name: string;
  /** MHz, as a number's text. */
  clock: string | null;
  temp: string | null;
  tempTone: HwTone;
  load: string | null;
  loadFrac: number | null;
}

/** One row per core; `slots` bounds how many rows are drawn (the last slot "+n"); null = all. */
export function cpuCoreRows(
  hw: HwSample,
  slots: number | null = null,
): { rows: HwCoreRow[]; more: number } {
  const rows = (hw.cpuCores ?? []).map((c) => ({
    name: c.name,
    clock: c.clockMhz == null ? null : String(Math.round(c.clockMhz)),
    temp: c.tempC == null ? null : `${Math.round(c.tempC)}°`,
    tempTone: c.tempC == null ? null : tempTone(c.tempC),
    load: c.util == null ? null : `${Math.round(c.util * 100)}%`,
    loadFrac: c.util == null ? null : unit(c.util),
  }));
  const { shown, more } = capSlots(rows, slots);
  return { rows: shown, more };
}

// ── RAM detail ──────────────────────────────────────────────

/**
 * The memory of the side shown. WSL (or the only side): used, cache, available, swap from
 * /proc/meminfo. Windows: used, available, load and the virtual memory (commit) from LHM.
 * A side with no detail reads as its used / total alone.
 */
export function ramFigures(hw: HwSample, view: HwViewKind, ram: HwViewModel['ram']): HwFigure[] {
  const g = (id: string, label: string, x: number, of?: number | null): HwFigure => ({
    id,
    label,
    text: of == null ? `${gib(x)}G` : `${gib(x)}/${gib(of)}G`,
    frac: of == null ? null : donutFrac(x, of),
    tone: null,
  });
  const host = view === 'windows' ? hw.hostRamDetail : hw.ramDetail ? null : hw.hostRamDetail;
  const out: Array<HwFigure | null> = [];
  if (host) {
    out.push(
      g('used', t('hwDetail.used'), ram.usedGib ?? host.usedGib, ram.totalGib),
      g('available', t('hwDetail.available'), host.availableGib),
      host.util == null
        ? null
        : {
            id: 'load',
            label: t('format.utilization'),
            text: pctText(host.util),
            frac: unit(host.util),
            tone: null,
          },
      host.virtualUsedGib == null || host.virtualTotalGib == null
        ? null
        : g('virtual', t('hwDetail.virtual'), host.virtualUsedGib, host.virtualTotalGib),
    );
  } else if (view !== 'windows' && hw.ramDetail) {
    const d = hw.ramDetail;
    out.push(
      g('used', t('hwDetail.used'), d.usedGib, ram.totalGib),
      d.cachedGib == null ? null : g('cached', t('hwDetail.cached'), d.cachedGib),
      g('available', t('hwDetail.available'), d.availableGib),
      d.swapUsedGib == null || d.swapTotalGib == null
        ? null
        : g('swap', t('format.swap'), d.swapUsedGib, d.swapTotalGib),
    );
  } else if (ram.usedGib != null)
    out.push(g('used', t('hwDetail.used'), ram.usedGib, ram.totalGib));
  return out.filter((f): f is HwFigure => f !== null);
}
