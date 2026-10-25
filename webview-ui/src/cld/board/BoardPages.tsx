/**
 * The board's three pages (T-0046), the same on the lobby wall and in the
 * full view: sizes are in em (the caller sets the font size), so the board
 * scales with the camera; charts are canvases drawn at device-pixel size.
 */
import { memo, useContext, useEffect, useRef, useState } from 'react';

import type { GpuTicket, HwSample } from '../../../../core/src/messages.js';
import {
  ACTIVITY_RING_COLORS,
  BOARD_AREA_ALPHA,
  BOARD_COLORS,
  BOARD_HW_CORE_COLS,
  BOARD_HW_CORE_ROWS,
  BOARD_HW_MINI_BARS,
  BOARD_HW_MINI_DONUTS,
  BOARD_PROJECT_ROWS,
} from '../../constants.js';
import { t, useLanguage } from '../../i18n/index.js';
import { getCharacterSprites } from '../../office/sprites/spriteData.js';
import type { ToolActivity } from '../../office/types.js';
import { Direction } from '../../office/types.js';
import { useEngineStore } from '../engineStore.js';
import { ringWord } from '../ez/visuals.js';
import { percentTone, tempTone } from '../format.js';
import {
  capSlots,
  cpuCoreRows,
  cpuFigures,
  degreesText,
  hwBars,
  type HwDonut,
  hwDonuts,
  type HwFigure,
  ramFigures,
} from '../hwDetail.js';
import {
  DETAIL_CPU,
  gpuDetail,
  type HwOpen,
  type HwViewModel,
  hwViewModel,
  openDetail,
  setHwPrefs,
  useHwPrefs,
} from '../hwView.js';
import type { CldSnapshot } from '../officeStore.js';
import { capRows } from '../temps.js';
import {
  BOARD_PAGES,
  type BoardPage,
  donutArc,
  donutFrac,
  endWords,
  moreText,
  pageTitle,
  pctText,
  projectRows,
  recentEnds,
  sinceText,
  tickerItems,
  ticketText,
  vramText,
} from './board.js';
import { type BoardMode, BoardModeContext } from './boardMode.js';
import { hwHistory, type HwPoint, lineSegments } from './hwHistory.js';

/** A character's look, for the GPU line (its project's orchestrator, or a stand-in). */
export type LookOf = (project: string) => { palette: number; hueShift: number };

export interface BoardViewProps {
  snap: CldSnapshot;
  agentTools: Record<number, ToolActivity[]>;
  page: BoardPage;
  onPage: (page: BoardPage) => void;
  /** Whole seconds: the clock the page's "3분 전" texts read. */
  nowSec: number;
  lookOf: LookOf;
  /** Too small or off the camera: show the last frame, change nothing. */
  frozen: boolean;
}

/** The board: page tabs and the page. Frozen, it keeps its last frame. */
export const BoardView = memo(
  function BoardView({ snap, agentTools, page, onPage, nowSec, lookOf }: BoardViewProps) {
    useLanguage();
    const now = nowSec * 1000;
    return (
      <>
        <div className="led-head" role="tablist" aria-label={t('board.label')}>
          {BOARD_PAGES.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={p === page}
              className="led-tab"
              data-testid={`board-tab-${p}`}
              onClick={(e) => {
                e.stopPropagation();
                onPage(p);
              }}
            >
              {pageTitle(p)}
            </button>
          ))}
          <span className="led-clock" aria-hidden="true">
            {new Date(now).toTimeString().slice(0, 5)}
          </span>
        </div>
        <div className={`led-body led-page-${page}`} data-testid="board-page" data-page={page}>
          {page === 'projects' && <ProjectsPage snap={snap} agentTools={agentTools} now={now} />}
          {page === 'hw' && <HwPage snap={snap} />}
          {page === 'gpu' && <GpuPage snap={snap} now={now} lookOf={lookOf} />}
        </div>
        <Ticker items={tickerItems(snap.events, now)} />
      </>
    );
  },
  (a, b) =>
    b.frozen ||
    (a.snap === b.snap &&
      a.agentTools === b.agentTools &&
      a.page === b.page &&
      a.nowSec === b.nowSec &&
      a.lookOf === b.lookOf),
);

// ── 프로젝트 ─────────────────────────────────────────────────

