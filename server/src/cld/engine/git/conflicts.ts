/**
 * P4 (개발실, W2): a task worktree's conflicts with its base, resolved inside that worktree.
 *
 *   sync      merge the base into the task branch there (refused while its agent works or it has
 *             uncommitted changes); a conflict leaves the merge in progress, nothing else moves
 *   list      the unmerged files and their marker blocks
 *   resolve   one file's blocks, each by the owner's choice (ours = the task branch, theirs = the
 *             base, both, keep), refused when the block count changed; no block left: staged
 *   continue  commit the merge once nothing is unmerged
 *   abort     `merge --abort`: the worktree as it was before the sync
 *
 * Never a side picked automatically (owner 11-01 01:20). The runner keeps hooks and filters off.
 */
import * as fs from 'fs';
import * as path from 'path';

import { koText } from '../../../../../core/src/cld/serverText.js';
import type { RepoConflictChoice, RepoConflictFile } from '../../../../../core/src/messages.js';
import type { GitRunner } from './gitRun.js';
import { LITERAL_ENV, READ_ENV, RepoError } from './gitRun.js';
import { gitMessage, readStatus } from './repoRead.js';
import { operationInProgress } from './worktrees.js';

const SYNC_TIMEOUT_MS = 120_000;
/** A conflicted file larger than this is listed without its text (and cannot be resolved here). */
export const CONFLICT_TEXT_MAX = 1024 * 1024;
const CONFLICT_FILES_MAX = 50;

export interface ConflictBlock {
  startLine: number;
  endLine: number;
  ours: string;
  theirs: string;
}

interface Block {
  startLine: number;
  endLine: number;
  ours: string[];
  theirs: string[];
}

function blocksOf(lines: readonly string[]): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('<<<<<<<')) continue;
    const ours: string[] = [];
    const theirs: string[] = [];
    let part: 'ours' | 'base' | 'theirs' = 'ours';
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (part === 'ours' && l.startsWith('|||||||')) part = 'base';
      else if (part !== 'theirs' && l.startsWith('=======')) part = 'theirs';
      else if (part === 'theirs' && l.startsWith('>>>>>>>')) break;
      else if (part === 'ours') ours.push(l);
      else if (part === 'theirs') theirs.push(l);
    }
    if (j >= lines.length) break; // an unterminated block is not a conflict block
    out.push({ startLine: i + 1, endLine: j + 1, ours, theirs });
    i = j;
  }
  return out;
}

/** The blocks of `text` (merge or diff3 style markers), 1-based lines, markers included. */
export function parseConflicts(text: string): ConflictBlock[] {
  return blocksOf(text.split('\n')).map((b) => ({ ...b, ours: b.ours.join('\n'), theirs: b.theirs.join('\n') }));
}

/** `text` with block n replaced by `choices[n]` (keep: as it is). Null when the count differs. */
export function applyChoices(text: string, choices: readonly RepoConflictChoice[]): string | null {
  const lines = text.split('\n');
  const blocks = blocksOf(lines);
  if (blocks.length !== choices.length) return null;
  const out: string[] = [];
  let at = 0;
  blocks.forEach((b, n) => {
    out.push(...lines.slice(at, b.startLine - 1));
    const pick = choices[n];
    if (pick === 'keep') out.push(...lines.slice(b.startLine - 1, b.endLine));
    else if (pick === 'ours') out.push(...b.ours);
    else if (pick === 'theirs') out.push(...b.theirs);
    else out.push(...b.ours, ...b.theirs);
    at = b.endLine;
  });
  out.push(...lines.slice(at));
  return out.join('\n');
}

async function unmerged(run: GitRunner, wt: string): Promise<string[]> {
  const r = await run(wt, ['diff', '--name-only', '--diff-filter=U', '-z'], { env: READ_ENV });
  if (r.code !== 0) throw new RepoError(koText('git_status_unreadable'));
  return r.stdout.toString('utf-8').split('\0').filter(Boolean);
}

async function merging(run: GitRunner, wt: string): Promise<boolean> {
  return (await operationInProgress(run, wt)) === 'merge';
}

/** Read a conflicted file of the worktree: never through a link, never outside it. */
function readInside(wt: string, rel: string): string | null {
  const file = path.resolve(wt, rel);
  if (!file.startsWith(wt + path.sep)) return null;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > CONFLICT_TEXT_MAX) return null;
    const text = fs.readFileSync(file, 'utf-8');
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
}

export interface SyncOutcome {
  ok: boolean;
  code?: string;
  error?: string;
  detail?: string;
  conflicts?: string[];
}

