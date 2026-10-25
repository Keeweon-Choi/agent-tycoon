/**
 * Append-only tail of an events.jsonl (the engine's, SAD 6.1): remembers the read
 * offset; a truncated or replaced (renamed, new inode) file is read again
 * from the start; a broken line is skipped with a warning; never throws.
 */
import * as fs from 'fs';

type Obj = Record<string, unknown>;

const TAIL_SCAN_BYTES = 512 * 1024;

export class EventsTail {
  private offset = 0;
  private ino = -1;
  private partial = '';

  constructor(
    readonly file: string,
    private readonly warn: (msg: string) => void = (m) => console.warn(`[cld events] ${m}`),
  ) {}

  /** Start at the end of the file; return its last `max` events (no side effects). */
  primeLast(max: number): Obj[] {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch {
      this.offset = 0;
      this.ino = -1;
      return [];
    }
    const start = Math.max(0, st.size - TAIL_SCAN_BYTES);
    let text = this.readRange(this.file, start, st.size);
    this.ino = st.ino;
    this.offset = st.size;
    this.partial = '';
    // Just after a rotation the file is short: the rest of the window is the end of events.jsonl.1.
    if (start === 0) {
      try {
        const prev = `${this.file}.1`;
        const size = fs.statSync(prev).size;
        const from = Math.max(0, size - (TAIL_SCAN_BYTES - st.size));
        const before = this.readRange(prev, from, size);
        text = (from > 0 ? before.slice(before.indexOf('\n') + 1) : before) + text;
      } catch {
        /* no previous file */
      }
    }
    let lines = text.split('\n');
    if (start > 0) lines = lines.slice(1); // first line is cut
    return this.parse(lines.filter((l) => l.trim()).slice(-max));
  }

  /** Events appended since the last call. */
  readNew(): Obj[] {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch {
      return [];
    }
    let carried: Obj[] = [];
    if (st.ino !== this.ino || st.size < this.offset) {
      if (this.ino !== -1) {
        const rotated = st.ino !== this.ino ? this.finishRotated() : null;
        if (rotated) carried = rotated;
        else this.warn(`${this.file} was replaced or truncated; reading it again`);
      }
      this.ino = st.ino;
      this.offset = 0;
      this.partial = '';
    }
    if (st.size === this.offset) return carried;
    const text = this.partial + this.readRange(this.file, this.offset, st.size);
    this.offset = st.size;
    const lines = text.split('\n');
    this.partial = lines.pop() ?? '';
    return carried.concat(this.parse(lines.filter((l) => l.trim())));
  }

  /** The file we were reading became `<file>.1` (a rotation): its lines we have not read yet. */
  private finishRotated(): Obj[] | null {
    try {
      const prev = `${this.file}.1`;
      const st = fs.statSync(prev);
      if (st.ino !== this.ino || st.size < this.offset) return null;
      if (st.size === this.offset) return [];
      const lines = (this.partial + this.readRange(prev, this.offset, st.size)).split('\n');
      lines.pop(); // an unterminated last line was never a whole event
      return this.parse(lines.filter((l) => l.trim()));
    } catch {
      return null;
    }
  }

  private readRange(file: string, start: number, end: number): string {
    if (end <= start) return '';
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(end - start);
      const n = fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf-8', 0, n);
    } finally {
      fs.closeSync(fd);
    }
  }

  private parse(lines: string[]): Obj[] {
    const out: Obj[] = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as unknown;
        if (typeof e === 'object' && e !== null && !Array.isArray(e)) out.push(e as Obj);
        else this.warn('events.jsonl: skipped a non-object line');
      } catch {
        this.warn('events.jsonl: skipped a broken line');
      }
    }
    return out;
  }
}
