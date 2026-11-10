/**
 * CLONE-PROGRESS: git clone's `--progress` lines (stderr, LC_MESSAGES=C) as phases. git rewrites
 * one line with `\r` while a phase runs and ends it with `\n` (`, done.`); the remote's lines
 * come prefixed `remote: `. Anything else (`Cloning into`, `warning:`, `fatal:`) is kept apart, so
 * the failure's reason survives however much progress came before it.
 *
 *   remote: Counting objects:  50% (2/4)
 *   Receiving objects:  45% (1893/4207), 1.20 MiB | 2.40 MiB/s
 *   Resolving deltas: 100% (333/333), done.
 *   Updating files:  20% (850/4207)
 */
import type { CloneProgressPhase } from '../../../core/src/messages.js';

export interface CloneProgress {
  phase: CloneProgressPhase;
  percent?: number;
  done?: number;
  total?: number;
  size?: string;
  speed?: string;
}

const PHASES: Record<string, CloneProgressPhase> = {
  'enumerating objects': 'enumerating',
  'counting objects': 'counting',
  'compressing objects': 'compressing',
  'receiving objects': 'receiving',
  'resolving deltas': 'resolving',
  'updating files': 'updating',
};
const LINE_RE = /^(?:remote:\s*)?([A-Za-z ]+?):\s*(?:(\d{1,3})%\s*\((\d+)\/(\d+)\)|(\d+))?(?:,\s*([\d.]+ [KMGT]?i?B)(?:\s*\|\s*([\d.]+ [KMGT]?i?B\/s))?)?/;
/** Kept lines that are not progress (the reason a clone failed is among the last). */
const KEEP = 20;

/** One progress line, or null when it is not one. */
export function parseCloneProgress(line: string): CloneProgress | null {
  const m = LINE_RE.exec(line.trim());
  const phase = m && PHASES[m[1].toLowerCase()];
  if (!m || !phase) return null;
  const out: CloneProgress = { phase };
  if (m[2] !== undefined) out.percent = Math.min(100, Number(m[2]));
  if (m[3] !== undefined) out.done = Number(m[3]);
  if (m[4] !== undefined) out.total = Number(m[4]);
  if (m[5] !== undefined) out.done = Number(m[5]);
  if (m[6]) out.size = m[6];
  if (m[7]) out.speed = m[7];
  return out;
}

/** Feeds stderr chunks (split anywhere) and hands each finished progress line on; the rest is kept. */
export class CloneProgressReader {
  private partial = '';
  readonly other: string[] = [];

  constructor(private readonly onProgress: (p: CloneProgress) => void) {}

  push(chunk: string): void {
    const parts = (this.partial + chunk).split(/[\r\n]/);
    this.partial = parts.pop() ?? '';
    for (const part of parts) this.line(part);
  }

  /** The stream ended: its last line too. */
  end(): void {
    if (this.partial) this.line(this.partial);
    this.partial = '';
  }

  private line(text: string): void {
    if (!text.trim()) return;
    const p = parseCloneProgress(text);
    if (p) this.onProgress(p);
    else if (this.other.push(text.trim()) > KEEP) this.other.shift();
  }
}

/** At most one report per `everyMs`, but a new phase at once; the last one is never lost to the
 *  wait (it goes out when the wait ends, unless a newer one replaced it). */
export function throttled(
  send: (p: CloneProgress) => void,
  everyMs: number,
  now: () => number = Date.now,
): { push: (p: CloneProgress) => void; stop: () => void } {
  let last = -Infinity;
  let phase: string | null = null;
  let held: CloneProgress | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (!held) return;
    const p = held;
    held = null;
    last = now();
    phase = p.phase;
    send(p);
  };
  return {
    push(p) {
      held = p;
      if (p.phase !== phase || now() - last >= everyMs) {
        if (timer) clearTimeout(timer);
        flush();
      } else timer ??= setTimeout(flush, everyMs - (now() - last));
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      held = null;
    },
  };
}