/** Merge `base` into the branch checked out in worktree `wt`. `busy`: its agent is working now. */
export async function syncBase(run: GitRunner, wt: string, base: string, busy: boolean): Promise<SyncOutcome> {
  if (busy) return { ok: false, code: 'agent_busy', error: koText('sync_agent_busy') };
  const op = await operationInProgress(run, wt);
  if (op) return { ok: false, code: 'in_progress', error: koText('repo_busy', { operation: op }) };
  if ((await readStatus(run, wt, Infinity)).files.length)
    return { ok: false, code: 'dirty', error: koText('sync_dirty') };
  const m = await run(
    wt,
    ['-c', 'rerere.enabled=false', '-c', 'merge.conflictStyle=merge', 'merge', '--no-edit', '--no-stat',
      '--no-gpg-sign', '--no-verify', '-m', `Merge ${base} into this task`, `refs/heads/${base}`],
    { timeoutMs: SYNC_TIMEOUT_MS },
  );
  if (m.code === 0) return { ok: true, detail: koText('sync_done', { base }) };
  const files = await unmerged(run, wt);
  if (!files.length) {
    if (await merging(run, wt)) await run(wt, ['merge', '--abort']);
    return { ok: false, code: 'git_failed', error: koText('merge_failed', { why: gitMessage(m.stderr) }) };
  }
  return { ok: true, detail: koText('sync_conflict', { base, count: files.length }), conflicts: files.slice(0, CONFLICT_FILES_MAX) };
}

/** The unmerged files of the merge in progress in `wt`, with their blocks. */
export async function listConflicts(run: GitRunner, wt: string): Promise<{ merging: boolean; files: RepoConflictFile[] }> {
  const files = (await unmerged(run, wt)).slice(0, CONFLICT_FILES_MAX);
  return {
    merging: await merging(run, wt),
    files: files.map((p) => {
      const text = readInside(wt, p);
      return { path: p, blocks: text === null ? [] : parseConflicts(text), ...(text !== null && { text }) };
    }),
  };
}

/** Apply the owner's choices to one unmerged file; staged when no block is left. */
export async function resolveFile(
  run: GitRunner,
  wt: string,
  rel: string,
  choices: readonly RepoConflictChoice[],
): Promise<SyncOutcome> {
  if (!(await unmerged(run, wt)).includes(rel)) return { ok: false, code: 'not_conflicted', error: koText('conflict_file_unknown') };
  const text = readInside(wt, rel);
  if (text === null) return { ok: false, code: 'unreadable', error: koText('conflict_file_unreadable') };
  const next = applyChoices(text, choices);
  if (next === null) return { ok: false, code: 'changed', error: koText('conflict_blocks_changed') };
  const file = path.resolve(wt, rel);
  const tmp = `${file}.cld-${process.pid}.tmp`;
  fs.writeFileSync(tmp, next, { mode: fs.statSync(file).mode });
  fs.renameSync(tmp, file);
  const left = parseConflicts(next).length;
  if (left) return { ok: true, detail: koText('conflict_blocks_left', { count: left }) };
  const add = await run(wt, ['add', '--', rel], { env: LITERAL_ENV });
  if (add.code !== 0) return { ok: false, code: 'git_failed', error: koText('git_failed_why', { why: gitMessage(add.stderr) }) };
  return { ok: true, detail: koText('conflict_file_resolved') };
}

/** Commit the sync merge once every file is resolved. */
export async function continueMerge(run: GitRunner, wt: string): Promise<SyncOutcome> {
  if (!(await merging(run, wt))) return { ok: false, code: 'no_merge', error: koText('no_merge_in_progress') };
  const left = await unmerged(run, wt);
  if (left.length) return { ok: false, code: 'unresolved', error: koText('conflicts_left', { count: left.length }), conflicts: left };
  const c = await run(wt, ['commit', '--no-edit', '--no-verify', '--no-gpg-sign']);
  if (c.code !== 0) return { ok: false, code: 'git_failed', error: koText('git_failed_why', { why: gitMessage(c.stderr) }) };
  return { ok: true, detail: koText('sync_committed') };
}

/** Abort the sync merge: the worktree back to its commit before it. */
export async function abortMerge(run: GitRunner, wt: string): Promise<SyncOutcome> {
  if (!(await merging(run, wt))) return { ok: false, code: 'no_merge', error: koText('no_merge_in_progress') };
  const a = await run(wt, ['merge', '--abort']);
  if (a.code !== 0) return { ok: false, code: 'git_failed', error: koText('git_failed_why', { why: gitMessage(a.stderr) }) };
  return { ok: true, detail: koText('sync_aborted') };
}
