/**
 * T-185: the 현황판's 타임라인 tab, pure. Who ran what, when, on one time axis, from the records the
 * page already holds: jobs (officeJobs), Codex tasks (codexTasks), sub-agents (tempStaff.runs, when the
 * daemon saw them start and end) and the executions recorded on issues (taskBoard). Nothing is
 * summarised or guessed: a run without a known start is not drawn, an end that was not recorded is not
 * made up (a mark, or "still running" only when the record says so). Connectors follow recorded facts
 * only: a Lead's spawn to the sub-agents it started (each run carries its project, the spawn time is
 * its start), and the runs recorded on one issue in time order, a return where the issue's history
 * says it went from 검토 back to work in between. No connector between runs that share nothing.
 */
import type {
  BoardExecution,
  BoardTask,
  BoardTaskStatus,
  CodexTask,
  MessengerContact,
  OfficeJob,
  SubagentRun,
} from '../../../../core/src/messages.js';
import {
  TIMELINE_DAY_TICK_MS,
  TIMELINE_FUTURE_MS,
  TIMELINE_HOUR_MS,
  TIMELINE_HOUR_TICK_MS,
  TIMELINE_OWNER_GROUP_MS,
  TIMELINE_SPAWN_GROUP_MS,
  TIMELINE_TIME_SLACK_MS,
} from '../../constants.js';
import { codexKind, jobStatus } from './jobs.js';

/** The rows, in their fixed order. */
export const TIMELINE_ROWS = ['owner', 'lead', 'subagent', 'codex', 'job'] as const;
export type TimelineRow = (typeof TIMELINE_ROWS)[number];
export type TimelineSpan = 'hour' | 'today';

/** Where a run's facts come from (the card reads them there). */
export type RunSource =
  | { kind: 'job'; job: OfficeJob }
  | { kind: 'codex'; task: CodexTask }
  | { kind: 'subagent'; run: SubagentRun }
  /** An execution recorded on an issue whose own record the page no longer has (or an agent's). */
  | { kind: 'execution'; execution: BoardExecution; by?: string }
  /** The boss's messages to one Lead, close together (times only). */
  | { kind: 'owner'; name: string; agentId: number; times: number[] }
  /** A Lead started these sub-agents, close together (their spawner, as recorded). */
  | { kind: 'spawn'; spawner: string; runs: SubagentRun[] }
  /** Questions waiting on the boss, each since the Lead's message that asked it. */
  | { kind: 'wait'; asks: Ask[] };

/** A question waiting on the boss: the Lead's last message (stored) and when it was written. */
export interface Ask {
  name: string;
  agentId: number;
  since: number;
  text: string | null;
}

export interface TimelineRun {
  /** `job:<id>`, `codex:<id>`, `claude:<spawn id>`, `agent:<assignment id>`. */
  key: string;
  row: TimelineRow;
  /** The stored description or title, as it is (null: the row's own word stands in). */
  label: string | null;
  start: number;
  /** null: still running (the record says so), drawn open to now. */
  end: number | null;
  /** Only a start is recorded (no end will come): drawn as a mark, not a bar. */
  mark: boolean;
  failed: boolean;
  /** The issue the run is recorded on. */
  issue: BoardTask | null;
  source: RunSource;
  /** A waiting stretch (the boss's row): drawn dashed. */
  dashed?: boolean;
  /** Its start was not seen (a sub-agent first met by a tool or in the start-up read): `start` is when it was first seen. */
  startUnseen?: boolean;
  /** It ended, but when is not known (a daemon restart in between): drawn as a start mark. */
  endUnknown?: boolean;
}

