/**
 * P4 개발실 (dev room), its pure rules: which chip a task worktree's card wears, the order of the
 * rail, the remembered filter, the 터미널 tab's columns. devroomStore.ts keeps the state, WorktreeRail.tsx and
 * DevRoomPhone.tsx draw it.
 */
import type { BoardTask, EngineAgentCaps, EngineProject, OfficeOrchestrator, RepoWorktree } from '../../../../core/src/messages.js';
import { DEVROOM_GRAPH_MAX_DEPTH } from '../../constants.js';
import { isSubagentToolName } from '../../office/toolUtils.js';
import type { ToolActivity } from '../../office/types.js';
import { PTY_PROVIDER } from '../engine.js';
import type { LeadState } from '../messenger/messengerStore.js';
import { rowBusy } from '../turnState.js';
import type { WaitReason } from '../waiting.js';
import { projectAgents, stateGroup } from './agentBoard.js';

/** The rail's chips, strongest first (plan 1.1). */
export type Chip = 'conflict' | 'approve' | 'question' | 'review' | 'fixing' | 'working' | 'idle' | 'merged';

export interface ChipInput {
  wt: RepoWorktree;
  task?: Pick<BoardTask, 'status'>;
  /** Why the assignee waits for the person: a permission (! 승인) or a question (cld/waiting.ts). */
  wait: WaitReason | null;
  /** The assignee's state, as the board's cards read it (agentBoard.stateGroup; 'off' with nobody on it). */
  state: LeadState;
  /** Review notes on this worktree were sent to its Worker. */
  notesSent: boolean;
}

/** The files a merge into its base would conflict on (the daemon's pre-check, while viewed). */
export const conflictsOf = (wt: RepoWorktree): number => wt.conflicts?.length ?? 0;

/**
 * Merged = its branch went into the base and nothing came after. A fresh worktree with no commit
 * yet is also `merged` by git's count, so a merge record (or the Task being done) must say so too.
 */
export const isMerged = (wt: RepoWorktree, task?: Pick<BoardTask, 'status'>): boolean =>
  wt.merged && (wt.merge?.ok === true || task?.status === 'done');

export function chipOf({ wt, task, wait, state, notesSent }: ChipInput): Chip {
  if (isMerged(wt, task)) return 'merged';
  if (conflictsOf(wt) > 0) return 'conflict';
  const group = stateGroup(state);
  // A wait with no reason known (a session held on its terminal) asks for the person's 승인.
  if (wait || group === 'needs') return wait === 'question' ? 'question' : 'approve';
  if (task?.status === 'review') return 'review';
  if (task?.status === 'doing' && notesSent) return 'fixing';
  if (group === 'working') return 'working';
  return 'idle';
}

/** The card's title: its Task's, else the worktree's folder name. */
export const titleOf = (wt: RepoWorktree, tasks: readonly BoardTask[]): string =>
  (wt.taskId && tasks.find((x) => x.id === wt.taskId)?.title) || wt.task;

/** What the rail is narrowed to: one project, or every one (null). */
export function parseFilter(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const value = (JSON.parse(raw) as { project?: unknown }).project;
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

/** The one project shown: the filtered one while it still exists, or the only project; null = all. */
export const shownProject = (all: readonly string[], filter: string | null): string | null =>
  filter && all.includes(filter) ? filter : all.length === 1 ? all[0] : null;

/** The projects the rail shows. */
export const shownProjects = (all: readonly string[], filter: string | null): string[] => {
  const one = shownProject(all, filter);
  return one ? [one] : [...all];
};

// ── 터미널 tab: one column per agent on the pick, one per running sub-agent of theirs ──

/** live: its PTY-host terminal; none: its agent has no terminal (caps.attach; `runs`: it works in
 *  runs, shown in the 현황판's 실행); old: not in our PTY host; off: not running. */
export type AgentColumn =
  | { kind: 'live'; name: string; agentId: number | null; bgId: string }
  | { kind: 'none' | 'old' | 'off'; name: string; agentId: number | null; runs?: true };

export interface SubColumn {
  key: string;
  /** 서브 n, counted across the pick's agents. */
  n: number;
  desc: string;
  lines: readonly ToolActivity[];
  /** Its lead and the spawn's tool_use id: what the work view reads (DEVROOM-SUBVIEW). */
  agentId: number;
  parent: string;
  /** The spawn's own call came back: the sub-agent finished. */
  done: boolean;
}

const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, '') === b.replace(/[\\/]+$/, '');

/**
 * The agents on a pick: the trunk (wt null) has the project's Lead; a task worktree its assignee
 * Worker, then every Reviewer whose folder or open Task points at that worktree.
 */
