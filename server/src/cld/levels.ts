/**
 * Lv / XP / 환생 (U-15) of the office's characters, in ~/.config/cld-gui/levels.json.
 * XP grows only from work the office actually saw: a completed turn, a tool use,
 * a finished job or Codex task. A 환생 is a renew that really started the new
 * conversation. Nothing is guessed or back-filled, so a character starts at Lv 1.
 */
import * as fs from 'fs';

import type { OfficeLevel } from '../../../core/src/messages.js';
import { readJson, writeJsonAtomic } from './jsonFile.js';

export const XP_TURN = 10;
export const XP_TOOL = 2;
export const XP_JOB = 20;
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

export function levelView(xp: number, rebirths: number): OfficeLevel {
  const level = levelOf(xp);
  return { level, xp, floor: levelFloor(level), next: levelFloor(level + 1), rebirths };
}

/** Rows worth a level: engine projects, named sessions and roster employees (TEMP-PLATES,
 *  `emp:<employee id>`); an unnamed session has no stable self. */
export const levelKeyOk = (key: string): boolean =>
  key.startsWith('engine:') || key.startsWith('name:') || key.startsWith('emp:');

interface Entry {
  xp: number;
  rebirths: number;
}

export class LevelStore {
  private readonly entries = new Map<string, Entry>();
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
    const levels = (raw as { levels?: Record<string, Partial<Entry>> } | null)?.levels;
    if (!levels || typeof levels !== 'object') return;
    for (const [key, e] of Object.entries(levels)) {
      if (Number.isFinite(e?.xp) && Number.isFinite(e?.rebirths))
        this.entries.set(key, { xp: Math.max(0, e.xp!), rebirths: Math.max(0, e.rebirths!) });
    }
  }

  view(key: string): OfficeLevel | undefined {
    if (!levelKeyOk(key)) return undefined;
    const e = this.entries.get(key);
    return levelView(e?.xp ?? 0, e?.rebirths ?? 0);
  }

  addXp(key: string, xp: number): void {
    if (!levelKeyOk(key)) return;
    this.touch(key).xp += xp;
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
      writeJsonAtomic(this.file, { v: 1, levels: Object.fromEntries(this.entries) });
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