const time = (v: string | null | undefined): number | null => {
  const n = v ? Date.parse(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

const jobRef = (job: OfficeJob) => job.id ?? `pid:${job.pid}`;

/** The history line `attach` wrote for an execution: who attached it. */
const attachedBy = (task: BoardTask, e: BoardExecution): string | undefined =>
  task.history.find((h) => h.change === `execution ${e.id}`)?.by;

export interface RunInput {
  jobs: readonly OfficeJob[];
  codex: readonly CodexTask[];
  subagents: readonly SubagentRun[];
  tasks: readonly BoardTask[];
  /** The office's Leads: an issue handed to an agent is drawn on the 리드 row only when one of them did it. */
  leads: ReadonlySet<string>;
  /** The messenger's contacts: when the boss wrote to each (ownerAt). */
  contacts?: readonly MessengerContact[];
  /** The questions waiting on the boss. */
  asks?: readonly Ask[];
  now: number;
}

/** Times split where the gap from a group's first exceeds `gap` (sorted). */
function groups<T>(items: readonly T[], at: (x: T) => number, gap: number): T[][] {
  const out: T[][] = [];
  for (const x of [...items].sort((a, b) => at(a) - at(b))) {
    const last = out.at(-1);
    if (last && at(x) - at(last[0]) <= gap) last.push(x);
    else out.push([x]);
  }
  return out;
}

/** Every run the records hold a start for, each once. */
export function timelineRuns({ jobs, codex, subagents, tasks, leads, contacts = [], asks = [], now }: RunInput): TimelineRun[] {
  const issueOf = new Map<string, BoardTask>();
  for (const task of tasks) for (const e of task.executions ?? []) if (!issueOf.has(e.id)) issueOf.set(e.id, task);
  const taskById = new Map(tasks.map((x) => [x.id, x]));
  const linked = (key: string, id?: string) => issueOf.get(key) ?? (id ? taskById.get(id) : undefined) ?? null;
  const out: TimelineRun[] = [];
  const seen = new Set<string>();

  for (const job of jobs) {
    const start = time(job.started);
    if (start === null) continue;
    const key = `job:${jobRef(job)}`;
    const end = job.ended ? time(job.ended) : null;
    const kind = jobStatus(job, now).kind;
    seen.add(key);
    out.push({
      key,
      row: 'job',
      label: job.label ?? null,
      start,
      end,
      mark: !!job.ended && end === null,
      failed: kind === 'failed' || kind === 'timeout',
      issue: linked(key, job.run?.task),
      source: { kind: 'job', job },
    });
  }

  for (const task of codex) {
    const start = time(task.started);
    const kind = codexKind(task);
    if (start === null || kind === 'queued') continue;
    const key = `codex:${task.id}`;
    const end = time(task.ended);
    const open = kind === 'running' || kind === 'limit';
    seen.add(key);
    out.push({
      key,
      row: 'codex',
      label: task.title ?? task.spec ?? null,
      start,
      end: open ? null : end,
      // Over, with no end on the record: a start mark.
      mark: !open && end === null,
      failed: kind === 'failed',
      issue: linked(key, task.task),
      source: { kind: 'codex', task },
    });
  }

  // The boss's messages, grouped per Lead: marks (when, how many; never the words).
  for (const c of contacts)
    for (const g of groups(c.ownerAt ?? [], (x) => x, TIMELINE_OWNER_GROUP_MS))
      out.push({
        key: `owner:${c.name}:${g[0]}`,
        row: 'owner',
        label: null,
        start: g[0],
        end: null,
        mark: true,
        failed: false,
        issue: null,
        source: { kind: 'owner', name: c.name, agentId: c.agentId, times: g },
      });
  if (asks.length) {
    const since = Math.min(...asks.map((a) => a.since));
    out.push({ key: 'wait', row: 'owner', label: null, start: since, end: null, mark: false, failed: false, issue: null, source: { kind: 'wait', asks: [...asks] }, dashed: true });
  }

  // A Lead's spawns: the sub-agents it started close together are one mark on the 리드 row. Only a
  // spawn the daemon saw live (not re-bound after a restart), and only a Lead's: a Worker or an
  // outside session has no row of its own here, so its sub-agents get no mark.
  const bySpawner = new Map<string, SubagentRun[]>();
  for (const run of subagents)
    if (run.seen === 'spawn' && !run.rebound && run.spawner && leads.has(run.spawner) && time(run.started) !== null)
      bySpawner.set(run.spawner, [...(bySpawner.get(run.spawner) ?? []), run]);
  for (const [spawner, list] of bySpawner)
    for (const g of groups(list, (r) => time(r.started)!, TIMELINE_SPAWN_GROUP_MS))
      out.push({
        key: `spawn:${g[0].execution}`,
        row: 'lead',
        label: null,
        start: time(g[0].started)!,
        end: null,
        mark: true,
        failed: false,
        issue: null,
        source: { kind: 'spawn', spawner, runs: g },
      });

  for (const run of subagents) {
    const start = time(run.started);
    if (start === null) continue;
    // An end is observed only for a run the daemon followed live from its binding on.
    const endUnknown = !!run.ended && (run.rebound === true || run.endedBy === 'restart' || run.seen === 'replay');
    const end = endUnknown ? null : time(run.ended);
    out.push({
      key: run.execution,
      row: 'subagent',
      label: run.desc ?? null,
      start,
      end,
      mark: !!run.ended && end === null,
      failed: false, // the daemon records no outcome for a sub-agent
      issue: null,
      source: { kind: 'subagent', run },
      ...(run.seen !== 'spawn' && { startUnseen: true }),
      ...(endUnknown && { endUnknown: true }),
    });
  }

  for (const task of tasks)
    for (const e of task.executions ?? []) {
      if (seen.has(e.id)) continue;
      const start = time(e.startedAt);
      if (start === null) continue;
      seen.add(e.id);
      if (e.kind === 'agent') {
        // Handed to an agent: only the moment is recorded (no end), and only a Lead's hand is the 리드 row's.
        const by = attachedBy(task, e);
        if (!by || !leads.has(by)) continue;
        out.push({ key: e.id, row: 'lead', label: task.title, start, end: null, mark: true, failed: false, issue: task, source: { kind: 'execution', execution: e, by } });
        continue;
      }
      const end = time(e.endedAt?.value);
      const exit = e.exit?.value;
      out.push({
        key: e.id,
        row: e.kind === 'job' ? 'job' : 'codex',
        label: task.title,
        start,
        // The record is gone and no end was observed: nothing says it still runs.
        end,
        mark: end === null,
        failed: typeof exit === 'number' && exit !== 0,
        issue: task,
        source: { kind: 'execution', execution: e },
      });
    }
  return out;
}

// ── Connectors ───────────────────────────────────────────────

export interface TimelineLink {
  from: string;
  to: string;
  /** spawn: a Lead started it; next: the issue's next run; back: the issue went from 검토 back to work between them. */
  kind: 'spawn' | 'next' | 'back';
  /** back: the status it went to. */
  status?: BoardTaskStatus;
}

const BACK = /(?:^|, )status review → (\w+)/;

/** The connectors the records support, nothing else. */
export function timelineLinks(runs: readonly TimelineRun[]): TimelineLink[] {
  const out: TimelineLink[] = [];
  for (const r of runs)
    if (r.source.kind === 'spawn') for (const s of r.source.runs) out.push({ from: r.key, to: s.execution, kind: 'spawn' });
  const byIssue = new Map<BoardTask, TimelineRun[]>();
  for (const r of runs) if (r.issue) byIssue.set(r.issue, [...(byIssue.get(r.issue) ?? []), r]);
  for (const [task, list] of byIssue) {
    const sorted = [...list].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      const [a, b] = [sorted[i - 1], sorted[i]];
      const aEnd = a.mark ? a.start : a.end;
      // Only one after another: a run still going (or overlapping) hands nothing on.
      if (aEnd === null || aEnd > b.start) continue;
      const back = task.history
        .filter((h) => {
          const at = Date.parse(h.at);
          return at >= aEnd && at < b.start + TIMELINE_TIME_SLACK_MS;
        })
        .map((h) => BACK.exec(h.change)?.[1])
        // Only a move back to work is a return (검토 → 막힘 is not).
        .find((x) => x === 'doing');
      out.push(back ? { from: a.key, to: b.key, kind: 'back', status: back as BoardTaskStatus } : { from: a.key, to: b.key, kind: 'next' });
    }
  }
  return out;
}

// ── The axis ─────────────────────────────────────────────────

export interface TimeWindow {
  from: number;
  to: number;
  now: number;
}

/** The host's midnight before `now` (ms). */
export const hostMidnight = (now: number, offsetMin: number): number => {
  const off = offsetMin * 60_000;
  return Math.floor((now + off) / 86_400_000) * 86_400_000 - off;
};

/** 1시간: the last hour and a little future; 오늘: the host's day, midnight to midnight. */
export function timeWindow(span: TimelineSpan, now: number, offsetMin: number): TimeWindow {
  if (span === 'hour') return { from: now - TIMELINE_HOUR_MS, to: now + TIMELINE_FUTURE_MS, now };
  const from = hostMidnight(now, offsetMin);
  return { from, to: from + 86_400_000, now };
}

/** Where `at` sits on the window, 0 (left edge) to 1 (right edge), clamped. */
export const xOf = (at: number, w: TimeWindow): number => Math.min(1, Math.max(0, (at - w.from) / (w.to - w.from)));

/** The tick times inside the window: every 10 minutes on 1시간, every 2 hours on 오늘 (host time). */
export function ticks(w: TimeWindow, span: TimelineSpan, offsetMin: number): number[] {
  const step = span === 'hour' ? TIMELINE_HOUR_TICK_MS : TIMELINE_DAY_TICK_MS;
  const off = offsetMin * 60_000;
  const out: number[] = [];
  for (let at = Math.ceil((w.from + off) / step) * step - off; at <= w.to; at += step) out.push(at);
  return out;
}

/** "14:05" in the host's time. */
export function clockText(at: number, offsetMin: number): string {
  const d = new Date(at + offsetMin * 60_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// ── Placing the runs ─────────────────────────────────────────

export interface Placed {
  run: TimelineRun;
  /** Left and right of the bar, 0..1 of the chart. */
  x0: number;
  x1: number;
  /** The room it holds on its lane (its label's width): at least `minSpan`. */
  room: number;
  /** Where that room begins: at the bar, or pulled left so it ends where the bar (or the now line) ends. */
  left: number;
  /** It began before the window: drawn from the left edge. */
  clipped: boolean;
  lane: number;
  /** Too short at this zoom to carry a label: its bar only (its card has the rest). */
  bare: boolean;
}

export interface PlaceOptions {
  /** A label's least room (share of the chart). */
  minSpan: number;
  /** A run shorter than this share draws no label and reserves no room for one. */
  labelMin: number;
  /** At most this many lanes a row; the rest folds into one "+N". */
  maxLanes: number;
  /** Where a label's room may end: the now line, or (a narrow chart, whose heads cover its left) the right edge. */
  edge: 'now' | 'end';
}

export interface PlacedRow {
  row: TimelineRow;
  lanes: number;
  items: Placed[];
  /** The runs past the lane cap, folded into one "+N" on the last lane. */
  overflow: TimelineRun[];
}

/** The runs seen in the window: a bar crosses it, a mark is inside it. */
export function inWindow(run: TimelineRun, w: TimeWindow): boolean {
  if (run.mark) return run.start >= w.from && run.start <= w.to;
  return run.start <= w.to && (run.end ?? w.now) >= w.from;
}

/**
 * Lanes for spans on one row: each on the first lane whose last span ended at or before its start, in
 * start order; overlapping spans never share a lane. Returns the lane of each input, by index.
 */
export function packLanes(spans: readonly { x0: number; x1: number }[]): number[] {
  const order = spans.map((_, i) => i).sort((a, b) => spans[a].x0 - spans[b].x0 || a - b);
  const ends: number[] = [];
  const lanes = new Array<number>(spans.length);
  for (const i of order) {
    let lane = ends.findIndex((end) => end <= spans[i].x0);
    if (lane < 0) lane = ends.push(0) - 1;
    ends[lane] = spans[i].x1;
    lanes[i] = lane;
  }
  return lanes;
}

/** The window's runs by row (fixed order, empty rows left out), each on its lane. */
export function placeRuns(runs: readonly TimelineRun[], w: TimeWindow, o: PlaceOptions): PlacedRow[] {
  return TIMELINE_ROWS.flatMap((row) => {
    const items: Placed[] = runs
      .filter((r) => r.row === row && inWindow(r, w))
      .map((run) => {
        const x0 = xOf(run.start, w);
        const x1 = run.mark ? x0 : xOf(run.end ?? w.now, w);
        // A mark is its label, a run still going keeps its label and elapsed time; a finished run too
        // short for one keeps only its bar's own width.
        const bare = !run.mark && !run.dashed && run.end !== null && x1 - x0 < o.labelMin;
        const room = bare ? Math.max(x1 - x0, o.labelMin / 2) : Math.max(x1 - x0, o.minSpan);
        // Its label never reaches into the future (or, narrow, past the right edge): the room is pulled left.
        const edge = Math.max(x1, o.edge === 'now' ? xOf(w.now, w) : 1);
        return { run, x0, x1, room, left: Math.min(x0, Math.max(0, edge - room)), clipped: run.start < w.from, lane: 0, bare };
      });
    if (!items.length) return [];
    const lanes = packLanes(items.map((p) => ({ x0: p.left, x1: p.left + p.room })));
    items.forEach((p, i) => (p.lane = lanes[i]));
    const used = Math.max(...lanes) + 1;
    if (used <= o.maxLanes) return [{ row, lanes: used, items, overflow: [] }];
    // Past the cap: the last lane holds the "+N", the runs that would go there or further fold into it.
    const kept = items.filter((p) => p.lane < o.maxLanes - 1);
    const overflow = items.filter((p) => p.lane >= o.maxLanes - 1).map((p) => p.run);
    return [{ row, lanes: o.maxLanes, items: kept, overflow }];
  });
}
