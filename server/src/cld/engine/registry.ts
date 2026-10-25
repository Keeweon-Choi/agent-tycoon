/**
 * The engine's project registry (T-0018, D2): ~/.config/cld-gui/projects.json
 * `{v: 2, projects: [{projectId, name, folder, room?, leadAssignmentId}]}` and
 * beside it assignments.json `{v: 1, assignments: [{assignmentId, projectId,
 * role: 'lead', provider, title?, rulesFile?, model?, permissionMode?,
 * effort?, remoteControl?, alwaysOn?, wantRunning, sessionId?, backgroundId?,
 * idleRetired?, compactionNudge?}]}`, each written atomically (tmp + rename).
 * The engine keeps the joined view, one ProjectRecord per project (the project
 * with its lead assignment): loadRegistry joins, saveRegistry splits.
 * Every string that can reach argv or a cwd is checked here.
 * The launch options are per-project choices with no default: unset means
 * Claude Code's own default (ADR-0014).
 *
 * Rollback of D2: a D1 daemon reading v2 reports "written by a newer version"
 * and writes nothing. To go back by hand: stop the daemon,
 * `cp projects.json.v1 projects.json`, remove assignments.json.
 *
 * D3: a project may also have Workers (role 'worker' or 'reviewer'): an
 * assignment of its own with a `name` unique among every project and agent,
 * and an optional `folder` (a worktree of the project; the project's folder
 * when unset). The engine keeps them in the same list, one record per agent,
 * keyed by that name; a Worker's `folder` and `room` there are its project's
 * (linkWorkers). The Lead's agent name is the project name (not stored twice).
 * assignments.json is written as v2 only while it holds a Worker, so a D2
 * daemon refuses (never rewrites) a file it cannot represent, and one with no
 * Worker stays a file D2 reads.
 *
 * D4: each assignment's `provider` names the agent provider that drives it
 * (agents/types.ts; 'claude' when absent, and as written). One this build does
 * not have is kept as it is, not broken: that agent alone cannot start.
 *
 * D3b: names are slots. Promoting a Worker swaps the two assignments' names:
 * the Worker's assignment becomes the project's lead (its name is then the
 * project's), the old Lead's becomes a Worker under the Worker's former name
 * (leadSwap.ts writes the pair, through a journal).
 */
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { PathHost } from '../../../../core/src/cld/projectPath.js';
import { sameProjectPath } from '../../../../core/src/cld/projectPath.js';
import { koText, refused } from '../../../../core/src/cld/serverText.js';
import { findFolder } from '../folders.js';

export interface ProjectRecord {
  /** Stable, opaque project identity. Never changes when the project is renamed. */
  projectId: string;
  /** The project's lead AgentAssignment (D2): every field below `room` lives there.
   *  Always set on a loaded record; a record not yet written gets one from saveRegistry. */
  leadAssignmentId?: string;
  name: string;
  folder: string;
  room?: string;
  rulesFile?: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  remoteControl?: boolean;
  /** Keep the session available even when Claude retires it for idleness. */
  alwaysOn?: boolean;
  /** The conversation's name (`-n`); the project name when unset. */
  title?: string;
  wantRunning: boolean;
  sessionId?: string;
  /** Claude's short background id, retained to identify daemon retirement after it exits. */
  backgroundId?: string;
  /** Claude retired this session after idleness; leave it down until addressed. */
  idleRetired?: boolean;
  /** T-0019: send the renew nudge from this many compactions on (opt-in, ADR-0014). */
  compactionNudge?: number;
  /** D3: a Worker (or Reviewer) of the project `projectId` under its own name; unset = the
   *  project's Lead, whose name is the project's. */
  role?: WorkerRole;
  /** D3: a Worker's own assignment id (a Lead's is `leadAssignmentId`). */
  assignmentId?: string;
  /** D3: a Worker's own folder (a worktree of the project); unset = the project's. A Worker's
   *  `folder` and `room` are filled in from its project by linkWorkers. */
  workFolder?: string;
  /** D4: the agent provider of its assignment; unset = 'claude'. */
  provider?: string;
  /** D3b: its `sessionId` was started under another name (a Lead swap's old Lead): resume
   *  it only as a copy under its own name, flags and token, never a bare wake. Cleared by
   *  the first start that records a conversation of its own. */
  resumeAsCopy?: boolean;
}

