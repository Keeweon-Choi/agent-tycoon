/**
 * Registry edits (E8, extracted from engine.ts): add (with a 계승), addWorker, edit, their
 * optional fields and provider checks, a Worker's own folder and the session-name clash check.
 * Every check returns the same error, in the same order, as before the move.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { PathHost } from '../../../../core/src/cld/projectPath.js';
import { normalizeProjectPath } from '../../../../core/src/cld/projectPath.js';
import { koText } from '../../../../core/src/cld/serverText.js';
import type { EngineAction, InheritableAgent } from '../../../../core/src/messages.js';
import { seededPermission } from '../newAgentPermission.js';
import { inheritProjectData, NameTaken, readNameHistory, takenBy } from '../projectData.js';
import type { AgentProvider } from './agents/types.js';
import { CODEX_EFFORTS, isCodexEffort } from './codex.js';
import { CLAUDE_ONLY, fail, LAUNCH_FIELDS, type Outcome, TEXT_FIELDS, warned } from './engineAction.js';
import type { ProjectRecord } from './registry.js';
import {
  CHECK,
  checkFolder,
  checkName,
  CLAUDE_PTY_PROVIDER,
  cliOf,
  createAssignmentId,
  createProjectId,
  DEFAULT_PROVIDER,
  linkWorkers,
  samePath,
  sessionName,
  WORKER_ROLES,
} from './registry.js';
import type { Live } from './sessionMatch.js';

const WORKER_ROOM = koText('worker_room');
const WORKER_FOLDER =
  koText('worker_folder');

function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The git repository holding `folder`: its nearest folder with a .git, or null. */
function repoRoot(folder: string): string | null {
  for (let d = realPath(folder); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

/** Where a Worker's own folder may be: inside its project's folder, or in the .worktrees/
 *  folder of the repository holding it (a project folder may be a subfolder of its repo). */
function workerRoots(projectFolder: string): string[] {
  const repo = repoRoot(projectFolder);
  return [realPath(projectFolder), ...(repo ? [path.join(repo, '.worktrees')] : [])];
}

export interface ProjectEditDeps {
  host: PathHost;
  home: string;
  projects: () => ProjectRecord[];
  agents: () => Map<string, AgentProvider>;
  find: (name: string) => ProjectRecord | undefined;
  holder: (p: ProjectRecord) => Live | null;
  collide: (a: ProjectRecord, b: ProjectRecord) => boolean;
  agentOf: (p: ProjectRecord) => AgentProvider | undefined;
  leads: () => ProjectRecord[];
  leadLaunch: (req: Pick<EngineAction, 'model' | 'effort'>) => Partial<ProjectRecord>;
  newClaude: (provider?: string) => string;
  /** The Engine's public inheritable() (the add dialog's list). */
  inheritable: (folder: string) => InheritableAgent[];
  refresh: () => void;
  commit: (next: ProjectRecord[]) => void;
  /** The Engine's dataChange: projectData's change between the office's flush and reload. */
  dataChange: (change: () => string[], names: string[]) => string[];
  log: (line: string) => void;
}

export class ProjectEdits {
  constructor(private readonly deps: ProjectEditDeps) {}

  /** PROJECT-DATA: why a new agent may not take `name`: data still kept under it (a store a
   *  remove from before name detaching left, or one written by hand), or null. */
  private leftoverData(name: string): string | null {
    const taken = takenBy(this.deps.home, name);
    return taken.length ? koText('name_data_exists', { name, stores: taken.join(', ') }) : null;
  }

  /** add/edit's optional fields: validated values to set, and keys to clear. */
  private fields(
    req: EngineAction,
  ): { set: Partial<ProjectRecord>; clear: Array<keyof ProjectRecord> } | { error: string } {
    const set: Partial<ProjectRecord> = {};
    const clear: Array<keyof ProjectRecord> = [];
    for (const key of TEXT_FIELDS) {
      const raw = req[key];
      if (raw === undefined) continue;
      if (raw.trim() === '') {
        clear.push(key);
        continue;
      }
      let value = raw.trim();
      if (key === 'rulesFile') {
        const n = normalizeProjectPath(value, this.deps.host);
        if ('error' in n) return { error: koText('rules_path_absolute') };
        value = n.path;
      }
      const error = CHECK[key](value);
      if (error) return { error };
      set[key] = value;
    }
    if (req.remoteControl === true) set.remoteControl = true;
    if (req.remoteControl === false) clear.push('remoteControl');
    if (req.alwaysOn === true) set.alwaysOn = true;
    if (req.alwaysOn === false) clear.push('alwaysOn');
    if (req.compactionNudge) set.compactionNudge = req.compactionNudge;
    else if (req.compactionNudge === 0) clear.push('compactionNudge');
    return { set, clear };
  }

  add(req: EngineAction): Outcome {
    const bad = checkName(req.name);
    if (bad) return fail(bad);
    // D5: a Lead is a Claude session (a Codex Lead is the app-server one, after the MVP).
    if (req.provider !== undefined && req.provider !== DEFAULT_PROVIDER && req.provider !== CLAUDE_PTY_PROVIDER)
      return fail(koText('lead_claude_only'));
    if (this.deps.find(req.name)) return fail(koText('name_taken'));
    const leftover = this.leftoverData(req.name);
    if (leftover) return fail(leftover);
    const provider = this.deps.newClaude();
    const n = normalizeProjectPath(req.folder ?? '', this.deps.host);
    if ('error' in n) return fail(n.error);
    const fields = this.fields(req);
    if ('error' in fields) return fail(fields.error);
    const f = checkFolder(n.path, this.deps.host, req.mkdir === true);
    if (f.missing) return { ok: false, error: koText('folder_missing'), folderMissing: true };
    if (!f.path) return fail(f.error ?? koText('folder_missing'));
    const next = [
      ...this.deps.projects(),
      {
        projectId: createProjectId(),
        leadAssignmentId: createAssignmentId(),
        name: req.name,
        folder: f.path,
        // O4: the owner's default for new agents, unless the request names a mode (even an empty one).
        ...(req.permissionMode === undefined && seededPermission(this.deps.home)),
        ...this.deps.leadLaunch(req),
        ...fields.set,
        ...(provider !== DEFAULT_PROVIDER && { provider }),
        ...(req.cloned === true && { cloned: true as const }),
        wantRunning: false,
      },
    ];
    return this.commitAdded(req, next, n.warnings);
  }

  /** add / addWorker's last step: the session-name check, the commit, then a 계승's records moved
   *  onto the new name. The commit goes first: a failed save moves nothing (the action fails and
   *  the 계승 is still offered), and a crash between the two leaves the agent without the records,
   *  still offered; nothing runs in between (all synchronous), so nothing writes under the new
   *  name first. A move that throws after the commit keeps the agent and says so. */
  private commitAdded(req: EngineAction, next: ProjectRecord[], warnings: string[]): Outcome {
    const clash = this.sessionClash(next, [req.name]);
    if (clash) return fail(clash);
    const added = next.at(-1)!;
    const heir = req.inheritFrom === undefined ? null : this.heirOf(req.inheritFrom, added.folder);
    if (heir && 'error' in heir) return fail(heir.error);
    const notes = [...warnings];
    // Its conversation goes on in the new agent (a copy when it was started under another name).
    if (heir?.sessionId) {
      added.sessionId = heir.sessionId;
      if (heir.name !== req.name) added.resumeAsCopy = true;
    }
    this.deps.commit(next);
    if (heir)
      try {
        let count = 1;
        const failed = this.deps.dataChange(() => {
          const r = inheritProjectData(this.deps.home, heir.key, req.name, (l) => this.deps.log(l));
          count = r.count;
          return r.failed;
        }, [heir.key, req.name]);
        notes.push(koText('inherited', { name: heir.name, count }));
        if (failed.length) notes.push(koText('data_not_moved', { stores: [...new Set(failed)].join(', ') }));
      } catch (err) {
        const why = err instanceof NameTaken ? err.stores.join(', ') : err instanceof Error ? err.message : String(err);
        this.deps.log(`inherit ${heir.key} -> ${req.name}: not moved (${why})`);
        notes.push(koText('inherit_not_moved', { why }));
      }
    return { ok: true, ...warned(notes) };
  }

  /** INHERIT: the removed agent `key` names, when a new agent in `folder` may take it over. */
  private heirOf(key: string, folder: string): { key: string; name: string; sessionId?: string } | { error: string } {
    const e = readNameHistory(this.deps.home).find((x) => x.as === key && x.gone);
    if (!e?.gone) return { error: koText('inherit_gone') };
    if (!samePath(e.gone.folder, folder, this.deps.host)) return { error: koText('inherit_other_folder') };
    if (!this.deps.inheritable(folder).some((a) => a.key === key)) return { error: koText('inherit_gone') };
    return { key, name: e.name, ...(e.gone.sessionId && { sessionId: e.gone.sessionId }) };
  }

  /**
   * D3: a Worker of a project, under its own name (unique among every project
   * and agent), stopped. Its folder is the project's unless given: a worktree,
   * inside the project's repository.
   */
  addWorker(req: EngineAction): Outcome {
    const bad = checkName(req.name);
    if (bad) return fail(bad);
    if (this.deps.find(req.name)) return fail(koText('name_taken'));
    const leftover = this.leftoverData(req.name);
    if (leftover) return fail(leftover);
    if (!req.role || !WORKER_ROLES.includes(req.role))
      return fail(koText('worker_role'));
    const lead = req.project !== undefined ? this.deps.find(req.project) : undefined;
    if (!lead || lead.role) return fail(koText('project_unknown_short'));
    if (req.room !== undefined) return fail(WORKER_ROOM);
    const provider = this.deps.newClaude(req.provider);
    const agent = this.deps.agents().get(provider);
    if (!agent) return fail(koText('agent_unknown', { provider }));
    const why = this.providerFields(agent, req) ?? agent.ready?.();
    if (why) return fail(why);
    const fields = this.fields(req);
    if ('error' in fields) return fail(fields.error);
    const own = this.workerFolder(lead, req.folder, req.mkdir === true);
    if ('ok' in own) return own;
    const next = [
      ...this.deps.projects(),
      {
        projectId: lead.projectId,
        assignmentId: createAssignmentId(),
        role: req.role,
        name: req.name,
        folder: own.path ?? lead.folder,
        ...(own.path && { workFolder: own.path }),
        ...(cliOf({ provider }) === DEFAULT_PROVIDER && req.permissionMode === undefined && seededPermission(this.deps.home)),
        ...fields.set,
        ...(provider !== DEFAULT_PROVIDER && { provider }),
        wantRunning: false,
      },
    ];
    return this.commitAdded(req, next, own.warnings);
  }

  /** D5: why `req` does not fit a 'run' provider's agent (Claude-only options, Codex's effort
   *  words), or null. */
  private providerFields(agent: AgentProvider, req: EngineAction): string | null {
    if (agent.capabilities.lifetime !== 'run') return null;
    const claudeOnly = CLAUDE_ONLY.filter((k) => req[k] !== undefined && req[k] !== '' && req[k] !== false && req[k] !== 0);
    if (claudeOnly.length) return koText('codex_no_setting', { names: claudeOnly.join(', ') });
    if (req.effort?.trim() && !isCodexEffort(req.effort.trim()))
      return koText('codex_effort', { values: CODEX_EFFORTS.join(' ') });
    return null;
  }

  /** A Worker's own folder: none (the project's), or an existing (or, with `mkdir`, new)
   *  folder inside the project's folder or its repository's .worktrees/ (a worktree). */
  workerFolder(
    lead: ProjectRecord,
    raw: string | undefined,
    mkdir: boolean,
  ): { path?: string; warnings: string[] } | Outcome {
    if (raw === undefined || raw.trim() === '') return { warnings: [] };
    const n = normalizeProjectPath(raw.trim(), this.deps.host);
    if ('error' in n) return fail(n.error);
    if (samePath(n.path, lead.folder, this.deps.host)) return { warnings: n.warnings };
    const roots = workerRoots(lead.folder);
    const inside = (dir: string) => {
      const d = realPath(dir);
      return roots.some((r) => d === r || d.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
    };
    // Checked before and after it may be created: never a folder made outside the repository.
    if (!inside(n.path)) return fail(WORKER_FOLDER);
    const c = checkFolder(n.path, this.deps.host, mkdir);
    if (c.missing) return { ok: false, error: koText('folder_missing'), folderMissing: true };
    if (!c.path) return fail(c.error ?? koText('folder_missing'));
    if (!inside(c.path)) return fail(WORKER_FOLDER);
    return { path: c.path, warnings: n.warnings };
  }

  edit(p: ProjectRecord, req: EngineAction): Outcome {
    if (p.role && req.room !== undefined) return fail(WORKER_ROOM);
    // ADR-0016 decision 2: an agent's provider is fixed when it is made. TERM-P1: a Claude agent
    // may move between `claude --bg` and our PTY host (same CLI, same conversation) while it is off.
    const was = p.provider ?? DEFAULT_PROVIDER;
    if (req.provider !== undefined && req.provider !== was) {
      const claudeKinds = [DEFAULT_PROVIDER, CLAUDE_PTY_PROVIDER];
      if (!claudeKinds.includes(was) || !claudeKinds.includes(req.provider)) return fail(koText('agent_kind_fixed'));
      this.deps.refresh();
      if (this.deps.holder(p)) return fail(koText('pty_switch_running'));
    }
    const agent = this.deps.agentOf(p);
    const notFit = agent && this.providerFields(agent, req);
    if (notFit) return fail(notFit);
    if (req.role !== undefined || req.project !== undefined)
      return fail(koText('role_project_fixed'));
    const fields = this.fields(req);
    if ('error' in fields) return fail(fields.error);
    let folder = p.folder;
    let workFolder = p.workFolder;
    let warnings: string[] = [];
    if (req.folder !== undefined) {
      const lead = p.role ? this.deps.leads().find((l) => l.projectId === p.projectId) : undefined;
      let want: string;
      if (lead) {
        const own = this.workerFolder(lead, req.folder, req.mkdir === true);
        if ('ok' in own) return own;
        want = own.path ?? lead.folder;
        workFolder = own.path;
        warnings = own.warnings;
      } else {
        const n = normalizeProjectPath(req.folder, this.deps.host);
        if ('error' in n) return fail(n.error);
        want = n.path;
        warnings = n.warnings;
      }
      if (!samePath(want, p.folder, this.deps.host)) {
        this.deps.refresh();
        // A Worker without a folder of its own moves with its project.
        const moving = this.deps.projects().filter(
          (x) => x === p || (!p.role && x.role && x.projectId === p.projectId && !x.workFolder),
        );
        if (moving.some((x) => this.deps.holder(x)))
          return fail(koText('folder_change_running'));
        if (!lead) {
          const c = checkFolder(want, this.deps.host, req.mkdir === true);
          if (c.missing) return { ok: false, error: koText('folder_missing'), folderMissing: true };
          if (!c.path) return fail(c.error ?? koText('folder_missing'));
          want = c.path;
        }
        folder = want;
      } else warnings = [];
    }
    const next: ProjectRecord = { ...p, folder, ...fields.set };
    if (req.provider === CLAUDE_PTY_PROVIDER) next.provider = CLAUDE_PTY_PROVIDER;
    else if (req.provider === DEFAULT_PROVIDER) delete next.provider;
    if (workFolder) next.workFolder = workFolder;
    else delete next.workFolder;
    for (const k of fields.clear) delete next[k];
    const list = this.deps.projects().map((x) => (x.name === p.name ? next : x));
    // Only a change of session name or folder is checked: an existing clash still saves other edits.
    const moves = !samePath(next.folder, p.folder, this.deps.host);
    if (moves || sessionName(next) !== sessionName(p)) {
      // A Lead's move takes its Workers without a folder of their own along.
      const moved = list.filter(
        (x) =>
          x === next ||
          (moves && !p.role && x.role && x.projectId === p.projectId && !x.workFolder),
      );
      const clash = this.sessionClash(
        list,
        moved.map((x) => x.name),
      );
      if (clash) return fail(clash);
    }
    this.deps.commit(list);
    const launchChanged = LAUNCH_FIELDS.some((k) => next[k] !== p[k]);
    return launchChanged && p.sessionId
      ? { ok: true, ...warned([koText('launch_options_next'), ...warnings]) }
      : { ok: true, ...warned(warnings) };
  }

  /** Why `next` cannot be saved: one of `changed` would share a session name with another
   *  agent in its folder (collide), or null. */
  sessionClash(next: ProjectRecord[], changed: string[]): string | null {
    const linked = linkWorkers(next);
    for (const a of linked.filter((x) => changed.includes(x.name)))
      for (const b of linked)
        if (b.name !== a.name && this.deps.collide(a, b))
          return koText('session_name_clash', { other: b.name, a: sessionName(a), b: sessionName(b) });
    return null;
  }
}
