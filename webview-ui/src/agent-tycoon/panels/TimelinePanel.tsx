/**
 * T-185: the 현황판's 타임라인 tab (mock-up board4-gantt-desktop): every run whose start the daemon holds,
 * on one time axis, by kind of worker, with the boss's own row and his to-dos on the right
 * (panels/timeline.ts has the rules). It follows the 실행 tab's project pick. Every word is a fixed
 * template filled with facts, or text that is stored as it is (a job's description, a Codex title, a
 * sub-agent's description, an issue title, the Lead's question). A bar opens a card with its facts and
 * the way to its 실행 entry. On a phone the same chart scrolls sideways inside its panel with the row
 * heads fixed: one view, the same bars and connectors (a second, list layout would be a second thing
 * to keep true, and would lose the connectors).
 */
import './timeline.css';

import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import {
  TIMELINE_AXIS_PX,
  TIMELINE_BAR_PX,
  TIMELINE_CARD_ROOM_PX,
  TIMELINE_LABEL_MIN_SPAN,
  TIMELINE_LABEL_PX,
  TIMELINE_LANE_PX,
  TIMELINE_MAX_LANES,
  TIMELINE_MIN_SPAN,
  TIMELINE_NOW_VIEW_AT,
  TIMELINE_ROW_MIN_PX,
  TIMELINE_ROW_PAD_PX,
  TIMELINE_TICK_MS,
} from '../../constants.js';
import { t } from '../../i18n/index.js';
import type { ToolActivity } from '../../office/types.js';
import { useEngineStore } from '../engineStore.js';
import { timeAgo } from '../format.js';
import { type IconName, PixelIcon } from '../game/parts.js';
import { showOffice } from '../hud/hudStore.js';
import { openMessenger, useMessenger } from '../messenger/messengerStore.js';
import { reveal } from '../notify/openTarget.js';
import { useAgtyStore } from '../officeStore.js';
import { serverLine } from '../serverText.js';
import { useWaitReasons } from '../waiting.js';
import { workbenchProjects } from '../workbench/workbenchState.js';
import { openWorkbench, setWorkbenchTab } from '../workbench/workbenchStore.js';
import { Face } from './Dashboard.js';
import { type Approval, approvals } from './dashboardModel.js';
import { codexKind, codexStatus, jobStatus, spanText } from './jobs.js';
import { useRunsScope } from './runsFilter.js';
import { RunsProjectSelect } from './RunsPanel.js';
import {
  type Ask,
  clockText,
  type Placed,
  type PlacedRow,
  placeRuns,
  ticks,
  type TimelineLink,
  timelineLinks,
  type TimelineRow,
  type TimelineRun,
  timelineRuns,
  type TimelineSpan,
  timeWindow,
  xOf,
} from './timeline.js';

const pct = (x: number) => `${(x * 100).toFixed(3)}%`;