function ProjectsPage({
  snap,
  agentTools,
  now,
}: {
  snap: CldSnapshot;
  agentTools: Record<number, ToolActivity[]>;
  now: number;
}) {
  const engineProjects = useEngineStore().state?.projects;
  const workers = new Set((engineProjects ?? []).filter((p) => p.role).map((p) => p.name));
  const { shown, more } = projectRows(snap, agentTools, now, BOARD_PROJECT_ROWS, workers);
  if (!shown.length) return <p className="led-empty">{t('board.noProjects')}</p>;
  return (
    <ol className="led-rows">
      <li className="led-row led-row-head" aria-hidden="true">
        <span>{t('board.page.projects')}</span>
        <span>{t('board.column.status')}</span>
        <span>{t('board.column.fatigue')}</span>
        <span>{t('board.column.work')}</span>
        <span>{t('board.column.recent')}</span>
      </li>
      {shown.map((r) => {
        const tone = r.context === null ? null : percentTone(r.context);
        return (
          <li key={r.name} className="led-row" data-testid="board-project" data-ring={r.ring}>
            <span className="led-name">
              <Dot color={ACTIVITY_RING_COLORS[r.ring].rim} blink={r.ring} />
              {r.name}
            </span>
            <span className="led-state">{ringWord(r.ring)}</span>
            <span
              className={`led-fatigue led-tone-${tone ?? 'none'}`}
              data-label={t('board.column.fatigue')}
            >
              {r.context === null ? (
                <span className="led-muted">-</span>
              ) : (
                <>
                  <span className="led-meter" aria-hidden="true">
                    <i style={{ width: `${Math.min(100, r.context)}%` }} />
                  </span>
                  {r.context}%
                </>
              )}
            </span>
            <span
              className="led-counts"
              title={r.work ?? undefined}
              data-label={t('board.column.work')}
            >
              {r.work ?? <span className="led-muted">-</span>}
            </span>
            <span className="led-last">{r.last ?? ''}</span>
          </li>
        );
      })}
      {more > 0 && (
        <li className="led-more" data-testid="board-more">
          {moreText(more)}
        </li>
      )}
    </ol>
  );
}

/** The bottom line: the latest news, scrolling by like a real LED sign. */
function Ticker({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="led-ticker" aria-label={t('board.recentNews')}>
      <span className="led-ticker-run">{items.join('   ◆   ')}</span>
    </div>
  );
}

function Dot({ color, blink }: { color: string; blink?: string }) {
  return <span className={`led-dot led-blink-${blink ?? 'none'}`} style={{ background: color }} />;
}

// ── H/W ──────────────────────────────────────────────────────

function HwPage({ snap }: { snap: CldSnapshot }) {
  const hw = snap.hwSample;
  const prefs = useHwPrefs();
  const mode = useContext(BoardModeContext);
  if (!hw) return <p className="led-empty">{t('board.waitingHardware')}</p>;
  const points = hwHistory.toArray();
  const m = hwViewModel(hw, prefs.view);
  const open = openDetail(m, prefs.detail);
  const openCpu = () => setHwPrefs({ detail: DETAIL_CPU });
  const firstGpu = m.gpus[0];
  // The view matters to RAM and disks only.
  const toggle = m.canToggle && (open === null || open.kind === 'ram' || open.kind === 'disk');
  return (
    <div className="led-hw" data-detail={open?.kind}>
      <div className="led-graphs">
        <Graph
          label="CPU"
          color={BOARD_COLORS.cpu}
          points={points}
          k="cpu"
          value={hw.cpuUtil}
          onOpen={openCpu}
        />
        <Graph
          label="GPU"
          color={BOARD_COLORS.gpu}
          points={points}
          k="gpu"
          value={hw.gpuUtil}
          onOpen={firstGpu ? () => setHwPrefs({ detail: gpuDetail(firstGpu.key) }) : undefined}
        />
      </div>
      <div className="led-side">
        {toggle && (
          <button
            type="button"
            className="led-hw-toggle"
            data-testid="board-hw-toggle"
            data-view={m.view}
            aria-label={t('board.viewToggle')}
            title={t('board.viewToggle')}
            onClick={() => setHwPrefs({ view: m.view === 'wsl' ? 'windows' : 'wsl' })}
          >
            <b className={m.view === 'wsl' ? 'led-on' : ''}>WSL</b>
            {' ↔ '}
            <b className={m.view === 'windows' ? 'led-on' : ''}>Windows</b>
          </button>
        )}
        {open ? (
          <HwOpenDetail hw={hw} m={m} open={open} mode={mode} />
        ) : (
          <HwOverview hw={hw} m={m} mode={mode} />
        )}
        {hw.stale && <p className="led-warn">{t('hardware.stale')}</p>}
      </div>
    </div>
  );
}