export type WorkerRole = 'worker' | 'reviewer';
export const WORKER_ROLES: readonly WorkerRole[] = ['worker', 'reviewer'];

/** Accepted by the writer only to let old in-process callers be upgraded at their write boundary. */
type ProjectSaveRecord = Omit<ProjectRecord, 'projectId'> &
  Partial<Pick<ProjectRecord, 'projectId'>>;

/** The project's own part, kept in projects.json v2. */
const PROJECT_KEYS = ['projectId', 'name', 'folder', 'room', 'leadAssignmentId'] as const;
/** The agent's part, kept in its assignment (assignments.json). */
const AGENT_KEYS = [
  'title',
  'rulesFile',
  'model',
  'permissionMode',
  'effort',
  'remoteControl',
  'alwaysOn',
  'wantRunning',
  'sessionId',
  'backgroundId',
  'idleRetired',
  'compactionNudge',
  'resumeAsCopy',
] as const;

export type AssignmentRecord = Pick<ProjectRecord, (typeof AGENT_KEYS)[number]> & {
  assignmentId: string;
  projectId: string;
  role: 'lead' | WorkerRole;
  provider: string;
  /** A Worker's name and own folder (D3); a Lead has neither. */
  name?: string;
  folder?: string;
};

export const NAME_RE = /^[A-Za-z0-9가-힣][A-Za-z0-9가-힣._-]{0,40}$/;
export const PROJECT_ID_RE = /^p_[a-z2-7]{10}$/;
export const ASSIGNMENT_ID_RE = /^a_[a-z2-7]{10}$/;
/** A model alias or full name: never a flag, no spaces. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;
/** A value of --permission-mode or --effort (Claude lists the choices). */
const WORD_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
/** A conversation name: one argv element, never a flag, no control characters. */
const TITLE_RE = /^[^\p{Cc}\s-][^\p{Cc}]{0,79}$/u;
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BACKGROUND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** An agent provider's id (D4). */
const PROVIDER_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const DEFAULT_PROVIDER = 'claude';
const ROOM_MAX = 40;

export const registryPath = (home = os.homedir()): string =>
  path.join(home, '.config', 'cld-gui', 'projects.json');

/** assignments.json, beside the registry file. */
export const assignmentsPath = (registryFile: string): string =>
  path.join(path.dirname(registryFile), 'assignments.json');

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** One folder: symlinks resolved, then the host's comparison (NFC, case where it folds). */
export const samePath = (a: string, b: string, host: PathHost): boolean =>
  sameProjectPath(real(a), real(b), host);

export const checkName = (name: string): string | null =>
  NAME_RE.test(name) ? null : koText('name_rule');

export function checkRoom(room: string): string | null {
  const r = room.trim();
  return r && r.length <= ROOM_MAX && !/\p{Cc}/u.test(r) ? null : koText('room_name_bad');
}

export function checkRulesFile(file: string): string | null {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    if (fs.statSync(file).isFile()) return null;
  } catch {
    /* below */
  }
  return koText('rules_unreadable');
}

/** Checks of the optional text fields (rulesFile: an absolute path by then). */
export const CHECK: Record<
  'room' | 'rulesFile' | 'model' | 'permissionMode' | 'effort' | 'title',
  (v: string) => string | null
> = {
  room: checkRoom,
  rulesFile: checkRulesFile,
  model: (v) => (MODEL_RE.test(v) ? null : koText('model_invalid')),
  permissionMode: (v) => (WORD_RE.test(v) ? null : koText('permission_mode_invalid')),
  effort: (v) => (WORD_RE.test(v) ? null : koText('effort_invalid')),
  title: (v) => (TITLE_RE.test(v) ? null : koText('title_invalid')),
};

/** An existing directory (`path`: its entry on disk, T-0032), or (with
 *  `mkdir`) one created now. */
