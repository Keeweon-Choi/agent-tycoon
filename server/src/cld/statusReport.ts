import * as path from 'path';

import { koText } from '../../../core/src/cld/serverText.js';
import type { StatusOutput } from '../../../core/src/messages.js';
import type { GitRunner } from './engine/git/gitRun.js';
import { createGitRunner, READ_ENV } from './engine/git/gitRun.js';

const GIT_TIMEOUT_MS = 5_000;
/** W2: the one git runner (gitRun.ts): no hook, fsmonitor, submodule or repository filter runs. */
let runner: GitRunner | null = null;

export interface StatusJob {
  project: string | null;
  cmd: string;
  started: string;
  ended: string | null;
  exit: number | null;
}

function git(dir: string, args: string[]): Promise<string | null> {
  runner ??= createGitRunner();
  return runner(path.resolve(dir), args, { timeoutMs: GIT_TIMEOUT_MS, maxBytes: 64 * 1024, env: READ_ENV }).then(
    (r) => (r.code === 0 ? r.stdout.toString('utf-8') : null),
    () => null,
  );
}

function recent(text: string | null) {
  if (!text) return [];
  return text
    .split('\x1e')
    .filter(Boolean)
    .map((line) => line.split('\x1f'))
    .filter((fields): fields is [string, string, string] => fields.length === 3)
    .map(([hash, subject, time]) => ({ hash, subject, time: time || null }));
}

/** The read-only git part shared by the local engine and Claude session reports. */
export async function gitSummary(dir: string): Promise<StatusOutput['git']> {
  const workTree = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (workTree?.trim() !== 'true') return null;
  const [branch, dirty, log] = await Promise.all([
    git(dir, ['branch', '--show-current']),
    git(dir, ['status', '--porcelain']),
    git(dir, ['log', '-5', '--format=%H%x1f%s%x1f%cI%x1e']),
  ]);
  return {
    branch: branch?.trim() || null,
    dirty: dirty === null ? null : dirty.split('\n').filter(Boolean).length,
    recent: recent(log),
  };
}

function jobState(job: StatusJob): string {
  if (!job.ended) return 'running';
  return job.exit === 0 ? 'done' : 'failed';
}

function startTime(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return '??:??';
  return `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
}

/** The output portion of a local engine project report. */
export function engineJobsOutput(project: string, jobs: StatusJob[]): string {
  const lines = jobs
    .filter((job) => job.project === project)
    .sort((a, b) => Date.parse(b.started) - Date.parse(a.started))
    .slice(0, 10)
    .map((job) => `${jobState(job)} ${job.cmd} (${startTime(job.started)})`);
  return lines.join('\n') || koText('no_running_jobs');
}

/** The project report, local; it never runs a project command. */
export async function localStatusReport(
  name: string,
  dir: string,
  output: string,
): Promise<Omit<StatusOutput, 'type'>> {
  // ponytail: a local-only status command set by cld-gui on this host is the upgrade path.
  return {
    name,
    cmd: null,
    isDefault: true,
    exit: 0,
    output,
    truncated: false,
    git: await gitSummary(dir),
  };
}
