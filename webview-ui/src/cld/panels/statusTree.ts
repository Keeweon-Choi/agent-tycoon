/**
 * T-0029: the 현황판 tree, rooms (an engine project's room, or a project folder)
 * → orchestrators. Grouping, each row's look and a room's summary are pure.
 * Which nodes are open and the filter are remembered per device in
 * localStorage, behind try/catch: a blocked store starts from the defaults.
 */
import { useSyncExternalStore } from 'react';

import type { OfficeOrchestrator, OfficeSnapshot, StatusView } from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import type { ToolActivity } from '../../office/types.js';
import { describeActivity, type EzContext } from '../ez/activity.js';
import { characterVisual, type RingState } from '../ez/visuals.js';
import { isOff, stateLabel } from '../format.js';

export interface Room {
  name: string;
  /** An orchestrator room (tab kind orch): cards may be dropped on it and it may be renamed. */
  rows: OfficeOrchestrator[];
}

/** Rooms in tab order, rows in their own order; 기타 gathers rows whose room
 *  is not a tab. Empty rooms are left out. */
export function groupRooms(office: OfficeSnapshot, workers: ReadonlySet<string> = new Set()): Room[] {
  const tabs = [...office.tabs].sort((a, b) => a.order - b.order);
  const names = new Set(tabs.map((tab) => tab.name));
  // D3b: the 현황판 lists projects (= their Leads); a Worker shows under its project in the
  // 작업실 and the messenger only (its character stays in the office).
  const rowsWhere = (test: (o: OfficeOrchestrator) => boolean) =>
    office.orchestrators
      .filter((o) => !workers.has(o.name) && test(o))
      .sort((a, b) => a.order - b.order);
  return [
    ...tabs.map((tab) => ({
      name: tab.name,
      rows: rowsWhere((o) => o.tab === tab.name),
    })),
    { name: t('status.other'), rows: rowsWhere((o) => !names.has(o.tab)) },
  ].filter((room) => room.rows.length > 0);
}

export interface RowLook {
  /** The state ring its office character wears (T-0026). */
  ring: RingState;
  /** EZ mode's line: the activity in words, 💤 꺼져 있음 when off. */
  ez: string;
  /** 자세히 mode's line: the raw tool status, or the process state when off. */
  raw: string;
}

/** A row read like its office character: the live tool, else the last one;
 *  no tool and not busy reads as idle. */
export function rowLook(
  o: OfficeOrchestrator,
  tools: ToolActivity[] | undefined,
  ctx: EzContext,
): RowLook {
  const tool = tools && ([...tools].reverse().find((t) => !t.done) ?? tools.at(-1));
  const activity = describeActivity(
    {
      toolName: tool?.toolName,
      status: tool?.status,
      desc: tool?.desc,
      permission: !!tool?.permissionWait && !tool.done,
      idle: !tool,
      busy: o.busy === true,
    },
    ctx,
  );
  const off = isOff(o);
  const visual = characterVisual(activity, off);
  return {
    ring: visual.ring,
    ez: off ? `${visual.icon} ${visual.text}` : `${activity.emoji} ${activity.text}`,
    raw: off ? stateLabel(o.state, o.busy) : (tool?.status ?? t('status.noTool')),
  };
}

export type RowState = 'working' | 'waiting' | 'idle' | 'off';

/** A ring in the 현황판's words: a permission and a question both wait for
 *  the user; an activity nobody named is still work. */
export function rowState(ring: RingState): RowState {
  if (ring === 'waiting' || ring === 'permission') return 'waiting';
  if (ring === 'idle' || ring === 'off') return ring;
  return 'working';
}

export type TreeFilter = 'all' | 'working' | 'waiting' | 'off';
export const FILTERS: readonly TreeFilter[] = ['all', 'working', 'waiting', 'off'];
export const passesFilter = (filter: TreeFilter, ring: RingState): boolean =>
  filter === 'all' || rowState(ring) === filter;

/** What most needs the user first: a collapsed room's badge is the first of
 *  these any of its rows has. */
