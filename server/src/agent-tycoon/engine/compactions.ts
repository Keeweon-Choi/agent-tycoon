/**
 * The compactions seen in each project's conversation (the 휴식 count), and the one renew nudge
 * that follows them for projects that opted in. Extracted from engine.ts (E3).
 */
import * as fs from 'fs';

import { RENEW_FILL_PCT } from '../../constants.js';
import type { ProjectRecord } from './registry.js';
import type { Live } from './sessionMatch.js';

export interface CompactionWatchDeps {
  event?: (type: string, source: string, fields: Record<string, unknown>) => void;
  /** The conversation passed its compaction count and refilled: ask for the renew. */
  nudge?: (name: string, count: number, fillPct: number) => void;
}

export class CompactionWatch {
  /** Compactions and the one renew nudge seen per project's conversation. */
  private readonly seen = new Map<
    string,
    {
      sessionId: string;
      offset: number;
      count: number;
      carry: string;
      nudged: boolean;
      /** Already refilled when first seen (a daemon restart): it may have been
       *  nudged before, so only the next compaction's fallback reminds it. */
      fullAtFirstLook: boolean;
    }
  >();

  constructor(private readonly deps: CompactionWatchDeps) {}

  /** The compactions counted in `sessionId`'s conversation of `name` (0 for another conversation). */
  countFor(name: string, sessionId: string): number {
    const c = this.seen.get(name);
    return c?.sessionId === sessionId ? c.count : 0;
  }

  /** The `[name, count]` pairs of the engine's change signature. */
  sigPart(): Array<[string, number]> {
    return [...this.seen].map(([name, c]) => [name, c.count]);
  }

  /** `name`'s conversation is gone (a swap): its count starts over. */
  forget(name: string): void {
    this.seen.delete(name);
  }

  /**
   * Compactions of every background project: Claude writes a compact_boundary
   * record into the transcript each time (the count of same). Projects with a
   * nudge (opt-in) also renew after the configured count, once the
   * post-compaction context has refilled. Only a changed tail is read; a
   * conversation first seen is only counted, so a restart never nudges again.
   */
  check(projects: ProjectRecord[], holderOf: (p: ProjectRecord) => Live | null): void {
    for (const p of projects) {
      const h = holderOf(p);
      if (h?.kind !== 'background' || !h.agent.compaction) continue;
      const { mark, fillPct: fillOf } = h.agent.compaction;
      const file = h.agent.transcript(h);
      let size: number;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue;
      }
      let c = this.seen.get(p.name);
      const first = !c || c.sessionId !== h.sessionId;
      if (!c || first || size < c.offset)
        this.seen.set(
          p.name,
          (c = {
            sessionId: h.sessionId,
            offset: 0,
            count: 0,
            carry: '',
            nudged: false,
            fullAtFirstLook: false,
          }),
        );
      if (size === c.offset) continue;
      let found = 0;
      try {
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(1024 * 1024);
          for (let at = c.offset; at < size;) {
            const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - at), at);
            if (n <= 0) break;
            const text = c.carry + buf.toString('latin1', 0, n);
            found += text.split(mark).length - 1;
            c.carry = text.slice(-(mark.length - 1));
            at += n;
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        continue;
      }
      c.offset = size;
      c.count += found;
      if (found && !first)
        this.deps.event?.('compacted', 'engine', { name: p.name, count: c.count });
      if (!p.compactionNudge || c.nudged || c.count < p.compactionNudge) continue;
      // The tail is read only here: an opted-in conversation past M, not yet
      // nudged, whose transcript grew.
      const fillPct = fillOf(file) ?? 0; // unknown: never "full"
      const full = fillPct >= RENEW_FILL_PCT;
      if (first) {
        c.fullAtFirstLook = full;
        continue;
      }
      // A later boundary proves that a refill passed between checks. Do not let
      // a fourth compaction silently replace the renew the user asked for.
      const fallback = found > 0 && c.count > p.compactionNudge;
      if (full && !c.fullAtFirstLook) {
        c.nudged = true;
        this.deps.nudge?.(p.name, c.count, fillPct);
      } else if (fallback) {
        c.nudged = true;
        this.deps.nudge?.(p.name, c.count, RENEW_FILL_PCT);
      }
    }
  }
}
