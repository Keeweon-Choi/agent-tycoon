/**
 * Lv / XP / 환생 (U-15) of the office's characters, in ~/.config/agent-tycoon/levels.json.
 * XP grows only from work the office actually saw: a completed turn, a tool use,
 * a finished job or Codex task. A 환생 is a renew that really started the new
 * conversation. Nothing is guessed or back-filled, so a character starts at Lv 1.
 */
import * as fs from 'fs';

import type { OfficeLevel, OwnerCounts, OwnerStats } from '../../../core/src/messages.js';
import { readJson, writeJsonAtomic } from './jsonFile.js';

export const XP_TURN = 10;
export const XP_TOOL = 2;
export const XP_JOB = 20;
/** OWNER-STATS: what the owner's own privileged session did, counted once each. */
export const XP_INSTRUCTION = 2;
export const XP_APPROVAL = 5;
export const XP_MERGE = 20;
export const XP_TASK = 10;
/** The office reports the owner's steps and connected time at most every 30 s; one report
 *  never counts more than this many seconds past the last accepted one (the first: this). */
export const OWNER_REPORT_MAX_SEC = 60;
/** Steps a second the owner's character can walk at most (the held key walks 6 tiles/s). */
export const OWNER_STEPS_PER_SEC_MAX = 8;
/** How long changes gather before they are written and broadcast. */
export const LEVELS_FLUSH_MS = 5_000;
/** Tool ids remembered per character: the hook and transcript paths can both report one tool. */
const TOOL_IDS_KEPT = 64;

/** XP at which `level` starts: 0, 100, 300, 600, … (each level asks 100 more than the last). */
export const levelFloor = (level: number): number => 50 * level * (level - 1);

export function levelOf(xp: number): number {
  let level = Math.max(1, Math.floor((1 + Math.sqrt(1 + (4 * xp) / 50)) / 2));
  while (levelFloor(level + 1) <= xp) level++; // float rounding at an exact floor
  while (level > 1 && levelFloor(level) > xp) level--;
  return level;
}

export function levelView(xp: number, rebirths: number, inherit = 0): OfficeLevel {
  const level = levelOf(xp);
  return { level, xp, floor: levelFloor(level), next: levelFloor(level + 1), rebirths, ...(inherit > 0 && { inherit }) };
}

/** Rows worth a level: engine projects, named sessions and roster employees (TEMP-PLATES,
 *  `emp:<employee id>`); an unnamed session has no stable self. */
export const levelKeyOk = (key: string): boolean =>
  key.startsWith('engine:') || key.startsWith('name:') || key.startsWith('emp:');

interface Entry {
  xp: number;
  rebirths: number;
  /** 계승 (INHERIT): its generation, written by projectData's inheritProjectData. */
  inherit?: number;
}

export type OwnerAction = 'instructions' | 'approvals' | 'merges' | 'tasks';
const OWNER_XP: Record<OwnerAction, number> = {
  instructions: XP_INSTRUCTION,
  approvals: XP_APPROVAL,
  merges: XP_MERGE,
  tasks: XP_TASK,
};
const COUNT_KEYS = ['instructions', 'approvals', 'merges', 'tasks', 'steps', 'seconds'] as const;
const zeroCounts = (): OwnerCounts => ({ instructions: 0, approvals: 0, merges: 0, tasks: 0, steps: 0, seconds: 0 });
function countsOf(raw: unknown): OwnerCounts {
  const c = zeroCounts();
  for (const k of COUNT_KEYS) {
    const v = (raw as Record<string, unknown> | null)?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) c[k] = Math.max(0, Math.floor(v));
  }
  return c;
}
/** The daemon's local day, the owner's 오늘. */
export function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
interface OwnerEntry {
  xp: number;
  total: OwnerCounts;
  day: string;
  today: OwnerCounts;
}

/** The requests ownerActionOf judges. */
export const OWNER_COUNTED: ReadonlySet<string> = new Set(['chatSend', 'groupPost', 'permissionAnswer', 'repoAction']);