/** The usage donuts, then the temperature bars; each opens its item's detail. */
function HwOverview({ hw, m, mode }: { hw: HwSample; m: HwViewModel; mode: BoardMode }) {
  const mini = mode === 'mini';
  const donuts = capSlots(hwDonuts(m), mini ? BOARD_HW_MINI_DONUTS : null);
  const bars = capSlots(hwBars(hw, m), mini ? BOARD_HW_MINI_BARS : null);
  return (
    <>
      <div className="led-donuts" role="list" aria-label={t('board.donuts')}>
        {donuts.shown.map((d) => (
          <Donut key={d.id} d={d} />
        ))}
        {donuts.more > 0 && (
          <More count={donuts.more} className="led-donut" testId="board-donut-more" />
        )}
      </div>
      <div className="led-temps" role="list" aria-label={t('board.temperatures')}>
        {bars.shown.map((b) =>
          b.blank ? (
            <span key={b.id} className="led-temp-blank" aria-hidden="true" />
          ) : (
            <button
              key={b.id}
              type="button"
              role="listitem"
              className={`led-temp led-tone-${b.tone ?? 'ok'}`}
              data-testid="board-hw-temp"
              data-id={b.id}
              title={t('board.showOne', { name: b.title })}
              onClick={() => setHwPrefs({ detail: b.detail })}
            >
              <span className="led-temp-label">{b.label}</span>
              <span className="led-meter" aria-hidden="true">
                <i style={{ width: `${Math.max(0, Math.min(100, b.c))}%` }} />
              </span>
              <span className="led-temp-value">{b.text}</span>
            </button>
          ),
        )}
        {bars.more > 0 && <More count={bars.more} className="led-temp" testId="board-temp-more" />}
        {!bars.shown.length && <p className="led-muted">{t('hardware.noTemperature')}</p>}
      </div>
    </>
  );
}

/** "+3": what did not fit on the wall's board (the full view shows it). */
function More({ count, className, testId }: { count: number; className: string; testId: string }) {
  return (
    <span
      role="listitem"
      className={`${className} led-slot-more led-muted`}
      data-testid={testId}
      aria-label={t('board.moreItems', { count })}
    >
      +{count}
    </span>
  );
}

