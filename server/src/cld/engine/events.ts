/**
 * The engine's event log (T-0019, cld/docs/design/cld-cli.md §8):
 * ~/.config/cld-gui/events.jsonl, one JSON line per event in this shape
 * ({v, ts, type, source, ...}), each line under 4 KB and written with one
 * append (O_APPEND), so the feed can tail it. The daemon writes it; `cld-gui send` does too while the
 * daemon is off.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { OfficeEvent } from '../../../../core/src/messages.js';
import { EventsTail } from './eventsTail.js';
import { rememberWorkName, summarizeEvent } from './eventSummary.js';
import { EVENTS_ROTATE_BYTES } from './logPolicy.js';

/** The feed keeps this many events (what a new viewer is sent). */
const FEED_MAX = 200;

export const configDir = (home = os.homedir()): string => path.join(home, '.config', 'cld-gui');
export const eventsPath = (home = os.homedir()): string =>
  path.join(configDir(home), 'events.jsonl');

const LINE_MAX = 4096;
const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0');

/** Local time with its UTC offset, like `date -Iseconds` (HIF's timestamps). */
export function isoLocal(t = Date.now()): string {
  const off = -new Date(t).getTimezoneOffset();
  const local = new Date(t + off * 60_000).toISOString().slice(0, 19);
  return `${local}${off < 0 ? '-' : '+'}${pad(off / 60)}:${pad(off % 60)}`;
}

/** `MM-DD HH:MM`, local (the message and log stamps). */
export function shortStamp(t = Date.now()): string {
  const d = new Date(t);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A log over `max` bytes becomes `<file>.1`, replacing the older one (one previous file kept). */
export function rotateEvents(
  file: string,
  max = EVENTS_ROTATE_BYTES,
  log: (line: string) => void = (l) => console.log(`[cld engine] ${l}`),
): boolean {
  try {
    const size = fs.statSync(file).size;
    if (size <= max) return false;
    fs.renameSync(file, `${file}.1`);
    log(`events.jsonl rotated to events.jsonl.1 (${(size / 1024 / 1024).toFixed(1)} MB)`);
    return true;
  } catch {
    return false; // no log yet, or not renamable: it stays and grows
  }
}

export type FeedItem = Omit<OfficeEvent, 'type'>;

/** One event line, appended with one write (O_APPEND); false when not written. Also for
 *  processes outside the daemon (the CLI, the Codex worker, the GPU wrapper). */
export function appendEvent(
  file: string,
  type: string,
  source: string,
  fields: Record<string, unknown> = {},
  now = Date.now(),
): boolean {
  const line = JSON.stringify({ v: 1, ts: isoLocal(now), type, source, ...fields });
  if (Buffer.byteLength(line) >= LINE_MAX) {
    console.warn(`[cld engine] event ${type} dropped: over ${LINE_MAX} bytes`);
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
    return true;
  } catch (err) {
    console.warn(`[cld engine] ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * The daemon's side of the log: it appends, and it follows the file, so what
 * other processes append (an offline `send`, the Codex worker, the GPU
 * wrapper, T-0021) reaches the feed and the notices too.
 */
export class EngineEvents {
  private readonly workNames = new Map<string, string>();
  /** The latest events, summarized for the feed (oldest first). */
  readonly feed: FeedItem[] = [];
  private readonly tail: EventsTail;
  private watcher: fs.FSWatcher | null = null;
  /** Every record as read, unsummarized (the GPU board folds the gpu_* ones, T-0021). */
  onRecord: ((e: Record<string, unknown>) => void) | null = null;

  constructor(
    readonly file: string,
    private readonly listener: (e: FeedItem) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.tail = new EventsTail(file, (m) => console.warn(`[cld engine] ${m}`));
  }

  /** The feed from the file's last lines (at start; nothing is sent). */
  load(): void {
    // The whole tail scan goes to onRecord (a lease may be old); the feed keeps its last lines.
    const events = this.tail.primeLast(Number.MAX_SAFE_INTEGER);
    for (const e of events) {
      this.onRecord?.(e);
      rememberWorkName(e, this.workNames);
    }
    for (const e of events.slice(-FEED_MAX)) {
      const s = summarizeEvent(rememberWorkName(e, this.workNames));
      if (s) this.feed.push(s);
    }
  }

  /** Follow lines other processes append (fs.watch on the folder; the file may not exist yet). */
  follow(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const name = path.basename(this.file);
      this.watcher = fs.watch(path.dirname(this.file), (_e, f) => {
        if (f === name) this.drain();
      });
      this.watcher.on('error', () => undefined);
    } catch {
      /* our own appends still reach the feed */
    }
  }

  /** Rotate when over `max`. Reads what is left first, so the feed loses nothing (a line another
   *  process appends in between is still followed: the tail finishes the old file, eventsTail.ts). */
  rotate(max = EVENTS_ROTATE_BYTES): boolean {
    this.drain();
    return rotateEvents(this.file, max);
  }

  dispose(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  /** One line; never throws (an event must not stop what it records). */
  append(type: string, source: string, fields: Record<string, unknown> = {}): void {
    if (appendEvent(this.file, type, source, fields, this.now())) this.drain();
  }

  /** New lines into the feed, each to the listener once. */
  drain(): void {
    for (const e of this.tail.readNew()) {
      this.onRecord?.(e);
      const s = summarizeEvent(rememberWorkName(e, this.workNames));
      if (!s) continue;
      this.feed.push(s);
      if (this.feed.length > FEED_MAX) this.feed.shift();
      this.listener(s);
    }
  }
}