export function agentsOn(
  project: string,
  wt: RepoWorktree | null,
  engine: readonly EngineProject[],
  tasks: readonly Pick<BoardTask, 'status' | 'assignee' | 'worktree'>[],
): EngineProject[] {
  if (!wt) return engine.filter((p) => p.name === project && !p.role);
  const here = (path: string) => samePath(path, wt.path) || path === wt.task;
  const reviews = (p: EngineProject) =>
    p.role === 'reviewer' &&
    (here(p.folder) ||
      tasks.some((x) => x.status !== 'done' && x.assignee?.name === p.name && !!x.worktree && here(x.worktree)));
  return [
    ...engine.filter((p) => p.name === wt.assignee),
    ...engine.filter((p) => p.name !== wt.assignee && reviews(p)),
  ];
}

export function columnOf(
  p: EngineProject,
  orchs: readonly Pick<OfficeOrchestrator, 'name' | 'agentId'>[],
  caps: EngineAgentCaps | undefined,
): AgentColumn {
  const agentId = orchs.find((o) => o.name === p.name)?.agentId ?? null;
  if (caps && !caps.attach) return { kind: 'none', name: p.name, agentId, ...(caps.lifetime === 'run' && { runs: true as const }) };
  if (p.provider !== PTY_PROVIDER) return { kind: 'old', name: p.name, agentId };
  if (!p.live || !p.bgId) return { kind: 'off', name: p.name, agentId };
  return { kind: 'live', name: p.name, agentId, bgId: p.bgId };
}

/**
 * The running sub-agents of the pick's Claude agents (subagentTool* rows; a subagentClear removes
 * one). Its title is the spawning tool's own description; the selected one's transcript comes
 * through the work view (AgentColumns.tsx).
 */
export function subColumns(
  cols: readonly AgentColumn[],
  subs: Readonly<Record<number, Record<string, ToolActivity[]>>>,
  tools: Readonly<Record<number, ToolActivity[]>>,
): SubColumn[] {
  let n = 0;
  return cols.flatMap((c) => {
    const id = c.agentId;
    if (id === null || c.kind === 'none') return [];
    const rows = subs[id] ?? {};
    // DEVROOM-SIDEBAR: a running spawn with no tool rows yet (just spawned, between its calls after a
    // reload: the daemon replays only running calls) is a sub-agent too.
    // ponytail: a named spawn (a Teammate-to-be) is listed here too until its teammate takes over.
    const quiet = (tools[id] ?? []).filter((x) => !x.done && !(x.toolId in rows) && isSubagentToolName(x.toolName)).map((x) => [x.toolId, []] as const);
    return [...Object.entries(rows), ...quiet].map(([parent, lines]) => {
      const spawn = tools[id]?.find((x) => x.toolId === parent);
      return { key: `${id}:${parent}`, n: ++n, desc: spawn?.desc ?? spawn?.status ?? '', lines, agentId: id, parent, done: spawn?.done === true };
    });
  });
}

// ── The phone's list (W5; owner 11-01 13:30: 143 old Codex folders buried the real work) ──

const DAY_MS = 86_400_000;

/** The phone's order: what needs the owner (a conflict, an approval, a review), then work under way, then resting; merged last. */
const PHONE_RANK: Record<Chip, number> = { conflict: 0, approve: 0, question: 0, review: 0, fixing: 1, working: 1, idle: 2, merged: 3 };

/** A worktree's last sign of life: its branch's last commit or its making, whichever is later (NaN: unknown). */
export const lastActivity = (wt: Pick<RepoWorktree, 'created' | 'lastChange'>): number =>
  Math.max(Date.parse(wt.created), wt.lastChange ? Date.parse(wt.lastChange) : -Infinity);

/** Resting = no Task, nobody on it, nothing to do (idle or merged) and no activity for `days`. */
export const isResting = (row: { chip: Chip; wt: RepoWorktree }, now: number, days: number): boolean =>
  !row.wt.taskId &&
  !row.wt.assignee &&
  (row.chip === 'idle' || row.chip === 'merged') &&
  now - lastActivity(row.wt) >= days * DAY_MS;

/** The phone's cards in order, the resting ones apart (folded into one `쉬는 작업 N개` row). */
export function phoneRows<T extends { chip: Chip; wt: RepoWorktree }>(
  rows: readonly T[],
  now: number,
  days: number,
): { shown: T[]; resting: T[] } {
  const sorted = [...rows].sort(
    (a, b) => PHONE_RANK[a.chip] - PHONE_RANK[b.chip] || a.wt.created.localeCompare(b.wt.created),
  );
  return {
    shown: sorted.filter((r) => !isResting(r, now, days)),
    resting: sorted.filter((r) => isResting(r, now, days)),
  };
}