/**
 * OWNER-STATS: the owner action a privileged client's request was, judged by the answer it got
 * (refused or failed counts nothing). Agents act through the engine (MCP, hooks), never here;
 * Task creation is counted where the task is added (it has no answer on success).
 */
export function ownerActionOf(
  req: Record<string, unknown>,
  reply: Record<string, unknown>,
  privileged: boolean,
): OwnerAction | null {
  if (!privileged || reply.ok !== true) return null;
  if (req.type === 'chatSend' && reply.type === 'chatSendResult') return 'instructions';
  if (req.type === 'groupPost' && reply.type === 'groupActionResult') return 'instructions';
  if (req.type === 'permissionAnswer' && req.allow === true && reply.type === 'permissionAnswerResult')
    return reply.result === 'answered' ? 'approvals' : null;
  if (req.type === 'repoAction' && reply.type === 'repoActionResult')
    return reply.action === 'merge' || reply.action === 'mergeContinue' ? 'merges' : null;
  return null;
}

export class LevelStore {
  private readonly entries = new Map<string, Entry>();
  private owner: OwnerEntry = { xp: 0, total: zeroCounts(), day: '', today: zeroCounts() };
  /** When the last activity report was accepted (any connection: two tabs are one owner). */
  private ownerReportAt = -Infinity;
  private readonly lastStatus = new Map<number, string>();
  private readonly toolIds = new Map<number, Set<string>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Runs before each write: the roster's XP marks reach disk first (a crash loses XP, never pays twice). */
  beforeWrite: () => void = () => undefined;

  /** `changed` runs after the debounced write (the office re-broadcasts then). */
  constructor(
    readonly file: string,
    private readonly changed: () => void = () => undefined,
    private readonly flushMs = LEVELS_FLUSH_MS,
  ) {
    this.reload();
  }

