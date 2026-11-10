/**
 * DEVROOM-PROJECT: the dev room's 프로젝트 추가 (Orca's "add project"), the git half. The add
 * itself stays the engine's (an `engineAction` add makes the project's Lead); this gets the
 * folder's repository ready first:
 *
 *   projectRepo {action: check, folder}            -> is it inside a git work tree
 *   projectRepo {action: init,  folder}            -> `git init` there
 *   projectRepo {action: clone, folder, url, name} -> `git clone url folder/name`
 *
 * Folders follow the folder picker's rules (folders.ts listFolders: home and drives only, no
 * protected folder, no symlink out); a clone's target must not exist yet and is removed again
 * when the clone fails. Every git call is the daemon's guarded runner (gitRun.ts: hooks,
 * fsmonitor, filters and submodules off); a clone may use http(s), ssh, git and local folders,
 * never `ext::` or `fd::`.
 */
import * as fs from 'fs';
import * as path from 'path';

import { checkNewFolderName, projectPathKey } from '../../../core/src/agent-tycoon/projectPath.js';
import { refused, type WithError } from '../../../core/src/agent-tycoon/serverText.js';
import type { HostInfo, ProjectRepo, ProjectRepoProgress, ProjectRepoResult } from '../../../core/src/messages.js';
import { PROJECT_CLONE_PROGRESS_MS, PROJECT_CLONE_TIMEOUT_MS } from '../constants.js';
import { CloneProgressReader, throttled } from './cloneProgress.js';
import { createGitRunner, type GitRunner, RepoError } from './engine/git/gitRun.js';
import { forbiddenAbsolutePath } from './files/security.js';
import { findFolder, folderRoots, listFolders } from './folders.js';
import type { SocketStepUp } from './hooks.js';
import { STEPUP_REQUIRED } from './shell/gate.js';

const ACTIONS = new Set(['check', 'init', 'clone']);
const FIELD_MAX = 4096;
const WHY_MAX = 300;
/** What a clone may talk: never `ext::<command>` or `fd::`. */
const CLONE_PROTOCOLS = 'http:https:ssh:git:file';
const URL_RE = /^(?:(?:https?|ssh|git):\/\/[^\s]+|[\w.-]+@[\w.-]+:[^\s]+)$/i;

export function parseProjectRepo(msg: Record<string, unknown>): ProjectRepo | null {
  const { requestId, action, folder, url, name } = msg;
  if (typeof requestId !== 'string' || !requestId || requestId.length > 128) return null;
  if (typeof action !== 'string' || !ACTIONS.has(action)) return null;
  if (typeof folder !== 'string' || folder.length > FIELD_MAX) return null;
  for (const v of [url, name]) if (v !== undefined && (typeof v !== 'string' || v.length > FIELD_MAX)) return null;
  return {
    type: 'projectRepo',
    requestId,
    action: action as ProjectRepo['action'],
    folder,
    ...(typeof url === 'string' && { url }),
    ...(typeof name === 'string' && { name }),
  };
}

/** A folder the picker would show (as it is on disk: its case and NFD spelling), or why not. */
function pickable(folder: string, host: HostInfo): { path: string } | WithError {
  const l = listFolders({ type: 'listFolders', requestId: '-', path: folder }, host);
  if (l.ok && l.path) return { path: findFolder(l.path, host) ?? l.path };
  return l.error ? { error: l.error, errorCode: l.errorCode, errorParams: l.errorParams } : refused('folder_unreadable');
}

/** git's own reason, one line (its `fatal:` line when there is one). */
const whyOf = (stderr: string): string => {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => l.startsWith('fatal:')) ?? lines.pop() ?? '?').slice(0, WHY_MAX);
};

export interface ProjectRepoOptions {
  host: HostInfo;
  readOnly: boolean;
  /** The guarded runner (tests pin git's config). Default: git on PATH. */
  run?: GitRunner;
  log?: (line: string) => void;
}

export class ProjectRepos {
  private run: GitRunner | null;
  /** Clone targets in flight: a double tap must not clone twice (nor remove the first one's folder). */
  private readonly cloning = new Set<string>();
  /** CLONE-PROGRESS: the running clones by their request, for projectRepoCancel. */
  private readonly stops = new Map<string, AbortController>();

  constructor(private readonly o: ProjectRepoOptions) {
    this.run = o.run ?? null;
  }

  /** CLONE-PROGRESS: stop the clone of request `requestId` (the owner's; unknown or done: nothing). */
  cancel(requestId: string, privileged: boolean): void {
    if (privileged) this.stops.get(requestId)?.abort();
  }

  /** `progress`: where a clone is (throttled), for the requesting client only. */
  async handle(
    req: ProjectRepo,
    privileged: boolean,
    stepUp?: SocketStepUp,
    progress?: (p: ProjectRepoProgress) => void,
  ): Promise<ProjectRepoResult> {
    const base = { type: 'projectRepoResult' as const, requestId: req.requestId, action: req.action };
    const fail = (r: WithError): ProjectRepoResult => ({ ...base, ok: false, ...r });
    if (!privileged) return fail(refused('no_permission'));
    if (req.action !== 'check' && this.o.readOnly) return fail(refused('read_only_mode'));
    // S1: a remote session fetches a stranger's repository onto the host only with a fresh proof.
    if (req.action === 'clone' && stepUp?.remote && !stepUp.fresh()) return fail({ error: STEPUP_REQUIRED });
    const at = pickable(req.folder, this.o.host);
    if ('error' in at) return fail(at);
    try {
      if (req.action === 'check') return { ...base, ok: true, folder: at.path, repo: await this.isRepo(at.path) };
      if (req.action === 'init') {
        // Never the home folder or a drive's top: every folder under it would be inside a repository.
        const key = projectPathKey(at.path, this.o.host).replace(/[\\/]+$/, '');
        if (folderRoots(this.o.host).some((r) => projectPathKey(r.path, this.o.host).replace(/[\\/]+$/, '') === key))
          return fail(refused('git_init_root'));
        const r = await this.git(at.path, ['init']);
        if (r.code !== 0) return fail(refused('git_init_failed', { why: whyOf(r.stderr) }));
        this.o.log?.(`git init ${at.path}`);
        return { ...base, ok: true, folder: at.path, repo: true };
      }
      return await this.clone(req, at.path, fail, progress);
    } catch (err) {
      return fail(err instanceof RepoError ? { error: err.message } : refused('clone_failed', { why: String(err).slice(0, WHY_MAX) }));
    }
  }

