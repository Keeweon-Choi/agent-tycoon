/**
 * P4 (개발실, W3 워크트리 정리): the task worktrees worth cleaning up (merged, or no new commit
 * for a day), with each folder's size: measured in the background (FolderSizes) and kept a while,
 * so the list answers at once and its sizes follow.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { RepoCleanupRow, RepoWorktree } from '../../../../../core/src/messages.js';
import type { GitRunner } from './gitRun.js';
import { READ_ENV } from './gitRun.js';

/** A worktree with no new commit for this long is listed as idle. */
export const CLEANUP_IDLE_MS = 24 * 60 * 60_000;
/** The size walk of one folder stops after this (the row then says `sizeCapped`). */
export const SIZE_WALK_MS = 3_000;
/** A measured folder size is reused for this long. */
export const SIZE_KEEP_MS = 10 * 60_000;

/** Every local branch's tip: its commit and when it was made. One git call per repository. */
export async function branchTips(run: GitRunner, top: string): Promise<Map<string, { sha: string; at: string }>> {
  const r = await run(top, ['for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(committerdate:iso-strict)', 'refs/heads/'], {
    env: READ_ENV,
  });
  const out = new Map<string, { sha: string; at: string }>();
  if (r.code !== 0) return out;
  for (const line of r.stdout.toString('utf-8').split('\n')) {
    const [name, sha, at] = line.split('\0');
    if (name && sha && at) out.set(name, { sha, at });
  }
  return out;
}

/** The bytes under `dir` (no link followed), stopping at `deadline`. */
export async function folderSize(dir: string, deadline: number): Promise<{ bytes: number; capped: boolean }> {
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    if (Date.now() > deadline) return { bytes, capped: true };
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile())
        try {
          bytes += (await fs.promises.lstat(p)).size;
        } catch {
          /* gone meanwhile */
        }
    }
  }
  return { bytes, capped: false };
}

/** Folder sizes, measured one folder at a time for the whole daemon and kept SIZE_KEEP_MS. */
export class FolderSizes {
  // ponytail: one entry per folder ever listed (a few hundred at most), never pruned.
  private readonly known = new Map<string, { bytes: number; capped: boolean; at: number }>();
  private walking: Promise<void> = Promise.resolve();

  get(dir: string, now = Date.now()): { bytes: number; capped: boolean } | undefined {
    const k = this.known.get(dir);
    return k && now - k.at < SIZE_KEEP_MS ? k : undefined;
  }

  /** Measure the folders not known yet, after any walk already running; resolves when done. */
  measure(dirs: readonly string[]): Promise<void> {
    this.walking = this.walking.then(async () => {
      for (const d of dirs)
        if (!this.get(d)) this.known.set(d, { ...(await folderSize(d, Date.now() + SIZE_WALK_MS)), at: Date.now() });
    });
    return this.walking;
  }
}

export interface CleanupInput {
  worktree: RepoWorktree;
  mergedAt?: string;
  /** Files changed against the base (asked only for an unmerged one). */
  changedFiles: () => Promise<number>;
}

/** The rows of the 정리 view; a folder whose size `sizeOf` does not know yet is `sizePending` and
 *  listed in `unsized` (to measure). */
export async function cleanupRows(
  list: readonly CleanupInput[],
  sizeOf: (dir: string) => { bytes: number; capped: boolean } | undefined,
  now = Date.now(),
): Promise<{ rows: RepoCleanupRow[]; unsized: string[] }> {
  const rows: RepoCleanupRow[] = [];
  const unsized: string[] = [];
  for (const { worktree: w, mergedAt, changedFiles } of list) {
    const last = w.lastChange ? Date.parse(w.lastChange) : NaN;
    const idle = Number.isFinite(last) && now - last >= CLEANUP_IDLE_MS;
    if (!w.merged && !idle) continue;
    const size = w.exists ? sizeOf(w.path) : { bytes: 0, capped: false };
    if (!size) unsized.push(w.path);
    rows.push({
      task: w.task,
      ...(w.taskId && { taskId: w.taskId }),
      ...(w.assignee && { assignee: w.assignee }),
      branch: w.branch,
      merged: w.merged,
      ...(mergedAt && { mergedAt }),
      ...(w.lastChange && { lastChange: w.lastChange }),
      sizeBytes: size?.bytes ?? 0,
      ...(size?.capped && { sizeCapped: true }),
      ...(!size && { sizePending: true }),
      unmergedFiles: w.merged ? 0 : await changedFiles().catch(() => 0),
      dirty: w.dirty,
    });
  }
  return { rows, unsized };
}
