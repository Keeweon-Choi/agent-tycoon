/**
 * W4: the merges W3 made (or refused), kept across restarts: `merge-history.json`
 * { "<project>": [RepoMerge, ...oldest first] }, at most 50 per project, written whole through a
 * temporary file and a rename. A file that cannot be read is treated as empty (and replaced by the
 * next merge): the history is a record for the screen, never an input to a decision.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { RepoMerge } from '../../../../../core/src/messages.js';

export const HISTORY_PER_PROJECT = 50;
const ERROR_MAX = 400;

const isMerge = (m: unknown): m is RepoMerge => {
  const o = m as Record<string, unknown> | null;
  return (
    typeof o === 'object' && o !== null && typeof o.ok === 'boolean' && typeof o.at === 'string' &&
    typeof o.target === 'string' && typeof o.auto === 'boolean'
  );
};

export class MergeHistory {
  constructor(private readonly file: string) {}

  private read(): Record<string, RepoMerge[]> {
    try {
      const data: unknown = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
      return Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, Array.isArray(v) ? v.filter(isMerge) : []]),
      );
    } catch {
      return {};
    }
  }

  /** The project's merges, newest first (at most `n`). */
  list(project: string, n = HISTORY_PER_PROJECT): RepoMerge[] {
    return (this.read()[project] ?? []).slice(-n).reverse();
  }

  /** The newest merge of one worktree. */
  last(project: string, task: string): RepoMerge | undefined {
    return this.list(project).find((m) => m.task === task);
  }

  add(project: string, entry: RepoMerge): void {
    const all = this.read();
    const clean = { ...entry, ...(entry.error && { error: entry.error.slice(0, ERROR_MAX) }) };
    all[project] = [...(all[project] ?? []), clean].slice(-HISTORY_PER_PROJECT);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