/** The one detail open: what the item has, with its name as the way back to all of them. */
function HwOpenDetail({
  hw,
  m,
  open,
  mode,
}: {
  hw: HwSample;
  m: HwViewModel;
  open: HwOpen;
  mode: BoardMode;
}) {
  const back = () => setHwPrefs({ detail: null });
  const figure = (f: HwFigure) => (
    <HwDetail key={f.id} label={f.label} frac={f.frac} tone={f.tone} text={f.text} />
  );
  if (open.kind === 'cpu') {
    const cores = cpuCoreRows(
      hw,
      mode === 'narrow' ? null : BOARD_HW_CORE_ROWS * BOARD_HW_CORE_COLS,
    );
    return (
      <HwPicked name="CPU" kind="cpu" onBack={back}>
        <div className="led-figures">
          {cpuFigures(hw).map((f) => (
            <span key={f.id} className={`led-figure led-tone-${f.tone ?? 'ok'}`}>
              <span className="led-muted">{f.label}</span> {f.text}
            </span>
          ))}
        </div>
        {cores.rows.length ? (
          <div
            className="led-cores"
            role="list"
            data-testid="board-hw-cores"
            style={
              {
                '--led-cols': Math.min(
                  BOARD_HW_CORE_COLS,
                  Math.ceil(cores.rows.length / BOARD_HW_CORE_ROWS),
                ),
                '--led-rows': Math.ceil(
                  cores.rows.length /
                    Math.min(BOARD_HW_CORE_COLS, Math.ceil(cores.rows.length / BOARD_HW_CORE_ROWS)),
                ),
              } as React.CSSProperties
            }
          >
            {cores.rows.map((c) => (
              <div
                key={c.name}
                role="listitem"
                className="led-core"
                data-testid="board-hw-core"
                style={{ '--load': Math.round((c.loadFrac ?? 0) * 100) } as React.CSSProperties}
              >
                <span className="led-hwline-name">{c.name}</span>
                <span>{c.clock === null ? '' : `${c.clock}MHz`}</span>
                <span className={`led-tone-${c.tempTone ?? 'ok'}`}>{c.temp ?? ''}</span>
                <span>{c.load ?? ''}</span>
              </div>
            ))}
            {cores.more > 0 && (
              <More count={cores.more} className="led-core" testId="board-core-more" />
            )}
          </div>
        ) : (
          <p className="led-muted" data-testid="board-hw-needs-lhm">
            {t('hwDetail.needsLhm')}
          </p>
        )}
      </HwPicked>
    );
  }
  if (open.kind === 'ram')
    return (
      <HwPicked name={m.view === 'windows' ? 'Windows RAM' : 'RAM'} kind="ram" onBack={back}>
        {ramFigures(hw, m.view, m.ram).map(figure)}
      </HwPicked>
    );
  if (open.kind === 'gpu') {
    const gpu = open.gpu;
    return (
      <HwPicked name={gpu.name} kind="gpu" onBack={back}>
        <HwDetail
          label={t('format.temp')}
          frac={gpu.tempC != null ? gpu.tempC / 100 : null}
          tone={gpu.tempC != null ? tempTone(gpu.tempC) : null}
          text={degreesText(gpu.tempC)}
        />
        <HwDetail
          label={t('board.hotspot')}
          frac={gpu.hotspotC != null ? gpu.hotspotC / 100 : null}
          tone={gpu.hotspotC != null ? tempTone(gpu.hotspotC) : null}
          text={degreesText(gpu.hotspotC)}
        />
        <HwDetail
          label={t('format.power')}
          frac={null}
          text={gpu.powerW != null ? `${Math.round(gpu.powerW)}W` : null}
        />
        <HwDetail
          label={t('format.utilization')}
          frac={gpu.util ?? null}
          text={gpu.util != null ? pctText(gpu.util) : null}
        />
        <HwDetail
          label="VRAM"
          frac={donutFrac(gpu.vramUsedMib, gpu.vramTotalMib)}
          text={
            gpu.vramUsedMib != null && gpu.vramTotalMib != null
              ? `${(gpu.vramUsedMib / 1024).toFixed(1)}/${Math.round(gpu.vramTotalMib / 1024)}G`
              : null
          }
        />
      </HwPicked>
    );
  }
  const disk = open.disk;
  return (
    <HwPicked name={disk.name} kind="disk" onBack={back}>
      <HwDetail
        label={t('board.disk')}
        frac={disk.usedFrac}
        tone={disk.low ? 'warn' : null}
        text={
          disk.usedGib != null && disk.totalGib != null
            ? t('board.usedOf', { used: disk.usedGib, total: disk.totalGib })
            : null
        }
      />
      <HwDetail
        label={t('board.free')}
        frac={null}
        tone={disk.low ? 'warn' : null}
        text={disk.freeGib != null ? `${disk.freeGib}G` : null}
      />
    </HwPicked>
  );
}

/** A ring: used vs total, the share in the middle; a tap opens its detail. */
function Donut({ d }: { d: HwDonut }) {
  const color = d.id.startsWith('vram')
    ? BOARD_COLORS.gpu
    : d.id.startsWith('disk')
      ? BOARD_COLORS.disk
      : BOARD_COLORS.cpu;
  const ring = d.tone === 'warn' ? BOARD_COLORS.warn : color;
  const ref = useCanvas(
    (ctx, w, h) => {
      const r = Math.floor(Math.min(w, h) / 2);
      const thick = Math.max(2, Math.round(r * 0.3));
      const cx = Math.floor(w / 2);
      const cy = Math.floor(h / 2);
      ctx.lineWidth = thick;
      ctx.lineCap = 'butt';
      ctx.strokeStyle = BOARD_COLORS.track;
      ctx.beginPath();
      ctx.arc(cx, cy, r - thick / 2, 0, 2 * Math.PI);
      ctx.stroke();
      if (d.frac === null || d.frac <= 0) return;
      const { start, end } = donutArc(d.frac);
      ctx.strokeStyle = ring;
      ctx.beginPath();
      ctx.arc(cx, cy, r - thick / 2, start, end);
      ctx.stroke();
    },
    [d.frac, ring],
  );
  return (
    <button
      type="button"
      role="listitem"
      className="led-donut"
      data-testid="board-donut"
      data-id={d.id}
      data-frac={d.frac ?? ''}
      title={t('board.showOne', { name: d.title })}
      onClick={() => setHwPrefs({ detail: d.detail })}
    >
      <span className="led-donut-ring">
        <canvas ref={ref} className="led-canvas" aria-hidden="true" />
        <b>{d.frac === null ? '?' : pctText(d.frac)}</b>
      </span>
      <span className="led-donut-label">{d.label}</span>
      <span className="led-muted led-donut-sub">{d.sub}</span>
    </button>
  );
}

