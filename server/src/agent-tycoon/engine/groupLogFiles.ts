/**
 * A group room's log is one file per room per month: `groups/<room>.<YYYY-MM>.jsonl` (UTC month of the
 * time it was written). A month older than GROUP_LOG_GZIP_AFTER_MONTHS becomes `….jsonl.gz`; nothing here ever
 * deletes history. The log of earlier versions, `groups/<room>.jsonl`, is the oldest segment until
 * `maintainGroupLogs` splits it by month (idempotent: a crash leaves the old file whole, and a rerun
 * gives the same files).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

import { GROUP_LOG_GZIP_AFTER_MONTHS } from '../../constants.js';

export const monthOf = (at: number): string => new Date(at).toISOString().slice(0, 7);

/** The month `n` months before the month of `at`. */
const monthsBefore = (at: number, n: number): string => {
  const d = new Date(at);
  return monthOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1));
};

export const monthFile = (dir: string, room: string, at: number): string =>
  path.join(dir, `${room}.${monthOf(at)}.jsonl`);

/** The room's files, oldest first: the earlier-version file, then each month (its .gz before its plain file). */
export function roomSegments(dir: string, room: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const own = `${room}.`;
  const months: Array<{ month: string; name: string }> = [];
  for (const name of names) {
    const m = name.startsWith(own) ? /^(\d{4}-\d{2})\.jsonl(\.gz)?$/.exec(name.slice(own.length)) : null;
    if (m) months.push({ month: m[1], name });
  }
  months.sort((a, b) => a.month.localeCompare(b.month) || b.name.length - a.name.length); // .gz (longer) first
  return [
    ...(names.includes(`${room}.jsonl`) ? [path.join(dir, `${room}.jsonl`)] : []),
    ...months.map((m) => path.join(dir, m.name)),
  ];
}

/** A segment's text; null when unreadable. */
export function readSegment(file: string): string | null {
  try {
    return file.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf-8') : fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

function writeFileAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** A record's own time (a post's `at`), or null (a delivery record, a line that is no record). */
function lineAt(line: string): number | null {
  try {
    const at = (JSON.parse(line) as { post?: { at?: unknown } }).post?.at;
    return typeof at === 'number' && Number.isFinite(at) && !Number.isNaN(new Date(at).getTime()) ? at : null;
  } catch {
    return null;
  }
}

/**
 * Split `<room>.jsonl` by month, then remove it. A line with no time of its own goes with the line
 * before it, months never go backwards (so reading the months in order is the file's order), and
 * what a month file already holds (a rerun, a downgrade in between) is kept after the split lines.
 */
// ponytail: the whole file is read at once; a room log is megabytes, not gigabytes.
export function splitLegacyLog(dir: string, room: string): void {
  const legacy = path.join(dir, `${room}.jsonl`);
  let text: string;
  let fallback: string;
  try {
    text = fs.readFileSync(legacy, 'utf-8');
    fallback = monthOf(fs.statSync(legacy).mtimeMs);
  } catch {
    return;
  }
  const lines = text.split('\n').filter(Boolean);
  let current = '';
  const months = lines.map((line) => {
    const at = lineAt(line);
    if (at !== null && monthOf(at) > current) current = monthOf(at);
    return current;
  });
  const lead = months.find(Boolean) ?? fallback; // lines before the first timed one
  const byMonth = new Map<string, string[]>();
  lines.forEach((line, i) => {
    const month = months[i] || lead;
    byMonth.set(month, [...(byMonth.get(month) ?? []), line]);
  });
  for (const [month, own] of byMonth) {
    const file = path.join(dir, `${room}.${month}.jsonl`);
    let kept: string[] = [];
    try {
      const have = new Set(own);
      kept = fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l && !have.has(l));
    } catch {
      /* none yet */
    }
    writeFileAtomic(file, `${[...own, ...kept].join('\n')}\n`);
  }
  fs.unlinkSync(legacy); // last: until here a rerun starts over from the whole file
}

/** gzip a plain month file (kept until the .gz is in place; an existing .gz of the month is extended). */
function gzipMonth(file: string): void {
  const text = fs.readFileSync(file, 'utf-8');
  const gz = `${file}.gz`;
  let old = '';
  try {
    old = zlib.gunzipSync(fs.readFileSync(gz)).toString('utf-8');
  } catch {
    /* no .gz yet */
  }
  writeFileAtomic(gz, zlib.gzipSync(old.endsWith(text) ? old : old + text));
  fs.unlinkSync(file);
}

/** Daily: split earlier-version logs, gzip months older than the limit. Never throws, never deletes history. */
export function maintainGroupLogs(dir: string, now: number, log: (line: string) => void): void {
  try {
    const cutoff = monthsBefore(now, GROUP_LOG_GZIP_AFTER_MONTHS);
    for (const name of fs.readdirSync(dir)) {
      const legacy = /^([^.]+)\.jsonl$/.exec(name);
      try {
        if (legacy) splitLegacyLog(dir, legacy[1]);
      } catch (err) {
        log(`group logs: ${name}: ${String(err)}`);
      }
    }
    for (const name of fs.readdirSync(dir)) {
      const m = /^[^.]+\.(\d{4}-\d{2})\.jsonl$/.exec(name);
      if (!m || m[1] >= cutoff) continue;
      try {
        gzipMonth(path.join(dir, name));
      } catch (err) {
        log(`group logs: ${name}: ${String(err)}`);
      }
    }
  } catch {
    /* no folder: no rooms yet */
  }
}