/** A Codex run's folder (`codex-MMDD-HHMMSS`, engine/codex.ts taskName) as `MM-DD HH:MM`; null for any other name. */
export function codexStamp(task: string): string | null {
  const m = /^codex-(\d{2})(\d{2})-(\d{2})(\d{2})\d{2}$/.exec(task);
  return m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]}` : null;
}

// ── The rail's graph (owner 11-03 10:38: every worktree hung off main, integ/… was missing) ──

/** One line of the graph: a card, or a branch cards were made from that is not a card itself. */
export type GraphLine<T> = { kind: 'row'; row: T; depth: number } | { kind: 'branch'; name: string; depth: number };

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Each card under the branch it was made from (its recorded `base`): the trunk's cards at depth 0;
 * a base that is another card's branch nests under that card; any other base (`integ/1024-1815`)
 * is a branch line under the trunk with its cards one step in. Order: `rows`' own, a branch line
 * where its first card would be. `ponytail:` such a branch hangs off the trunk; its own parent is
 * not looked up (git has no record of it) until a repository needs a deeper picture.
 */
export function graphLines<T extends { wt: Pick<RepoWorktree, 'branch' | 'base'> }>(rows: readonly T[], trunk: string): GraphLine<T>[] {
  const cards = new Set(rows.map((r) => r.wt.branch));
  const kids = new Map<string, T[]>();
  const tops: Array<T | string> = [];
  for (const r of rows) {
    const b = r.wt.base;
    if (b === trunk || b === r.wt.branch || SHA_RE.test(b)) {
      tops.push(r);
      continue;
    }
    const list = kids.get(b);
    if (list) list.push(r);
    else {
      kids.set(b, [r]);
      if (!cards.has(b)) tops.push(b);
    }
  }
  const out: GraphLine<T>[] = [];
  const seen = new Set<T>();
  const emit = (r: T, depth: number) => {
    if (seen.has(r)) return;
    seen.add(r);
    out.push({ kind: 'row', row: r, depth });
    for (const k of kids.get(r.wt.branch) ?? []) emit(k, depth + 1);
  };
  for (const top of tops) {
    if (typeof top !== 'string') emit(top, 0);
    else {
      out.push({ kind: 'branch', name: top, depth: 0 });
      for (const k of kids.get(top) ?? []) emit(k, 1);
    }
  }
  // Bases in a circle (a from b, b from a) reach no top: they stand at the top.
  for (const r of rows) emit(r, 0);
  return out;
}

/** The graph's left edge at `depth`; the steps past DEVROOM_GRAPH_MAX_DEPTH are drawn at the same place. */
export const graphLeft = (depth: number, left: number, step: number): number => left + Math.min(depth, DEVROOM_GRAPH_MAX_DEPTH) * step;

// ── DV4 new worktree and seating (seatStore.ts, NewSpace.tsx) ──────────────

export const WORKTREES_DIR = '.worktrees';

/** Where the engine puts a branch's worktree: `.worktrees/<branch with / as ->` (branchName.ts). */
export const folderOf = (branch: string): string => `${WORKTREES_DIR}/${branch.trim().replace(/\//g, '-')}`;
/** The folder name a card carries (RepoWorktree.task). */
export const taskOf = (branch: string): string => branch.trim().replace(/\//g, '-');

export type SeatState = 'off' | 'idle' | 'busy';

export interface SeatAgent {
  name: string;
  state: SeatState;
  /** The card (folder name) of another worktree it sits in, if any. */
  elsewhere: string | null;
  /** Seating it means a restart: it is on and its session stays (a session moves only at its start). */
  restarts: boolean;
}

/** The project's Workers and Reviewers (the Lead works in the project's own folder), with their state. */
export function seatAgents(
  project: string,
  engine: readonly EngineProject[],
  orchs: readonly Pick<OfficeOrchestrator, 'name' | 'provider' | 'state' | 'busy' | 'shellWait' | 'renewing'>[],
  worktrees: readonly Pick<RepoWorktree, 'task' | 'assignee'>[],
  caps: (provider: string | undefined) => EngineAgentCaps | undefined,
  here: string | null = null,
): SeatAgent[] {
  return projectAgents(project, engine)
    .filter((p) => !!p.role)
    .map((p) => {
      const orch = orchs.find((o) => o.name === p.name);
      const state: SeatState = !p.live ? 'off' : orch && rowBusy(orch) === true ? 'busy' : 'idle';
      const other = worktrees.find((w) => w.assignee === p.name && w.task !== here);
      return { name: p.name, state, elsewhere: other?.task ?? null, restarts: !!p.live && caps(p.provider)?.lifetime !== 'run' };
    });
}

/** The bases a worktree can start from: the project's branch, then the worktrees' branches. */
export function baseChoices(trunk: string | undefined, worktrees: readonly Pick<RepoWorktree, 'branch'>[]): string[] {
  return [...new Set([trunk ?? 'main', ...worktrees.map((w) => w.branch)])];
}

/** A new Task's title when no issue is linked: the first instruction's first line, else the branch. */
export const titleFor = (text: string, branch: string): string =>
  (text.split('\n').find((l) => l.trim())?.trim() ?? branch.trim()).slice(0, 200);