function useTicking(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TIMELINE_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

const iso = (ms: number) => new Date(ms).toISOString();

const NARROW = '(max-width: 640px)';
/** A phone-wide screen: the row heads cover the chart's left, so labels may run to its right edge. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(NARROW).matches === true);
  useEffect(() => {
    const m = window.matchMedia?.(NARROW);
    if (!m) return;
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

type BarState = 'mark' | 'wait' | 'failed' | 'running' | 'done';
const stateOf = (run: TimelineRun): BarState =>
  run.dashed ? 'wait' : run.mark ? 'mark' : run.failed ? 'failed' : run.end === null ? 'running' : 'done';

/** A finished run whose record says it went well (exit 0, Codex done): the tick at its end. */
function passed(run: TimelineRun): boolean {
  const s = run.source;
  if (s.kind === 'job') return jobStatus(s.job, run.end ?? 0).kind === 'done';
  if (s.kind === 'codex') return codexKind(s.task) === 'done';
  return s.kind === 'execution' && s.execution.exit?.value === 0;
}

/** The app's word for a failed run (실패, or 시간 초과 for a job that ran out of time). */
function failedWord(run: TimelineRun, now: number): string {
  if (run.source.kind === 'job' && jobStatus(run.source.job, now).kind === 'timeout') return t('jobs.outcome.timeout');
  return t('jobs.outcome.failed');
}

/** The run's words on the chart: its stored label, or a template for the marks. */
function labelOf(run: TimelineRun): string {
  const s = run.source;
  if (s.kind === 'owner') return t('timeline.owner.sent', { count: s.times.length });
  if (s.kind === 'spawn') return t('timeline.lead.spawned', { count: s.runs.length });
  return run.label ?? t(`timeline.row.${run.row}`);
}

/** The small marks at a bar's end. */
function Cap({ kind }: { kind: 'ok' | 'bad' | 'back' }) {
  return (
    <svg className="tl-cap" data-cap={kind} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" />
      {kind === 'ok' && <path d="M5 8.2l2 2 4-4.2" />}
      {kind === 'bad' && <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" />}
      {kind === 'back' && <path d="M10.6 6.2A3.2 3.2 0 1 0 11 9M10.8 4v2.4H8.4" />}
    </svg>
  );
}

function Tile({ icon, tone }: { icon: IconName; tone?: string }) {
  return (
    <span className="tl-tile" data-tone={tone}>
      <PixelIcon name={icon} />
    </span>
  );
}

interface Layout {
  rows: (PlacedRow & { top: number; height: number; moreY: number })[];
  height: number;
  /** Each placed run and the y of its bar's centre. */
  at: Map<string, { p: Placed; y: number }>;
}

function layout(placed: PlacedRow[]): Layout {
  let top = 0;
  const at = new Map<string, { p: Placed; y: number }>();
  const rows = placed.map((r) => {
    const height = Math.max(TIMELINE_ROW_MIN_PX, 2 * TIMELINE_ROW_PAD_PX + r.lanes * TIMELINE_LANE_PX);
    const pad = (height - r.lanes * TIMELINE_LANE_PX) / 2;
    for (const p of r.items)
      at.set(p.run.key, { p, y: top + pad + p.lane * TIMELINE_LANE_PX + TIMELINE_LABEL_PX + TIMELINE_BAR_PX / 2 });
    const row = { ...r, top, height, moreY: pad + (r.lanes - 1) * TIMELINE_LANE_PX + TIMELINE_LABEL_PX + TIMELINE_BAR_PX / 2 };
    top += height;
    return row;
  });
  return { rows, height: top, at };
}

export function TimelinePanel({ agentTools }: { agentTools: Record<number, ToolActivity[]> }) {
  const full = useAgtyStore();
  const engine = useEngineStore().state?.projects;
  const reasons = useWaitReasons();
  const { contacts } = useMessenger();
  const { projects, shown, names, scope } = useRunsScope();
  const [span, setSpan] = useState<TimelineSpan>('hour');
  const [picked, setPicked] = useState<string | null>(null);
  const now = useTicking();
  const offset = full.hostInfo?.utcOffsetMin ?? -new Date().getTimezoneOffset();

  const inScope = (name: string, project?: string) => !names || names.includes(name) || (!!project && names.includes(project));
  const waits = approvals(reasons, full.officeSnapshot?.orchestrators ?? [], agentTools, (name) => inScope(name));
  // A question waits since the Lead's message that asked it (its last message, when that is the Lead's).
  const asks: Ask[] = waits.flatMap((a) => {
    const c = contacts.find((x) => x.agentId === a.agentId);
    return a.reason === 'question' && c?.lastKind === 'assistant' && c.lastAt !== undefined
      ? [{ name: a.name, agentId: a.agentId, since: c.lastAt, text: c.preview ?? null }]
      : [];
  });
  const asksKey = asks.map((a) => `${a.agentId}:${a.since}`).join();
  const scopedContacts = contacts.filter((c) => inScope(c.name, c.project));
  const contactsKey = scopedContacts.map((c) => `${c.name}:${(c.ownerAt ?? []).join('.')}`).join();

  const runs = useMemo(() => {
    const snap = scope ? scope(full) : full;
    return timelineRuns({
      jobs: snap.officeJobs?.jobs ?? [],
      codex: snap.codexTasks?.tasks ?? [],
      subagents: names ? full.subagentRuns.filter((r) => names.includes(r.project)) : full.subagentRuns,
      tasks: snap.taskBoard?.tasks ?? [],
      leads: new Set(workbenchProjects(full.officeSnapshot, engine)),
      contacts: scopedContacts,
      asks,
      now,
    });
    // The contacts and asks are rebuilt each render; their keys say when they changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full, scope, names, engine, now, contactsKey, asksKey]);
  const links = useMemo(() => timelineLinks(runs), [runs]);
  const w = timeWindow(span, now, offset);
  const narrow = useNarrow();
  const lay = layout(
    placeRuns(runs, w, { minSpan: TIMELINE_MIN_SPAN, labelMin: TIMELINE_LABEL_MIN_SPAN, maxLanes: TIMELINE_MAX_LANES, edge: narrow ? 'end' : 'now' }),
  );
  const pruned = full.subagentRunsPrunedBefore ? Date.parse(full.subagentRunsPrunedBefore) : NaN;
  const pickedAt = picked ? lay.at.get(picked) : undefined;
  // The card goes under the picked run's row (the rows below it stay readable), its pointer up at the run.
  const pickedRow = pickedAt && lay.rows.find((r) => r.items.includes(pickedAt.p));
  const cardTop = pickedRow ? pickedRow.top + pickedRow.height + TIMELINE_ROW_PAD_PX : 0;
  const nowX = xOf(now, w);
  // Opened (or switched), a chart wider than its panel (a phone) brings the now line into view, past its middle.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    const line = el?.querySelector<HTMLElement>('.tl-now');
    if (!el || !line) return;
    const x = line.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft;
    el.scrollLeft = x - el.clientWidth * TIMELINE_NOW_VIEW_AT;
  }, [span]);

  // The sentence under the head: counts of the window's runs (marks and the wait are not runs).
  const shownRuns = [...lay.at.values()].map((v) => v.p.run).filter((r) => !r.mark && !r.dashed);
  const ended = shownRuns.filter((r) => r.end !== null).length;
  const failed = shownRuns.filter((r) => r.failed).length;
  const running = shownRuns.length - ended;
  const reviewCount = (scope ? scope(full) : full).taskBoard?.tasks.filter((x) => x.status === 'review').length ?? 0;
  const permissions = waits.filter((a) => a.reason === 'permission').length;
  const chartH = Math.max(lay.height, TIMELINE_ROW_MIN_PX);

  return (
    <div className="sb tl-root" data-testid="timeline" data-span={span}>
      <div className="tl-cols">
        <section className="sb-panel tl-panel" aria-label={t(`timeline.title.${span}`)} data-testid="timeline-panel">
          <header className="tl-head-bar">
            <PixelIcon name="clock" className="sb-head-icon" />
            <h3 className="tl-title">{t(`timeline.title.${span}`)}</h3>
            <span className="tl-caption">{t('timeline.sub')}</span>
            <span className="tl-tools">
              <RunsProjectSelect projects={projects} shown={shown} />
              <span className="tl-switch" role="group" aria-label={t('timeline.span')}>
                {(['hour', 'today'] as const).map((s) => (
                  <button key={s} type="button" className="tl-seg" aria-pressed={span === s} onClick={() => setSpan(s)}>
                    {t(`timeline.span.${s}`)}
                  </button>
                ))}
              </span>
            </span>
          </header>
          <p className="tl-say" data-testid="timeline-say">
            {t('timeline.say.ran', { span: t(`timeline.title.${span}`), total: shownRuns.length, ended })}
            {failed > 0 && t('timeline.say.failed', { failed })}{' '}
            <span className="tl-say-now">{running > 0 ? t('timeline.say.running', { running }) : t('timeline.say.idle')}</span>
          </p>
          <div className="tl-scroll" ref={scroller}>
            <div className="tl-canvas">
              <div className="tl-axisrow" style={{ height: TIMELINE_AXIS_PX }}>
                <div className="tl-corner" />
                <div className="tl-axis" aria-hidden="true">
                  {/* A tick on the left edge would be cut by the row heads: its line stays, its time goes. */}
                  {ticks(w, span, offset).filter((at) => xOf(at, w) > 0.03).map((at) => (
                    <span key={at} className="tl-tick" data-testid="timeline-tick" style={{ left: pct(xOf(at, w)) }}>
                      {clockText(at, offset)}
                    </span>
                  ))}
                  <span className="tl-now-tag" style={{ left: pct(nowX) }} data-testid="timeline-now">
                    {t('timeline.now', { time: clockText(now, offset) })}
                  </span>
                </div>
              </div>
              <div className="tl-body" style={{ height: pickedAt ? Math.max(chartH, cardTop + TIMELINE_CARD_ROOM_PX) : chartH }}>
                <div className="tl-heads">
                  {lay.rows.map((r) => (
                    <RowHead key={r.row} row={r.row} items={r.items} height={r.height} names={names} />
                  ))}
                </div>
                <div className="tl-chart">
                  <div className="tl-under" style={{ height: chartH }} aria-hidden="true">
                    {ticks(w, span, offset).map((at) => (
                      <i key={at} className="tl-gridline" style={{ left: pct(xOf(at, w)) }} />
                    ))}
                    {lay.rows.map((r) => (
                      <i key={r.row} className="tl-rowline" style={{ top: r.top + r.height }} />
                    ))}
                    <i className="tl-future" style={{ left: pct(nowX) }} />
                    <i className="tl-now" style={{ left: pct(nowX) }} />
                  </div>
                  {lay.rows.length === 0 && (
                    <p className="tl-empty" data-testid="timeline-empty">
                      {t(`timeline.empty.${span}`)}
                    </p>
                  )}
                  <Links links={links} lay={lay} height={chartH} />
                  {lay.rows.map((r) => (
                    <div key={r.row} data-testid="timeline-row" data-row={r.row} className="tl-row" style={{ top: r.top, height: r.height }}>
                      {r.items.map((p) => (
                        <Bar
                          key={p.run.key}
                          p={p}
                          y={lay.at.get(p.run.key)!.y - r.top}
                          now={now}
                          nowX={nowX}
                          narrow={narrow}
                          picked={picked === p.run.key}
                          onPick={() => setPicked(picked === p.run.key ? null : p.run.key)}
                        />
                      ))}
                      {r.overflow.length > 0 && (
                        <button
                          type="button"
                          className="tl-more"
                          data-testid="timeline-more"
                          title={t('timeline.moreTitle', { count: r.overflow.length })}
                          style={{ top: r.moreY }}
                          onClick={() => showOffice('runs')}
                        >
                          {t('timeline.more', { count: r.overflow.length })}
                        </button>
                      )}
                    </div>
                  ))}
                  {pickedAt && (
                    <RunCard p={pickedAt.p} top={cardTop} links={links} runs={runs} now={now} offset={offset} onClose={() => setPicked(null)} />
                  )}
                </div>
              </div>
            </div>
          </div>
          <footer className="tl-legend">
            <span><i className="tl-swatch" data-state="done" />{t('timeline.legend.done')}</span>
            <span><i className="tl-swatch" data-state="running" />{t('jobs.running')}</span>
            <span><Cap kind="bad" />{t('jobs.outcome.failed')}</span>
            <span><Cap kind="back" />{t('timeline.legend.back')}</span>
            <span><i className="tl-swatch" data-state="link" />{t('timeline.legend.link')}</span>
            <span><i className="tl-swatch" data-state="wait" />{t('timeline.legend.wait')}</span>
            <span className="tl-hint">{t('timeline.hint')}</span>
          </footer>
          {pruned > w.from && (
            <p className="sb-note" data-testid="timeline-pruned">
              {t('timeline.pruned', { time: clockText(pruned, offset) })}
            </p>
          )}
          {permissions > 0 && (
            <p className="sb-note" data-testid="timeline-waiting-note">
              {t('timeline.waitingNoStart', { count: permissions })}
            </p>
          )}
        </section>
        <ToDo waits={waits} asks={asks} reviewCount={reviewCount} now={now} />
      </div>
    </div>
  );
}

/** A row's head: a face or a tile, its name, a quiet second line of facts. */
function RowHead({ row, items, height, names }: { row: TimelineRow; items: Placed[]; height: number; names: readonly string[] | null }) {
  let face: ReactNode;
  let second: string | null = null;
  const sources = items.map((p) => p.run.source);
  if (row === 'owner') face = <Tile icon="person" tone="warn" />;
  else if (row === 'lead') {
    const leads = [...new Set(sources.flatMap((s) => (s.kind === 'spawn' ? [s.spawner] : s.kind === 'execution' && s.by ? [s.by] : [])))];
    const first = names?.[0] ?? leads[0];
    face = first ? <Face name={first} /> : <Tile icon="person" />;
    second = leads.length > 1 ? t('timeline.head.more', { name: leads[0], count: leads.length - 1 }) : (first ?? null);
  } else if (row === 'subagent') {
    const faces = [...new Set(sources.flatMap((s) => (s.kind === 'subagent' && s.run.employeeId ? [s.run.employeeId] : [])))].slice(-2);
    face = faces.length ? (
      <span className="tl-faces">
        {faces.map((id) => (
          <Face key={id} name={`emp:${id}`} />
        ))}
      </span>
    ) : (
      <Tile icon="person" />
    );
    second = t('timeline.head.claude');
  } else if (row === 'codex') {
    face = <Tile icon="term" />;
    const models = [...new Set(sources.flatMap((s) => (s.kind === 'codex' && s.task.model ? [s.task.model] : [])))];
    second = models.length ? models.join(' · ') : t('timeline.head.count', { count: items.length });
  } else {
    face = <Tile icon="case" />;
    second = t('timeline.head.count', { count: items.length });
  }
  return (
    <div className="tl-rowhead" style={{ height }} data-testid="timeline-row-head" data-row={row}>
      {face}
      <span className="tl-rowhead-text">
        <b>{t(`timeline.row.${row}`)}</b>
        {second && <small>{second}</small>}
      </span>
    </div>
  );
}

/** The connectors, right-angled: down (or up) from where one ends, across to where the next begins. */
function Links({ links, lay, height }: { links: TimelineLink[]; lay: Layout; height: number }) {
  return (
    <svg className="tl-links" width="100%" height={height} aria-hidden="true">
      <defs>
        <marker id="tl-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0L8 4L0 8z" className="tl-arrowhead" />
        </marker>
        <marker id="tl-arrow-back" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0L8 4L0 8z" className="tl-arrowhead-back" />
        </marker>
      </defs>
      {links.map((l) => {
        const a = lay.at.get(l.from);
        const b = lay.at.get(l.to);
        if (!a || !b) return null;
        const x0 = l.kind === 'spawn' || a.p.run.mark ? a.p.x0 : a.p.x1;
        const x1 = b.p.x0;
        const cls = `tl-link tl-link-${l.kind}`;
        const marker = `url(#${l.kind === 'back' ? 'tl-arrow-back' : 'tl-arrow'})`;
        const across = Math.abs(x1 - x0) > 0.002;
        return (
          <g key={`${l.from}>${l.to}`} data-testid="timeline-link" data-kind={l.kind}>
            <line className={cls} x1={pct(x0)} y1={a.y} x2={pct(x0)} y2={b.y} markerEnd={across ? undefined : marker} />
            {across && <line className={cls} x1={pct(x0)} y1={b.y} x2={pct(x1)} y2={b.y} markerEnd={marker} />}
            {l.kind === 'back' && l.status && (
              <text className="tl-link-text" x={pct((x0 + x1) / 2)} y={b.y + TIMELINE_BAR_PX + 6} textAnchor="middle">
                {t('timeline.back', { status: t(`tasks.status.${l.status}`) })}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function Bar({
  p,
  y,
  now,
  nowX,
  narrow,
  picked,
  onPick,
}: {
  p: Placed;
  y: number;
  now: number;
  nowX: number;
  /** A phone-wide chart: its left is under the row heads, so a mark grows rightwards from its time. */
  narrow: boolean;
  picked: boolean;
  onPick: () => void;
}) {
  const { run } = p;
  const state = stateOf(run);
  const label = labelOf(run);
  const s = run.source;
  const top = y - TIMELINE_LABEL_PX - TIMELINE_BAR_PX / 2;
  if (state === 'mark') {
    // Its dot on its time: a pill near the right edge grows leftwards from it.
    // ponytail: on a narrow chart the pill grows right though its lane was packed leftwards; two pills of one row may touch.
    const leftward = !narrow && p.left < p.x0;
    return (
      <button
        type="button"
        className="tl-pin"
        data-testid="timeline-bar"
        data-state={state}
        data-tone={s.kind === 'owner' ? 'owner' : 'lead'}
        data-key={run.key}
        data-leftward={leftward || undefined}
        aria-pressed={picked}
        title={label}
        style={leftward ? { right: pct(1 - p.x0), top: y, maxWidth: pct(p.room) } : { left: pct(p.x0), top: y, maxWidth: pct(p.room) }}
        onClick={onPick}
      >
        <i className="tl-pin-dot" />
        {run.issue && <span className="ui-chip tl-chip">{run.issue.id}</span>}
        <span className="tl-text">{label}</span>
      </button>
    );
  }
  if (state === 'wait') {
    const asks = s.kind === 'wait' ? s.asks : [];
    return (
      <button
        type="button"
        className="tl-wait"
        data-testid="timeline-bar"
        data-state={state}
        data-key={run.key}
        aria-pressed={picked}
        style={{ left: pct(p.x0), width: pct(Math.max(nowX - p.x0, 0)), top }}
        onClick={onPick}
      >
        <span className="tl-wait-label">{t('timeline.wait.label', { count: asks.length, duration: spanText(now - run.start) })}</span>
        <span className="tl-wait-line" />
      </button>
    );
  }
  const face = s.kind === 'subagent' && s.run.employeeId ? <Face name={`emp:${s.run.employeeId}`} /> : null;
  return (
    <button
      type="button"
      className="tl-run"
      data-testid="timeline-bar"
      data-state={state}
      data-key={run.key}
      data-clipped={p.clipped || undefined}
      data-leftward={p.left < p.x0 || undefined}
      data-bare={p.bare || undefined}
      data-start-unseen={run.startUnseen || undefined}
      aria-pressed={picked}
      title={label}
      style={{ left: pct(p.left), width: pct(p.room), top, '--tl-off': (p.x0 - p.left) / p.room, '--tl-fill': (p.x1 - p.x0) / p.room } as CSSProperties}
      onClick={onPick}
    >
      {/* Too short at this zoom for a label: its bar, its hover title and its card. */}
      <span className="tl-label">
        {!p.bare && (
          <>
            {face}
            {run.issue && <span className="ui-chip tl-chip">{run.issue.id}</span>}
            <span className="tl-text">{label}</span>
            {state === 'running' && <b className="tl-elapsed">{t('timeline.elapsed', { duration: spanText(now - run.start) })}</b>}
          </>
        )}
      </span>
      <span className="tl-track">
        <span className="tl-bar" />
        {state === 'done' && passed(run) && <Cap kind="ok" />}
        {state === 'failed' && (
          <>
            <Cap kind="bad" />
            <b className="tl-failed">{failedWord(run, now)}</b>
          </>
        )}
        {state === 'running' && <i className="tl-run-dot" />}
      </span>
    </button>
  );
}

/** The picked run's stored facts, under its row with a pointer up at it. */
function RunCard({
  p,
  top,
  links,
  runs,
  now,
  offset,
  onClose,
}: {
  p: Placed;
  top: number;
  links: TimelineLink[];
  runs: TimelineRun[];
  now: number;
  offset: number;
  onClose: () => void;
}) {
  const { taskBoard } = useAgtyStore();
  const run = p.run;
  const s = run.source;
  const at = (ms: number) => clockText(ms, offset);
  const range = run.mark
    ? at(run.start)
    : run.end !== null
      ? t('timeline.card.range', { from: at(run.start), to: at(run.end), duration: spanText(run.end - run.start) })
      : t('timeline.card.rangeOpen', { from: at(run.start), duration: spanText(now - run.start) });
  const facts: { text: string; bad?: boolean }[] = [];
  let door: { label: string; go: () => void } | null = null;
  if (s.kind === 'job') {
    facts.push({ text: jobStatus(s.job, now).text + exitText(s.job.exit), bad: run.failed });
    door = { label: t('timeline.card.openRuns'), go: () => openRun('job', s.job.id ?? `pid:${s.job.pid}`) };
  } else if (s.kind === 'codex') {
    facts.push({ text: codexStatus(s.task, now) + exitText(s.task.exit), bad: run.failed });
    door = { label: t('timeline.card.openRuns'), go: () => openRun('codex', s.task.id) };
  } else if (s.kind === 'subagent') {
    // What is and is not known about it, as the record says.
    if (run.startUnseen) facts.push({ text: t(s.run.seen === 'replay' ? 'timeline.card.replay' : 'timeline.card.startUnseen', { time: at(run.start) }) });
    if (run.endUnknown) facts.push({ text: t('timeline.card.endUnknown') });
    if (s.run.spawner) facts.push({ text: t('timeline.card.spawnedBy', { name: s.run.spawner }) });
    facts.push({ text: t('timeline.card.noOutcome') });
  } else if (s.kind === 'owner') {
    facts.push({ text: t('timeline.card.sent', { name: s.name, count: s.times.length, times: s.times.map(at).join(', ') }) });
    door = { label: t('timeline.card.openChat'), go: () => openMessenger(s.agentId) };
  } else if (s.kind === 'spawn') {
    facts.push({ text: t('timeline.card.spawned', { name: s.spawner, count: s.runs.length }) });
    for (const r of s.runs) facts.push({ text: `${at(Date.parse(r.started))} · ${r.desc ?? t('timeline.row.subagent')}` });
  } else if (s.kind === 'wait') {
    for (const a of s.asks) facts.push({ text: t('timeline.card.waitAsk', { name: a.name, ago: timeAgo(iso(a.since), now) }) });
    const first = s.asks[0];
    if (first) door = { label: t('timeline.card.openChat'), go: () => openMessenger(first.agentId) };
  } else if (s.execution.kind === 'agent') {
    const who = run.issue?.assignee?.assignmentId === s.execution.ref ? run.issue.assignee.name : null;
    if (who) facts.push({ text: t('timeline.card.handedTo', { name: who }) });
    if (s.by) facts.push({ text: t('timeline.card.handedBy', { name: s.by }) });
    facts.push({ text: t('timeline.card.noEnd') });
  } else {
    const exit = s.execution.exit?.value;
    if (typeof exit === 'number') facts.push({ text: t(exit === 0 ? 'jobs.outcome.done' : 'jobs.outcome.failed') + exitText(exit), bad: exit !== 0 });
    if (run.end === null) facts.push({ text: t('timeline.card.noEnd') });
  }
  // What came next on the same issue (recorded): the mock-up's "→ ... 2차".
  const next = links.find((l) => l.from === run.key && l.kind !== 'spawn');
  const nextRun = next && runs.find((r) => r.key === next.to);
  if (next && nextRun)
    facts.push({
      text:
        next.kind === 'back' && next.status
          ? t('timeline.card.back', { status: t(`tasks.status.${next.status}`), time: at(nextRun.start) })
          : t('timeline.card.next', { time: at(nextRun.start) }),
    });
  const parent = run.issue?.parentId ? taskBoard?.tasks.find((x) => x.id === run.issue!.parentId) : undefined;
  // Under the bar, kept inside the chart; the pointer at the bar's middle.
  const mid = (p.x0 + (run.mark ? p.x0 : p.x1)) / 2;
  const left = Math.min(Math.max(mid - 0.25, 0), 0.45);
  return (
    <section
      className="tl-card"
      data-testid="timeline-card"
      data-key={run.key}
      data-state={stateOf(run)}
      aria-label={t('timeline.card.label')}
      style={{ left: pct(left), top, '--tl-point': pct((mid - left) / 0.55) } as CSSProperties}
    >
      <header className="tl-card-head">
        <strong className="tl-card-title" data-testid="timeline-card-title">
          {labelOf(run)}
        </strong>
        <span className="tl-card-when" data-testid="timeline-card-when">
          {range}
        </span>
        <button type="button" className="tl-card-x" aria-label={t('common.close')} onClick={onClose}>
          ×
        </button>
      </header>
      {facts.map((f, i) => (
        <p key={i} className={f.bad ? 'tl-card-bad' : undefined} data-testid="timeline-card-fact">
          {f.text}
        </p>
      ))}
      {(run.issue || door) && (
        <footer className="tl-card-foot">
          {run.issue && (
            <span className="tl-card-issue" data-testid="timeline-card-issue">
              {t('timeline.card.issue')}: <span className="ui-chip tl-chip">{run.issue.id}</span> {run.issue.title}
              {run.issue.parentId && ` · ${t('tasks.parent', { id: run.issue.parentId })}${parent ? ` ${parent.title}` : ''}`}
            </span>
          )}
          {door && (
            <button type="button" className="tl-door" data-testid="timeline-open-runs" onClick={door.go}>
              {door.label} <PixelIcon name="right" />
            </button>
          )}
        </footer>
      )}
    </section>
  );
}

function openRun(panel: 'job' | 'codex', id: string): void {
  showOffice('runs');
  reveal(panel, id);
}

const exitText = (exit: number | null | undefined) => (typeof exit === 'number' ? ` · ${t('tasks.exec.exit', { code: exit })}` : '');

/** 사장님이 할 일: the questions and permissions waiting on the boss, each answered in its conversation. */
function ToDo({ waits, asks, reviewCount, now }: { waits: Approval[]; asks: Ask[]; reviewCount: number; now: number }) {
  return (
    <section className="sb-panel tl-todo" aria-label={t('timeline.todo.title')} data-testid="timeline-todo">
      <header className="tl-todo-head">
        <PixelIcon name="person" className="sb-head-icon" />
        <h3>{t('timeline.todo.title')}</h3>
        <span className="tl-count">{waits.length}</span>
      </header>
      <p className="tl-todo-sub">{t('timeline.todo.sub')}</p>
      {waits.length === 0 && <p className="sb-empty">{t('timeline.todo.empty')}</p>}
      {waits.map((a, i) => {
        const ask = asks.find((x) => x.agentId === a.agentId);
        return (
          <article key={a.agentId} className="tl-ask" data-testid="timeline-todo-card" data-reason={a.reason}>
            <p className="tl-ask-who">
              <Face name={a.name} />
              {t(a.reason === 'question' ? 'timeline.todo.asked' : 'timeline.todo.permission', { name: a.name })}
              {ask && <span> · {timeAgo(iso(ask.since), now)}</span>}
            </p>
            <b className="tl-ask-text">
              {a.reason === 'question'
                ? (ask?.text ?? t('boardLook.approval.questionWhat'))
                : a.what
                  ? serverLine(a.what)
                  : t('boardLook.approval.permissionWhat')}
            </b>
            <small className="tl-ask-where">{t('timeline.todo.where', { name: a.name })}</small>
            <Button size="sm" variant={i === 0 ? 'accent' : 'default'} title={t('boardLook.approval.answerTitle')} onClick={() => openMessenger(a.agentId)}>
              {t('boardLook.approval.answer')}
            </Button>
          </article>
        );
      })}
      <button
        type="button"
        className="tl-review"
        data-testid="timeline-todo-review"
        onClick={() => {
          setWorkbenchTab('tasks');
          openWorkbench();
        }}
      >
        <Tile icon="check" tone="warn" />
        <span className="tl-rowhead-text">
          <b>{t('timeline.todo.review', { count: reviewCount })}</b>
          <small>{t('timeline.todo.reviewSub')}</small>
        </span>
        <PixelIcon name="right" />
      </button>
    </section>
  );
}