const WORST_FIRST: RingState[] = ['permission', 'waiting', 'working', 'neutral', 'idle', 'off'];

export interface RoomSummary {
  working: number;
  waiting: number;
  off: number;
  worst: RingState;
}

export function roomSummary(rings: RingState[]): RoomSummary {
  const states = rings.map(rowState);
  const count = (state: RowState) => states.filter((s) => s === state).length;
  return {
    working: count('working'),
    waiting: count('waiting'),
    off: count('off'),
    worst: WORST_FIRST.find((ring) => rings.includes(ring)) ?? 'off',
  };
}

/**
 * 프로젝트 현황 is open: the daemon reads the project's local report every 10 s for this viewer until the returned cleanup, run on
 * collapse or unmount, turns it off. The section's effect is exactly this.
 */
export function watchProjectStatus(name: string, send: (msg: StatusView) => void): () => void {
  send({ type: 'statusView', name, on: true });
  return () => send({ type: 'statusView', name, on: false });
}

// ── Open nodes and the filter, per device ─────────────────────

export type TreeLevel = 'room' | 'orch';

export interface TreeState {
  /** Each level's default (모두 펼치기 / 모두 접기 set both); `open` holds the
   *  nodes toggled away from it, keyed `room:<name>` / `orch:<name>`. */
  rooms: boolean;
  orchs: boolean;
  open: Record<string, boolean>;
  filter: TreeFilter;
}

/** Rooms open, orchestrators closed: each room lists its orchestrators' one-line looks. */
const DEFAULT_TREE: TreeState = { rooms: true, orchs: false, open: {}, filter: 'all' };
export const STATUS_TREE_KEY = 'cld.status-tree';

export function parseTree(raw: string | null): TreeState {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw ?? 'null');
  } catch {
    /* junk: the defaults */
  }
  if (!parsed || typeof parsed !== 'object') return DEFAULT_TREE;
  const v = parsed as Partial<Record<keyof TreeState, unknown>>;
  const open =
    v.open && typeof v.open === 'object' && !Array.isArray(v.open)
      ? Object.fromEntries(
          Object.entries(v.open).filter((e): e is [string, boolean] => typeof e[1] === 'boolean'),
        )
      : {};
  return {
    rooms: typeof v.rooms === 'boolean' ? v.rooms : DEFAULT_TREE.rooms,
    orchs: typeof v.orchs === 'boolean' ? v.orchs : DEFAULT_TREE.orchs,
    open,
    filter: FILTERS.find((id) => id === v.filter) ?? 'all',
  };
}

export function isOpen(tree: TreeState, level: TreeLevel, name: string): boolean {
  return tree.open[`${level}:${name}`] ?? (level === 'room' ? tree.rooms : tree.orchs);
}

function read(): TreeState {
  try {
    return parseTree(localStorage.getItem(STATUS_TREE_KEY));
  } catch {
    return DEFAULT_TREE;
  }
}

let tree = read();
const listeners = new Set<() => void>();

function set(next: TreeState): void {
  tree = next;
  try {
    localStorage.setItem(STATUS_TREE_KEY, JSON.stringify(next));
  } catch {
    // Private mode or a locked-down webview: this visit still remembers it.
  }
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const statusTree = () => tree;
export const useStatusTree = () => useSyncExternalStore(subscribe, statusTree);

export function toggleNode(level: TreeLevel, name: string): void {
  const key = `${level}:${name}`;
  const next = !isOpen(tree, level, name);
  const open = { ...tree.open, [key]: next };
  if (next === (level === 'room' ? tree.rooms : tree.orchs)) delete open[key];
  set({ ...tree, open });
}

/** 모두 펼치기 / 모두 접기: both levels, rooms and orchestrators seen later too. */
export const setAllOpen = (open: boolean) => set({ ...tree, rooms: open, orchs: open, open: {} });
export const setTreeFilter = (filter: TreeFilter) => set({ ...tree, filter });

/** What a page load does: read the stored state again (tests). */
export function reloadStatusTree(): void {
  tree = read();
  listeners.forEach((listener) => listener());
}