  /** Read the file again (after projectData changed it; flush first, or pending XP is lost). */
  reload(): void {
    this.entries.clear();
    this.owner = { xp: 0, total: zeroCounts(), day: '', today: zeroCounts() };
    const file = this.file;
    let raw: unknown;
    try {
      raw = readJson(file);
    } catch {
      // Like memos.json and pins.json: keep the bytes aside, then start empty.
      const aside = `${file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(file, aside);
      } catch {
        /* file disappeared */
      }
      console.warn(`[cld] levels: invalid JSON moved to ${aside}`);
      return;
    }
    const o = (raw as { owner?: Partial<OwnerEntry> } | null)?.owner;
    if (o && typeof o === 'object')
      this.owner = {
        xp: Number.isFinite(o.xp) ? Math.max(0, o.xp!) : 0,
        total: countsOf(o.total),
        day: typeof o.day === 'string' ? o.day : '',
        today: countsOf(o.today),
      };
    const levels = (raw as { levels?: Record<string, Partial<Entry>> } | null)?.levels;
    if (!levels || typeof levels !== 'object') return;
    for (const [key, e] of Object.entries(levels)) {
      if (Number.isFinite(e?.xp) && Number.isFinite(e?.rebirths))
        this.entries.set(key, {
          xp: Math.max(0, e.xp!),
          rebirths: Math.max(0, e.rebirths!),
          ...(Number.isFinite(e.inherit) && e.inherit! > 0 && { inherit: Math.floor(e.inherit!) }),
        });
    }
  }

  view(key: string): OfficeLevel | undefined {
    if (!levelKeyOk(key)) return undefined;
    const e = this.entries.get(key);
    return levelView(e?.xp ?? 0, e?.rebirths ?? 0, e?.inherit);
  }

  addXp(key: string, xp: number): void {
    if (!levelKeyOk(key)) return;
    this.touch(key).xp += xp;
    this.schedule();
  }

  /** OWNER-STATS: the owner's Lv and its counts for today and in total. */
  ownerView(now = Date.now()): OwnerStats {
    const o = this.owner;
    return {
      level: levelView(o.xp, 0),
      today: o.day === dayOf(now) ? { ...o.today } : zeroCounts(),
      total: { ...o.total },
    };
  }

  /** One thing the owner did (ownerActionOf). */
  ownerDid(action: OwnerAction, now = Date.now()): void {
    this.ownerAdd({ [action]: 1 }, now);
    this.owner.xp += OWNER_XP[action];
  }

  /**
   * The office's report of the owner's steps and connected seconds since its last one.
   * Never more than the wall clock allows: the seconds are capped by the time since the last
   * accepted report (OWNER_REPORT_MAX_SEC at most), the steps by that time's walking pace.
   */
  ownerActivity(steps: number, seconds: number, now = Date.now()): void {
    const window = Math.min(OWNER_REPORT_MAX_SEC, Math.max(0, (now - this.ownerReportAt) / 1000));
    const clamp = (v: number, max: number) => (Number.isFinite(v) ? Math.floor(Math.min(Math.max(0, v), max)) : 0);
    const add = { seconds: clamp(seconds, window), steps: clamp(steps, window * OWNER_STEPS_PER_SEC_MAX) };
    if (!add.seconds && !add.steps) return;
    this.ownerReportAt = now;
    this.ownerAdd(add, now);
  }

  private ownerAdd(add: Partial<OwnerCounts>, now: number): void {
    const o = this.owner;
    const day = dayOf(now);
    if (o.day !== day) {
      o.day = day;
      o.today = zeroCounts();
    }
    for (const [k, v] of Object.entries(add) as Array<[keyof OwnerCounts, number]>) {
      o.today[k] += v;
      o.total[k] += v;
    }
    this.schedule();
  }

  /** A renew that started the new conversation. */
  rebirth(key: string): void {
    if (!levelKeyOk(key)) return;
    this.touch(key).rebirths += 1;
    this.schedule();
  }

  /**
   * One state-store broadcast of character `id` (bound to `key`): a turn is complete
   * when its status goes active -> waiting; a tool counts once per tool id.
   */
  observe(id: number, key: string, msg: Record<string, unknown>): void {
    if (msg.type === 'agentStatus' && typeof msg.status === 'string') {
      const before = this.lastStatus.get(id);
      this.lastStatus.set(id, msg.status);
      if (before === 'active' && msg.status === 'waiting') this.addXp(key, XP_TURN);
    } else if (msg.type === 'agentToolStart' && typeof msg.toolId === 'string') {
      const seen = this.toolIds.get(id) ?? new Set<string>();
      this.toolIds.set(id, seen);
      if (seen.has(msg.toolId)) return;
      seen.add(msg.toolId);
      if (seen.size > TOOL_IDS_KEPT) seen.delete(seen.values().next().value!);
      this.addXp(key, XP_TOOL);
    }
  }

  /** A character is gone: its tool and status memory goes with it. */
  forget(id: number): void {
    this.lastStatus.delete(id);
    this.toolIds.delete(id);
  }

  /** An engine event the office saw as it happened (not the history read at start). */
  observeEvent(e: Record<string, unknown>): void {
    // D5: a Codex Worker's run counts for the Worker (its character), not its project.
    const project =
      typeof e.agent === 'string'
        ? e.agent
        : typeof e.project === 'string'
          ? e.project
          : typeof e.name === 'string'
            ? e.name
            : '';
    if (!project) return;
    const key = `engine:${project}`;
    if (e.type === 'orch_renew' && e.ok === true) this.rebirth(key);
    // A Codex task also runs as a job (kind codex): its codex_end is the one that counts.
    else if (e.type === 'job_end' && e.exit === 0 && e.stopped !== true && e.kind !== 'codex')
      this.addXp(key, XP_JOB);
    else if (e.type === 'codex_end' && e.state === 'done') this.addXp(key, XP_JOB);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.beforeWrite();
    try {
      writeJsonAtomic(this.file, { v: 1, levels: Object.fromEntries(this.entries), owner: this.owner });
    } catch (err) {
      console.warn(`[cld] levels: ${String(err)}`);
    }
    this.changed();
  }

  dispose(): void {
    if (this.timer) this.flush();
  }

  private touch(key: string): Entry {
    let e = this.entries.get(key);
    if (!e) this.entries.set(key, (e = { xp: 0, rebirths: 0 }));
    return e;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.flushMs);
    this.timer.unref?.();
  }
}