export function checkFolder(
  folder: string,
  host: PathHost,
  mkdir = false,
): { path?: string; error?: string; missing?: true } {
  const disk = findFolder(folder, host);
  if (disk) {
    try {
      return fs.statSync(disk).isDirectory() ? { path: disk } : { ...refused('folder_not_dir') };
    } catch {
      return { ...refused('folder_unreadable') };
    }
  }
  if (!mkdir) return { ...refused('folder_missing'), missing: true };
  try {
    fs.mkdirSync(folder, { recursive: true });
    return { path: folder };
  } catch {
    return { ...refused('folder_make_failed') };
  }
}

const optional = (v: unknown, ok: (s: string) => boolean): boolean =>
  v === undefined || (typeof v === 'string' && ok(v));

function validRecord(r: unknown, requireProjectId: boolean): r is ProjectRecord {
  const p = r as Partial<ProjectRecord> | null;
  if (typeof p !== 'object' || p === null) return false;
  return (
    (!requireProjectId || (typeof p.projectId === 'string' && PROJECT_ID_RE.test(p.projectId))) &&
    typeof p.name === 'string' &&
    NAME_RE.test(p.name) &&
    typeof p.folder === 'string' &&
    path.isAbsolute(p.folder) &&
    typeof p.wantRunning === 'boolean' &&
    optional(p.room, (v) => !checkRoom(v)) &&
    optional(p.rulesFile, (v) => path.isAbsolute(v)) &&
    optional(p.model, (v) => !CHECK.model(v)) &&
    optional(p.permissionMode, (v) => !CHECK.permissionMode(v)) &&
    optional(p.effort, (v) => !CHECK.effort(v)) &&
    optional(p.title, (v) => !CHECK.title(v)) &&
    (p.remoteControl === undefined || typeof p.remoteControl === 'boolean') &&
    (p.alwaysOn === undefined || typeof p.alwaysOn === 'boolean') &&
    optional(p.sessionId, (v) => SESSION_ID_RE.test(v)) &&
    optional(p.backgroundId, (v) => BACKGROUND_ID_RE.test(v)) &&
    (p.idleRetired === undefined || typeof p.idleRetired === 'boolean') &&
    (p.resumeAsCopy === undefined || p.resumeAsCopy === true) &&
    (p.compactionNudge === undefined ||
      (Number.isInteger(p.compactionNudge) && p.compactionNudge >= 1 && p.compactionNudge <= 99)) &&
    (p.role === undefined || WORKER_ROLES.includes(p.role)) &&
    optional(p.assignmentId, (v) => ASSIGNMENT_ID_RE.test(v)) &&
    optional(p.workFolder, (v) => path.isAbsolute(v)) &&
    optional(p.provider, (v) => PROVIDER_RE.test(v))
  );
}

/** The office room of a project's agents: the project's room, else its folder's name. */
export const roomOf = (p: Pick<ProjectRecord, 'room' | 'folder'>): string =>
  p.room ?? (path.basename(p.folder) || p.folder);

/** The name an agent's conversations are started under (`-n`): its title, else its name. */
export const sessionName = (p: Pick<ProjectRecord, 'title' | 'name'>): string => p.title ?? p.name;

/** An assignment's provider on its record: only when it is not the default (D4). */
const providerOf = (a: Record<string, unknown>): Partial<ProjectRecord> =>
  a.provider === undefined || a.provider === DEFAULT_PROVIDER
    ? {}
    : { provider: a.provider as string };

/** A Worker's folder and room from its project's Lead (in the same list); a Lead as it is. */
export function linkWorkers(records: ProjectRecord[]): ProjectRecord[] {
  const leads = new Map(records.filter((r) => !r.role).map((r) => [r.projectId, r]));
  return records.map((r) => {
    const lead = r.role ? leads.get(r.projectId) : undefined;
    return lead ? { ...r, folder: r.workFolder ?? lead.folder, room: roomOf(lead) } : r;
  });
}

const KEYS: Array<keyof ProjectRecord> = [
  'projectId',
  'name',
  'folder',
  'room',
  'rulesFile',
  'model',
  'permissionMode',
  'effort',
  'remoteControl',
  'alwaysOn',
  'title',
  'wantRunning',
  'sessionId',
  'backgroundId',
  'idleRetired',
  'compactionNudge',
  'provider',
  'resumeAsCopy',
];

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

const opaqueId = (prefix: string): string =>
  `${prefix}_${[...randomBytes(10)].map((byte) => BASE32[byte & 31]).join('')}`;