  private async clone(
    req: ProjectRepo,
    parent: string,
    fail: (r: WithError) => ProjectRepoResult,
    progress?: (p: ProjectRepoProgress) => void,
  ): Promise<ProjectRepoResult> {
    const url = (req.url ?? '').trim();
    const local = url.startsWith('/') || url.startsWith('~') || path.isAbsolute(url);
    if (!url || url.startsWith('-') || /\p{Cc}/u.test(url) || (!local && !URL_RE.test(url)))
      return fail(refused('clone_url_bad'));
    // A folder on the host as the source: the picker's rules too (never a protected folder).
    const source = local ? pickable(url, this.o.host) : { path: url };
    if ('error' in source) return fail(source);
    if (local) {
      const why = await this.sourceRefusal(source.path);
      if (why) return fail(why);
    }
    // From here to cloning.add nothing awaits: a second request for the same target sees the lock.
    const named = checkNewFolderName(req.name ?? '', this.o.host);
    if ('error' in named) return fail(named);
    const target = path.join(parent, named.name);
    if (forbiddenAbsolutePath(target, this.o.host.home)) return fail(refused('folder_forbidden'));
    // Keyed as the host compares folders: Foo and foo are one folder where the file system folds case.
    const lock = projectPathKey(target, this.o.host);
    if (this.cloning.has(lock)) return fail(refused('clone_running'));
    if (fs.existsSync(target)) return fail(refused('clone_exists', { folder: target }));
    this.cloning.add(lock);
    const stop = new AbortController();
    this.stops.set(req.requestId, stop);
    const report = throttled((p) => progress?.({ type: 'projectRepoProgress', requestId: req.requestId, ...p }), PROJECT_CLONE_PROGRESS_MS);
    const reader = new CloneProgressReader(report.push);
    try {
      this.o.log?.(`git clone into ${target}`);
      // --no-local: a folder source goes through git's own transport (no hard links, no copied
      // objects/info/alternates). LFS: the repository's .gitattributes/.lfsconfig fetch nothing.
      // Detached: no controlling terminal, so ssh cannot stop to ask on one.
      // --progress: git writes its phases even with no terminal (CLONE-PROGRESS).
      const r = await this.git(parent, ['clone', '--progress', ...(local ? ['--no-local'] : []), '--', source.path, target], {
        timeoutMs: PROJECT_CLONE_TIMEOUT_MS,
        protocols: CLONE_PROTOCOLS,
        env: { GIT_LFS_SKIP_SMUDGE: '1' },
        detached: true,
        onStderr: (chunk) => reader.push(chunk),
        signal: stop.signal,
      });
      reader.end();
      report.stop();
      if (r.code === 0 && !stop.signal.aborted)
        return { type: 'projectRepoResult', requestId: req.requestId, action: 'clone', ok: true, folder: target, repo: true };
      // The folder did not exist before: whatever is there is this clone's half (git has exited).
      fs.rmSync(target, { recursive: true, force: true });
      if (stop.signal.aborted) {
        this.o.log?.(`git clone into ${target}: cancelled, folder removed`);
        return fail(refused('clone_cancelled'));
      }
      return fail(r.timedOut ? refused('clone_timeout') : refused('clone_failed', { why: whyOf(reader.other.join('\n')) }));
    } finally {
      report.stop();
      this.stops.delete(req.requestId);
      this.cloning.delete(lock);
    }
  }

  /** A folder source whose repository is really elsewhere (`.git` a symlink or a `gitdir:` file):
   *  that git directory, and its common one, must not be a protected folder either. */
  private async sourceRefusal(source: string): Promise<WithError | null> {
    const r = await this.git(source, ['rev-parse', '--absolute-git-dir', '--git-common-dir']);
    if (r.code !== 0) return refused('clone_failed', { why: whyOf(r.stderr) });
    for (const line of r.stdout.toString('utf-8').split('\n').map((l) => l.trim()).filter(Boolean)) {
      let real: string;
      try {
        real = fs.realpathSync(path.resolve(source, line));
      } catch {
        return refused('folder_unreadable');
      }
      // A work tree's own `.git` is fine; what it sits in is what counts.
      if (forbiddenAbsolutePath(real.replace(/[\\/]\.git(?=[\\/]|$)/gi, ''), this.o.host.home)) return refused('folder_forbidden');
    }
    return null;
  }

  private async isRepo(folder: string): Promise<boolean> {
    const r = await this.git(folder, ['rev-parse', '--is-inside-work-tree']);
    return r.code === 0 && r.stdout.toString('utf-8').trim() === 'true';
  }

  private git(cwd: string, args: string[], opts?: Parameters<GitRunner>[2]) {
    this.run ??= createGitRunner();
    return this.run(cwd, args, opts);
  }
}
