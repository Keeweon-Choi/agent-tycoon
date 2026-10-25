/**
 * Pruning of the two log folders (U-42, policy in logPolicy.ts): the logs of FINISHED
 * jobs (~/.local/state/cld-gui/jobs) and Codex tasks (.../codex). Deleting is the risky
 * part, so a file goes only when ALL of these hold: it is named after a record the
 * engine wrote (`<id>.log` / `<id>.jsonl`, id in the engine's pattern), that record says
 * the job/task is finished, the path is a plain file (no symlink) directly inside the
 * folder's real path. Anything else in the folders is left alone. Never throws.
 */
import * as fs from 'fs';
import * as path from 'path';

import { codexDir, ID_RE as CODEX_ID_RE } from './codex.js';
import { ID_RE as JOB_ID_RE, jobsDir } from './jobs.js';
import { LOG_DIR_CAP_BYTES, LOG_KEEP_DAYS } from './logPolicy.js';

const DAY = 86_400_000;

export interface Tally {
  count: number;
  bytes: number;
}
export interface PruneResult {
  jobs: Tally;
  codex: Tally;
}
export interface PruneOptions {
  home: string;
  platform?: NodeJS.Platform;
  now?: number;
  keepDays?: number;
  capBytes?: number;
  /** Test seam; the default is fs.unlinkSync. */
  unlink?: (file: string) => void;
  log?: (line: string) => void;
}

/** A finished job/task: its log, what goes with it when it is old, when it ended. */
interface Finished {
  ended: number;
  log: string;
  records: string[];
}

function finishedIn(
  dir: string,
  idRe: RegExp,
  logExt: string,
  pick: (r: Record<string, unknown>) => boolean,
  records: (id: string) => string[],
): Finished[] {
  const out: Finished[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const id = n.slice(0, -5);
    if (!idRe.test(id)) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf-8')) as Record<string, unknown>;
      const ended = typeof r?.ended === 'string' ? Date.parse(r.ended) : NaN;
      if (r.id !== id || !Number.isFinite(ended) || !pick(r)) continue;
      out.push({ ended, log: `${id}${logExt}`, records: records(id) });
    } catch {
      /* not a record we can read: not ours to judge */
    }
  }
  return out;
}

/** The size of a plain file directly in `folder`; null for anything else (symlink, directory, a name that is a path). */
export function plainFileSize(folder: string, name: string): number | null {
  if (name !== path.basename(name)) return null;
  const file = path.join(folder, name);
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && path.dirname(file) === folder ? st.size : null;
  } catch {
    return null;
  }
}

function pruneFolder(dir: string, found: Finished[], o: Required<PruneOptions>): Tally {
  const tally: Tally = { count: 0, bytes: 0 };
  let real: string;
  try {
    // A folder that is itself a symlink may lead anywhere: not ours to prune.
    if (fs.lstatSync(dir).isSymbolicLink()) {
      o.log(`log prune: ${dir} is a symlink (skipped)`);
      return tally;
    }
    real = fs.realpathSync(dir);
  } catch {
    return tally;
  }
  const plain = (name: string) => plainFileSize(real, name);
  const remove = (name: string, counted: boolean): boolean => {
    const size = plain(name);
    if (size === null) return true; // already gone or not ours: nothing to delete
    try {
      o.unlink(path.join(real, name));
    } catch (err) {
      o.log(`log prune: ${name}: ${err instanceof Error ? err.message : String(err)} (skipped)`);
      return false;
    }
    if (counted) {
      tally.count++;
      tally.bytes += size;
    }
    return true;
  };
  const left: Finished[] = [];
  for (const f of found) {
    if (o.now - f.ended > o.keepDays * DAY) {
      if (remove(f.log, true)) for (const r of f.records) remove(r, false);
    } else left.push(f);
  }
  let total = 0;
  try {
    for (const n of fs.readdirSync(real)) total += plain(n) ?? 0;
  } catch {
    return tally;
  }
  for (const f of left.sort((a, b) => a.ended - b.ended)) {
    if (total <= o.capBytes) break;
    const size = plain(f.log);
    if (size !== null && remove(f.log, true)) total -= size;
  }
  return tally;
}

export function pruneLogs(opts: PruneOptions): PruneResult {
  const o: Required<PruneOptions> = {
    platform: process.platform,
    now: Date.now(),
    keepDays: LOG_KEEP_DAYS,
    capBytes: LOG_DIR_CAP_BYTES,
    unlink: (f) => fs.unlinkSync(f),
    log: (l) => console.log(`[cld engine] ${l}`),
    ...opts,
  };
  const none = (): Tally => ({ count: 0, bytes: 0 });
  const result: PruneResult = { jobs: none(), codex: none() };
  try {
    const jobs = jobsDir(o.home, o.platform);
    // A job is finished once the engine recorded its end (a running job's record has none).
    result.jobs = pruneFolder(
      jobs,
      finishedIn(jobs, JOB_ID_RE, '.log', () => true, (id) => [`${id}.json`, `${id}.exit`, `${id}.gpu`]),
      o,
    );
    const codex = codexDir(o.home, o.platform);
    result.codex = pruneFolder(
      codex,
      finishedIn(
        codex,
        CODEX_ID_RE,
        '.jsonl',
        (r) => r.state === 'done' || r.state === 'failed' || r.state === 'stopped',
        // D5: a Codex Worker run's prompt (its message), last message and told mark go with it.
        (id) => [`${id}.json`, `${id}.prompt.md`, `${id}.last.md`, `${id}.told`],
      ),
      o,
    );
  } catch (err) {
    o.log(`log prune: ${err instanceof Error ? err.message : String(err)}`);
  }
  const mb = (t: Tally) => `${t.count} (${(t.bytes / 1024 / 1024).toFixed(1)} MB)`;
  o.log(`log prune: jobs ${mb(result.jobs)}, codex ${mb(result.codex)} removed`);
  return result;
}