/** A short stable id, intentionally unrelated to the project's display name. */
export const createProjectId = (): string => opaqueId('p');
/** An assignment's id, the same shape as a project's. */
export const createAssignmentId = (): string => opaqueId('a');

export interface LoadedRegistry {
  projects: ProjectRecord[];
  broken: string | null;
  /** The file is older than v2: its records carry ids minted now, until migrateRegistry writes them. */
  migrated: boolean;
  /** The on-disk format: 0 = the legacy array. */
  version: 0 | 1 | 2;
  /** Assignments ignored because their project is gone (a save cut short); the next save drops them. */
  orphans: string[];
}

/** The newest file versions this code writes (cld/release/version.json's dataSchema must match). */
export const PROJECTS_VERSION = 2;
export const ASSIGNMENTS_VERSION = 2;

/** assignments.json's version: 2 only while it holds a Worker (a D2 daemon refuses that). */
const assignmentsVersion = (assignments: Array<Record<string, unknown>>): 1 | 2 =>
  assignments.some((a) => a.role !== 'lead') ? ASSIGNMENTS_VERSION : 1;

/** The two files' contents, as written. */
export interface RegistryPair {
  projects: Array<Record<string, unknown>>;
  assignments: Array<Record<string, unknown>>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const pick = (r: object, keys: readonly string[]): Record<string, unknown> => {
  const o = r as Record<string, unknown>;
  return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
};

/** Validate one record and add it to `out`; a v0/v1 record gets its missing ids here. */
function addValid(out: ProjectRecord[], r: unknown, version: 0 | 1 | 2): string | null {
  if (!validRecord(r, version > 0)) return 'an invalid entry';
  if (out.some((p) => p.name === r.name)) return `a duplicate name "${r.name}"`;
  if (version > 0 && out.some((p) => p.projectId === r.projectId))
    return `a duplicate projectId "${r.projectId}"`;
  out.push({
    ...pick(r, version === 0 ? KEYS.filter((k) => k !== 'projectId') : KEYS),
    ...(version === 0 && { projectId: createProjectId() }),
    leadAssignmentId: version === 2 ? r.leadAssignmentId : createAssignmentId(),
  } as ProjectRecord);
  return null;
}

/**
 * The joined view of projects.json v2 and assignments.json. Each project's
 * `leadAssignmentId` must name a lead assignment of that same project; any
 * other assignment of a project is one of its Workers (D3; a second lead is
 * broken), and one of no project at all is an orphan a save cut short leaves
 * (ignored); else `broken` (the first problem found). Leads first, then the
 * Workers in file order.
 */
export function joinRegistry(
  projects: unknown[],
  assignments: unknown[],
): { projects: ProjectRecord[]; broken: string | null; orphans: string[] } {
  let broken: string | null = null;
  const byId = new Map<string, Record<string, unknown>>();
  for (const a of assignments) {
    if (
      !isObject(a) ||
      typeof a.assignmentId !== 'string' ||
      !ASSIGNMENT_ID_RE.test(a.assignmentId) ||
      typeof a.projectId !== 'string' ||
      (a.role !== 'lead' && !(WORKER_ROLES as unknown[]).includes(a.role)) ||
      (a.provider !== undefined && (typeof a.provider !== 'string' || !PROVIDER_RE.test(a.provider)))
    )
      broken ??= 'an invalid assignment';
    else if (byId.has(a.assignmentId)) broken ??= `a duplicate assignmentId "${a.assignmentId}"`;
    else byId.set(a.assignmentId, a);
  }
  const used = new Set<string>();
  const out: ProjectRecord[] = [];
  for (const p of projects) {
    const id = isObject(p) ? p.leadAssignmentId : undefined;
    if (!isObject(p) || typeof id !== 'string' || !ASSIGNMENT_ID_RE.test(id)) {
      broken ??= 'an invalid entry';
      continue;
    }
    const a = byId.get(id);
    if (!a) broken ??= `no assignment "${id}" for project "${String(p.name)}"`;
    else if (a.role !== 'lead') broken ??= `assignment "${id}" is not a lead`;
    else if (used.has(id)) broken ??= `assignment "${id}" is the lead of two projects`;
    else if (a.projectId !== p.projectId)
      broken ??= `assignment "${id}" belongs to another project`;
    else {
      used.add(id);
      const invalid = addValid(
        out,
        { ...pick(p, PROJECT_KEYS), ...pick(a, AGENT_KEYS), ...providerOf(a) },
        2,
      );
      broken ??= invalid;
    }
  }
  const projectIds = new Set(projects.map((p) => (isObject(p) ? p.projectId : undefined)));
  const leads = new Map(out.map((p) => [p.projectId, p]));
  const orphans: string[] = [];
  for (const [id, a] of byId)
    if (used.has(id)) continue;
    else if (!projectIds.has(a.projectId)) orphans.push(id);
    else if (a.role === 'lead') broken ??= `assignment "${id}" is not its project's lead`;
    else {
      const lead = leads.get(a.projectId as string);
      if (lead) broken ??= addWorker(out, id, a, lead); // else its project is broken already
    }
  return { projects: out, broken, orphans };
}

/** D3: one Worker assignment into the list; its name is unique among every project and agent. */
function addWorker(
  out: ProjectRecord[],
  id: string,
  a: Record<string, unknown>,
  lead: ProjectRecord,
): string | null {
  const own = {
    projectId: lead.projectId,
    assignmentId: id,
    role: a.role,
    name: a.name,
    folder: a.folder ?? lead.folder,
    ...(a.folder !== undefined && { workFolder: a.folder }),
    ...pick(a, AGENT_KEYS),
    ...providerOf(a),
  };
  if (!validRecord(own, true)) return `an invalid worker "${String(a.name)}"`;
  if (out.some((p) => p.name === own.name)) return `a duplicate name "${own.name}"`;
  out.push(linkWorkers([lead, own])[1]);
  return null;
}

/**
 * The valid projects. `broken` (why) when a file is unreadable or holds an
 * invalid, duplicate or dangling entry: the engine then never writes it, since
 * a rewrite would drop what it could not read.
 */
export function loadRegistry(file: string): LoadedRegistry {
  const none = (broken: string | null): LoadedRegistry => ({
    projects: [],
    broken,
    migrated: false,
    version: 2,
    orphans: [],
  });
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    return none((err as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'not JSON');
  }
  const v = isObject(raw) ? raw.v : undefined;
  const list = Array.isArray(raw) ? raw : isObject(raw) ? raw.projects : undefined;
  if (!Array.isArray(list) || (!Array.isArray(raw) && v !== 1 && v !== 2))
    return none(
      typeof v === 'number' && v > 2
        ? `written by a newer version (v=${v})`
        : 'not a project list this version can read',
    );
  if (v === 2) {
    let rawA: unknown;
    try {
      rawA = JSON.parse(fs.readFileSync(assignmentsPath(file), 'utf-8'));
    } catch (err) {
      return none(
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'assignments.json is missing'
          : 'assignments.json is not JSON',
      );
    }
    const av = isObject(rawA) ? rawA.v : undefined;
    if (!isObject(rawA) || (av !== 1 && av !== 2) || !Array.isArray(rawA.assignments))
      return none(
        typeof av === 'number' && av > 2
          ? `assignments.json written by a newer version (v=${av})`
          : 'assignments.json is not an assignment list this version can read',
      );
    return { ...joinRegistry(list, rawA.assignments), migrated: false, version: 2 };
  }
  const version = v === 1 ? 1 : 0;
  const projects: ProjectRecord[] = [];
  let broken: string | null = null;
  for (const r of list) broken = addValid(projects, r, version) ?? broken;
  return { projects, broken, migrated: true, version, orphans: [] };
}

export type LeadRecord = ProjectRecord & { leadAssignmentId: string };

/** The project part and the lead-assignment part of each Lead; each Worker's own assignment. */
export function splitRegistry(records: LeadRecord[]): RegistryPair {
  const leads = records.filter((r) => !r.role);
  return {
    projects: leads.map((r) => pick(r, PROJECT_KEYS)),
    assignments: [
      ...leads.map((r) => ({
        assignmentId: r.leadAssignmentId,
        projectId: r.projectId,
        role: 'lead',
        provider: r.provider ?? DEFAULT_PROVIDER,
        ...pick(r, AGENT_KEYS),
      })),
      ...records
        .filter((r) => r.role)
        .map((r) => ({
          assignmentId: r.assignmentId,
          projectId: r.projectId,
          role: r.role,
          provider: r.provider ?? DEFAULT_PROVIDER,
          name: r.name,
          ...(r.workFolder && { folder: r.workFolder }),
          ...pick(r, AGENT_KEYS),
        })),
    ],
  };
}

function writeAtomic(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** D3b: the two files' texts for `records` (every id set), exactly as a save writes them. */
export function registryTexts(records: LeadRecord[]): { projects: string; assignments: string } {
  const pair = splitRegistry(records);
  return {
    projects: json({ v: PROJECTS_VERSION, projects: pair.projects }),
    assignments: json({ v: assignmentsVersion(pair.assignments), assignments: pair.assignments }),
  };
}

/** projects.json is absent or v2: only migrateRegistry may replace an older one. */
function writable(file: string): boolean {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return isObject(raw) && raw.v === 2;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/** A test seam: called after each file a save writes (a throw there is a crash between writes). */
export const registryFault: { afterWrite?: (file: string) => void } = {};

/** A file's text and its list (empty when unreadable). */
function readList(file: string, key: string): { text: string | null; list: unknown[] } {
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, 'utf-8');
    const raw: unknown = JSON.parse(text);
    return { text, list: isObject(raw) && Array.isArray(raw[key]) ? raw[key] : [] };
  } catch {
    return { text, list: [] };
  }
}

/**
 * Crash-safe at every point: each project on disk always names an assignment
 * on disk, so a save cut short leaves at most orphan assignments (ignored on
 * load). Three steps, each skipped when its file would not change:
 * assignments.json with the new assignments plus the old projects' leads, then
 * projects.json, then assignments.json without those old leads. So an add
 * writes assignments.json then projects.json, a remove projects.json then
 * assignments.json, and a change of only agent fields (or only project fields)
 * writes only assignments.json (projects.json). A write error is no different
 * from a crash there: what is on disk still loads, and the engine's memory,
 * unchanged by the failed save, drops any orphan at its next save.
 */
export function saveRegistry(
  file: string,
  projects: ProjectSaveRecord[],
  log: (line: string) => void = console.warn,
): void {
  if (!writable(file)) throw new Error(`${file} is not v2 (not migrated); not written`);
  const next = splitRegistry(
    projects.map((p) =>
      p.role
        ? ({ ...p, assignmentId: p.assignmentId ?? createAssignmentId() } as LeadRecord)
        : {
            ...p,
            projectId: p.projectId ?? createProjectId(),
            leadAssignmentId: p.leadAssignmentId ?? createAssignmentId(),
          },
    ),
  );
  const av = assignmentsVersion(next.assignments);
  const afile = assignmentsPath(file);
  const oldProjects = readList(file, 'projects');
  const oldAssignments = readList(afile, 'assignments');
  const ids = new Set(next.assignments.map((a) => a.assignmentId));
  const named = new Set(
    oldProjects.list.map((p) => (isObject(p) ? p.leadAssignmentId : undefined)),
  );
  const oldLeads = oldAssignments.list.filter(
    (a) => isObject(a) && named.has(a.assignmentId) && !ids.has(a.assignmentId),
  );
  const onDisk = new Map([
    [afile, oldAssignments.text],
    [file, oldProjects.text],
  ]);
  const steps: Array<[string, string]> = [
    [afile, json({ v: av, assignments: [...next.assignments, ...oldLeads] })],
    [file, json({ v: PROJECTS_VERSION, projects: next.projects })],
    [afile, json({ v: av, assignments: next.assignments })],
  ];
  for (const [i, [f, text]] of steps.entries()) {
    if (onDisk.get(f) === text) continue;
    try {
      writeAtomic(f, text);
    } catch (err) {
      // projects.json, the truth, is written: the save is done, and the
      // orphans this leaves are tolerated (throwing would keep memory on the
      // old list, and its next save would bring a removed project back).
      if (i < 2) throw err;
      log(
        `${f}: could not drop the old assignments (${err instanceof Error ? err.message : String(err)}); the next save drops them`,
      );
      return;
    }
    onDisk.set(f, text);
    registryFault.afterWrite?.(f);
  }
}

/** The routing table: per project name, everything that decides where and how its agent runs. */
const ROUTE_KEYS = [
  'folder',
  'room',
  'title',
  'sessionId',
  'backgroundId',
  'wantRunning',
  'idleRetired',
  'alwaysOn',
  'rulesFile',
  'model',
  'permissionMode',
  'effort',
  'remoteControl',
  'compactionNudge',
] as const;
const routingTable = (projects: ProjectRecord[]): Record<string, unknown> =>
  Object.fromEntries(projects.map((p) => [p.name, pick(p, ROUTE_KEYS)]));

/** A copy that never overwrites an older one (one of the same bytes will do); its file name. */
export function keepCopy(file: string, suffix: string): string {
  const bytes = fs.readFileSync(file);
  for (const target of [`${file}${suffix}`, `${file}${suffix}.${Date.now()}`]) {
    try {
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
      return path.basename(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (fs.readFileSync(target).equals(bytes)) return path.basename(target);
    }
  }
  throw new Error(`${file}${suffix} already exists`);
}

/**
 * D2 (F-8), on every engine start, read-only too (it still writes its own
 * bookkeeping: revive, conversation ids, idle retirement). An older
 * projects.json (v1, or a legacy array through D1's v1) becomes projects.json v2
 * + assignments.json, one lead assignment per project. Claude's session ids,
 * settings, conversations and project folders are not touched: only the
 * references move, so running sessions stay as they are. Order:
 *  1. build the pair in memory and compare the routing table before and after;
 *     any difference aborts with nothing written;
 *  2. legacy array only (D1's path): keep projects.json.v0, write projects.json v1;
 *  3. keep the current projects.json bytes as projects.json.v1 (an existing
 *     copy is never overwritten);
 *  4. write assignments.json, then projects.json v2; when that fails,
 *     assignments.json is removed again so the old file stays the only truth.
 * Returns null when done or nothing to do, else why not: the caller then treats
 * the registry as unwritable until the next start.
 */
export function migrateRegistry(
  file: string,
  loaded: LoadedRegistry,
  log: (line: string) => void,
  split: (records: LeadRecord[]) => RegistryPair = splitRegistry,
): string | null {
  if (loaded.broken || !loaded.migrated) return null;
  const projects = loaded.projects as LeadRecord[];
  const pair = split(projects);
  const after = joinRegistry(pair.projects, pair.assignments);
  const problem = after.broken ?? (after.orphans.length ? 'an assignment without a project' : null);
  if (problem || !isDeepStrictEqual(routingTable(projects), routingTable(after.projects))) {
    const reason = `not migrated to v2: the routing table would change${problem ? ` (${problem})` : ''}`;
    log(`${file}: ${reason}; nothing was written`);
    return `${reason} — 원래 파일은 그대로예요. 이 버전은 이 목록을 옮기지 못하니 이전 버전으로 되돌리고 문제를 알려 주세요`;
  }
  let kept: string;
  try {
    if (loaded.version === 0) {
      const v0 = keepCopy(file, '.v0');
      writeAtomic(file, json({ v: 1, projects: projects.map((p) => pick(p, KEYS)) }));
      log(`projects.json: migrated to v1 (original kept as ${v0})`);
    }
    kept = keepCopy(file, '.v1');
    const afile = assignmentsPath(file);
    writeAtomic(afile, json({ v: 1, assignments: pair.assignments }));
    try {
      writeAtomic(file, json({ v: PROJECTS_VERSION, projects: pair.projects }));
    } catch (err) {
      fs.rmSync(afile, { force: true }); // the old file stays the only truth
      throw err;
    }
  } catch (err) {
    const reason = `could not migrate projects.json to v2: ${err instanceof Error ? err.message : String(err)}`;
    log(`${file}: ${reason}`);
    return `${reason} — 원래 파일은 그대로예요. 디스크 공간과 ${path.dirname(file)} 의 권한을 확인한 뒤 cld-gui 를 다시 시작하세요(그때까지 꺼진 에이전트를 되살리지 않아요)`;
  }
  log(
    `projects.json: migrated to v2, a lead assignment for each of its ${projects.length} projects in assignments.json (v1 kept as ${kept})`,
  );
  return null;
}
