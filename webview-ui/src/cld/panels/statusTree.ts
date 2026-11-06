/**
 * The office's rooms (an engine project's room, or a project folder) → orchestrators, and how an
 * orchestrator reads like its office character (pure). A5: the 현황판's filter (the room picked and
 * the unticked Task states), remembered per device in localStorage behind try/catch: a blocked store
 * starts from the defaults. (The orchestrator tree it once kept is gone: the party is the one list.)
 */
import { useSyncExternalStore } from 'react';

import type { OfficeOrchestrator, OfficeSnapshot } from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import type { ToolActivity } from '../../office/types.js';
import { describeActivity, type EzContext } from '../ez/activity.js';
import { characterVisual, type RingState } from '../ez/visuals.js';
import { isOff, stateLabel } from '../format.js';
import { type CldSnapshot, ezContext } from '../officeStore.js';
import { engineTurn, rowBusy } from '../turnState.js';
import type { WaitReason } from '../waiting.js';

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
 *  no tool and not busy reads as idle; a turn that ended asking (`question`, cld/waiting.ts)
 *  reads as waiting for the user. */
export function rowLook(
  o: OfficeOrchestrator,
  tools: ToolActivity[] | undefined,
  ctx: EzContext,
  question = false,
): RowLook {
  const tool = tools && ([...tools].reverse().find((t) => !t.done) ?? tools.at(-1));
  const activity = describeActivity(
    {
      toolName: tool?.toolName,
      status: tool?.status,
      desc: tool?.desc,
      permission: !!tool?.permissionWait && !tool.done,
      waitingInput: question,
      idle: !tool,
      busy: o.busy === true,
      jobWait: engineTurn(o) === 'job',
    },
    ctx,
  );
  const off = isOff(o);
  const visual = characterVisual(activity, off);
  return {
    ring: visual.ring,
    ez: off ? `${visual.icon} ${visual.text}` : `${activity.emoji} ${activity.text}`,
    raw: off ? stateLabel(o.state, rowBusy(o)) : (tool?.status ?? t('status.noTool')),
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

/** Every project's Lead (its Workers left out, as the rooms leave them) as its character's ring. */
export function leadRings(
  snap: CldSnapshot,
  tools: Readonly<Record<number, ToolActivity[]>>,
  reasons: Readonly<Record<number, WaitReason>>,
  workers: ReadonlySet<string>,
): RingState[] {
  const ctx = ezContext(snap);
  return (snap.officeSnapshot?.orchestrators ?? [])
    .filter((o) => !workers.has(o.name))
    .map((o) => rowLook(o, o.agentId != null ? tools[o.agentId] : undefined, ctx, o.agentId != null && reasons[o.agentId] === 'question').ring);
}

// ── The board's filter, per device ────────────────────────────

export interface BoardFilter {
  /** The one room the board shows (the left column's pick), or every room. */
  room: string | null;
}

const DEFAULT_FILTER: BoardFilter = { room: null };
export const BOARD_FILTER_KEY = 'cld.board-filter';

export function parseFilter(raw: string | null): BoardFilter {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw ?? 'null');
  } catch {
    /* junk: the defaults */
  }
  if (!parsed || typeof parsed !== 'object') return DEFAULT_FILTER;
  const v = parsed as Partial<Record<keyof BoardFilter, unknown>>;
  return { room: typeof v.room === 'string' ? v.room : null };
}

function read(): BoardFilter {
  try {
    return parseFilter(localStorage.getItem(BOARD_FILTER_KEY));
  } catch {
    return DEFAULT_FILTER;
  }
}

let filter = read();
const listeners = new Set<() => void>();

function set(next: BoardFilter): void {
  filter = next;
  try {
    localStorage.setItem(BOARD_FILTER_KEY, JSON.stringify(next));
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
export const boardFilter = () => filter;
export const useBoardFilter = () => useSyncExternalStore(subscribe, boardFilter);

export const setRoomFilter = (room: string | null) => set({ ...filter, room });

/** What a page load does: read the stored state again (tests). */
export function reloadBoardFilter(): void {
  filter = read();
  listeners.forEach((listener) => listener());
}