/** The one item shown larger: its name is the way back to all of them. */
function HwPicked({
  name,
  kind,
  onBack,
  children,
}: {
  name: string;
  kind: HwOpen['kind'];
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="led-hwpicked" data-testid="board-hw-picked" data-kind={kind}>
      <button
        type="button"
        className="led-hwpicked-head"
        title={t('board.showAll')}
        aria-label={`${name}: ${t('board.showAll')}`}
        onClick={onBack}
      >
        <span>{name}</span>
        <span className="led-muted">{t('board.showAll')} ✕</span>
      </button>
      {children}
    </div>
  );
}

function HwDetail({
  label,
  frac,
  tone,
  text,
}: {
  label: string;
  frac: number | null;
  tone?: 'warn' | 'critical' | null;
  text: string | null;
}) {
  if (text === null) return null;
  return (
    <div className={`led-detail led-tone-${tone ?? 'ok'}`}>
      <span className="led-temp-label">{label}</span>
      <span
        className="led-meter"
        aria-hidden="true"
        style={frac == null ? { visibility: 'hidden' } : undefined}
      >
        <i style={{ width: `${Math.round(Math.max(0, Math.min(1, frac ?? 0)) * 100)}%` }} />
      </span>
      <span className="led-temp-value">{text}</span>
    </div>
  );
}

/** Fits a canvas to its box at device pixels; calls `draw` on every size or data change. */
function useCanvas(
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number) => void,
  deps: unknown[],
) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize((s) => (s && s.w === width && s.h === height ? s : { w: width, h: height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || !size || size.w < 2 || size.h < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(size.w * dpr);
    const h = Math.round(size.h * dpr);
    if (el.width !== w) el.width = w;
    if (el.height !== h) el.height = h;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    draw(ctx, w, h, dpr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, ...deps]);
  return ref;
}

/** Task Manager's spiky graph: the last 60 s, area filled, grid at quarters. */
function Graph({
  label,
  color,
  points,
  k,
  value,
  onOpen,
}: {
  label: string;
  color: string;
  points: HwPoint[];
  k: 'cpu' | 'gpu';
  value: number | null | undefined;
  /** A tap opens this item's detail. */
  onOpen?: () => void;
}) {
  const last = points.at(-1)?.t;
  const ref = useCanvas(
    (ctx, w, h, dpr) => {
      const px = Math.max(1, Math.round(dpr));
      ctx.fillStyle = BOARD_COLORS.grid;
      for (let q = 1; q < 4; q++) ctx.fillRect(0, Math.round((h * q) / 4), w, px);
      for (let q = 1; q < 6; q++) ctx.fillRect(Math.round((w * q) / 6), 0, px, h);
      const line = Math.max(1, Math.round(1.5 * dpr));
      for (const seg of lineSegments(points, k, w, h - line)) {
        const ys = seg.map(([x, y]) => [Math.round(x), Math.round(y + line / 2)] as const);
        ctx.globalAlpha = BOARD_AREA_ALPHA;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(ys[0][0], h);
        for (const [x, y] of ys) ctx.lineTo(x, y);
        ctx.lineTo(ys[ys.length - 1][0], h);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = color;
        ctx.lineWidth = line;
        ctx.lineJoin = 'miter';
        ctx.beginPath();
        ys.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
        if (seg.length === 1) ctx.fillRect(ys[0][0] - line, ys[0][1] - line, line * 2, line * 2);
      }
    },
    [last, points.length, color, k],
  );
  return (
    <figure
      className={`led-graph ${onOpen ? 'led-pick' : ''}`}
      data-testid={`board-graph-${k}`}
      data-last={last ?? ''}
      {...(onOpen && {
        role: 'button',
        tabIndex: 0,
        title: t('board.showOne', { name: label }),
        onClick: onOpen,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen();
          }
        },
      })}
    >
      <figcaption>
        <span>{label}</span>
        <b>{value == null ? '-' : pctText(value)}</b>
      </figcaption>
      <canvas ref={ref} className="led-canvas" aria-label={t('board.graphUsage', { label })} />
    </figure>
  );
}

// ── GPU ──────────────────────────────────────────────────────

/** Queue characters shown before "외 N". */
const QUEUE_SHOWN = 6;

