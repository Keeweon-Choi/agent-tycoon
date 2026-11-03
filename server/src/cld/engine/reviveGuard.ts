/**
 * TOKEN-GUARD: the engine's own revives and give-ups per project, kept across daemon restarts
 * (revive-guard.json). Extracted from engine.ts (E2).
 */
import * as fs from 'fs';
import * as path from 'path';

import { koText } from '../../../../core/src/cld/serverText.js';
import { configDir } from './events.js';
import { writeAtomic } from './messenger.js';

const DAY_MS = 86_400_000;
const reviveGuardFile = (home: string): string => path.join(configDir(home), 'revive-guard.json');

export interface ReviveGuardDeps {
  home: string;
  /** The engine's timing object (read at each call, so a test's override is seen). */
  timing: { reviveWindowMs: number; reviveLimit: number; reviveDayLimit: number; reviveBackoffMs: number };
  now: () => number;
  log: (line: string) => void;
  event?: (type: string, source: string, fields: Record<string, unknown>) => void;
  changed?: () => void;
}

export class ReviveGuard {
  /** T-0091: when the engine last revived each project on its own (24 h; revive-guard.json). */
  private readonly attempts = new Map<string, number[]>();
  /** T-0091: projects the engine gave up on (crash loop), with the last error (revive-guard.json). */
  private readonly gave = new Map<string, string>();
  /** The last start error of the watch's revives, for the mark when it gives up. */
  private readonly lastError = new Map<string, string>();

  constructor(private readonly deps: ReviveGuardDeps) {
    this.load();
  }

  /** The error a project was given up on with, or undefined when it was not. */
  gaveUp(name: string): string | undefined {
    return this.gave.get(name);
  }

  /** Its revives in the last 24 h (as last counted). */
  count(name: string): number {
    return this.attempts.get(name)?.length ?? 0;
  }

  /** The mark goes (live again); saved only when there was one. */
  clearGaveUp(name: string): void {
    if (this.gave.delete(name)) this.save();
  }

  /** The watch's last start error for `name`; none clears it. */
  noteError(name: string, error?: string): void {
    if (error === undefined) this.lastError.delete(name);
    else this.lastError.set(name, error);
  }

  /** A person acted on the project: the watch's crash-loop count and mark start over. */
  forgive(name: string): void {
    const had = this.attempts.delete(name) || this.gave.has(name);
    this.gave.delete(name);
    this.lastError.delete(name);
    if (had) this.save();
  }

  /** Read the file again (after projectData changed it). */
  reload(): void {
    this.attempts.clear();
    this.gave.clear();
    this.load();
  }

  private load(): void {
    let o: Record<string, { attempts?: unknown; gaveUp?: unknown }>;
    try {
      o = JSON.parse(fs.readFileSync(reviveGuardFile(this.deps.home), 'utf-8')) as typeof o;
    } catch {
      return; // none yet (or unreadable: the counts start over, as before TOKEN-GUARD)
    }
    for (const [name, g] of Object.entries(o ?? {})) {
      if (Array.isArray(g?.attempts))
        this.attempts.set(name, g.attempts.filter((t): t is number => typeof t === 'number'));
      if (typeof g?.gaveUp === 'string') this.gave.set(name, g.gaveUp);
    }
  }

  // ponytail: keyed by name, so a rename starts its count over; key by assignmentId if that matters.
  private save(): void {
    const o: Record<string, { attempts: number[]; gaveUp?: string }> = {};
    for (const name of new Set([...this.attempts.keys(), ...this.gave.keys()]))
      o[name] = {
        attempts: this.attempts.get(name) ?? [],
        ...(this.gave.has(name) && { gaveUp: this.gave.get(name) }),
      };
    try {
      writeAtomic(reviveGuardFile(this.deps.home), JSON.stringify(o));
    } catch (err) {
      this.deps.log(`${reviveGuardFile(this.deps.home)}: ${String(err)}; revive counts kept in memory only`);
    }
  }

  /**
   * TOKEN-GUARD (TG-03): may the engine revive `name` on its own now? Every revive is a resumed
   * conversation and its 자동 복구 turn, so they are bounded: the reviveLimit-th inside
   * reviveWindowMs, or one past reviveDayLimit in 24 h, leaves it down (marked, one log line,
   * one orch_giveup), and each watch revive waits reviveBackoffMs * 2^(k-1) after the one before
   * (a daemon start's revive is the recovery a restart or reboot is for: counted, not delayed).
   * Counts and the give-up survive a daemon restart; a person's start or stop clears them.
   */
  budget(name: string, backoff = true): 'go' | 'wait' | 'stop' {
    const t = this.deps.timing;
    if (this.gave.has(name)) return 'stop';
    const now = this.deps.now();
    const day = (this.attempts.get(name) ?? []).filter((x) => now - x < DAY_MS);
    const burst = day.filter((x) => now - x < t.reviveWindowMs).length + 1 >= t.reviveLimit;
    if (burst || day.length >= t.reviveDayLimit) {
      this.attempts.set(name, day);
      const error =
        this.lastError.get(name) ??
        (burst ? koText('stopped_n_times', { count: t.reviveLimit }) : koText('stopped_n_per_day', { count: day.length + 1 }));
      this.gave.set(name, error);
      this.save();
      this.deps.log(
        burst
          ? `watch "${name}": died ${t.reviveLimit} times within ${Math.round(t.reviveWindowMs / 60_000)} min; left down (${error})`
          : `watch "${name}": revived ${day.length} times in 24 h; left down (${error})`,
      );
      this.deps.event?.('orch_giveup', 'engine', {
        name,
        error,
        reason: burst ? 'crash_loop' : 'day_cap',
      });
      this.deps.changed?.();
      return 'stop';
    }
    const last = day.at(-1);
    if (backoff && last !== undefined && now - last < t.reviveBackoffMs * 2 ** (day.length - 1))
      return 'wait';
    this.attempts.set(name, [...day, now]);
    this.save();
    return 'go';
  }
}