function GpuPage({ snap, now, lookOf }: { snap: CldSnapshot; now: number; lookOf: LookOf }) {
  const board = snap.gpuBoard;
  const util = snap.hwSample?.gpuUtil;
  if (!board) {
    return <p className="led-empty">{t('board.gpuHelp')}</p>;
  }
  const { shown, more } = capRows(board.queue, QUEUE_SHOWN);
  const ends = recentEnds(board.recent, now).slice(0, 3);
  const holders = board.holders.slice(0, 2);
  return (
    <div className="led-gpu">
      <div className="led-stage">
        <div className="led-station">
          {holders.map((t) => (
            <Tiny key={t.id} look={lookOf(t.project)} pose="typing" />
          ))}
          <span
            className={`led-gpu-box ${util ? 'led-gpu-busy' : ''}`}
            title={util == null ? 'GPU' : `GPU ${pctText(util)}`}
          >
            <i className="led-fan" />
            <i className="led-fan" />
            <b>{util == null ? 'GPU' : pctText(util)}</b>
          </span>
        </div>
        <ol className="led-line" data-testid="board-queue" aria-label={t('board.queue')}>
          {shown.map((t, i) => (
            <QueueCharacter key={t.id} t={t} k={i} now={now} lookOf={lookOf} />
          ))}
          {more > 0 && <li className="led-more">{moreText(more)}</li>}
          {!board.queue.length && <li className="led-muted led-nobody">{t('board.noQueue')}</li>}
        </ol>
      </div>
      <div className="led-gpu-info">
        {holders.length ? (
          holders.map((ticket) => (
            <p
              key={ticket.id}
              className="led-holder"
              data-testid="board-holder"
              data-id={ticket.id}
            >
              <span className="led-amber">{t('board.using')}</span> <b>{ticket.project}</b>
              {ticket.label && <span className="led-muted"> {ticket.label}</span>} ·{' '}
              {vramText(ticket.vramGib)} ·{' '}
              {t('board.heldFor', { duration: sinceText(ticket.ts, now) })}
              {ticket.exclusive && <Badge />}
            </p>
          ))
        ) : (
          <p className="led-muted">{t('board.gpuIdle')}</p>
        )}
        <p className="led-muted">{t('board.queueCount', { count: board.queue.length })}</p>
        {ends.length > 0 && (
          <ul className="led-ends">
            {ends.map(({ end, fade }) => (
              <li
                key={`${end.id}-${end.ts}`}
                data-testid="board-end"
                style={{ opacity: 0.3 + 0.7 * fade }}
              >
                {end.project}
                {end.label ? ` ${end.label}` : ''} · {endWords(end)} · {sinceText(end.ts, now)}
                {t('board.agoSuffix')}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function QueueCharacter({
  t,
  k,
  now,
  lookOf,
}: {
  t: GpuTicket;
  k: number;
  now: number;
  lookOf: LookOf;
}) {
  return (
    <li
      className="led-queuer"
      data-testid="board-queuer"
      data-id={t.id}
      data-project={t.project}
      data-ticket={t.ticket}
      data-exclusive={t.exclusive}
      style={{ animationDelay: `${-k * 0.23}s` }}
    >
      <span className="led-tag">
        <span className="led-ticket">{ticketText(t.ticket)}</span>
        {t.exclusive && <Badge />}
      </span>
      <Tiny look={lookOf(t.project)} pose="stand" />
      <b className="led-queuer-name">{t.project}</b>
      <span className="led-muted">
        {vramText(t.vramGib)} · {sinceText(t.ts, now)}
      </span>
    </li>
  );
}

function Badge() {
  return (
    <span className="led-badge" title={t('board.exclusiveTitle')}>
      {t('board.exclusive')}
    </span>
  );
}

/** A character drawn small and pixelated: standing in line, or at work. */
function Tiny({
  look,
  pose,
}: {
  look: { palette: number; hueShift: number };
  pose: 'stand' | 'typing';
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    const sprites = getCharacterSprites(look.palette, look.hueShift);
    const frame =
      pose === 'typing' ? sprites.typing[Direction.DOWN][0] : sprites.walk[Direction.DOWN][1];
    // HD (density 2): the canvas takes the frame's own size; CSS keeps the display size.
    ctx.canvas.width = frame[0]?.length ?? 16;
    ctx.canvas.height = frame.length;
    for (const [y, row] of frame.entries())
      for (const [x, c] of row.entries()) {
        if (!c) continue;
        ctx.fillStyle = c;
        ctx.fillRect(x, y, 1, 1);
      }
  }, [look.palette, look.hueShift, pose]);
  return <canvas ref={ref} width={16} height={32} className="led-tiny" aria-hidden="true" />;
}
