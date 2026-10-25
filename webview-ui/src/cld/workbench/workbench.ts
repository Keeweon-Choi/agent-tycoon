/**
 * W1, the 작업실 (Workbench), pure: which projects it lists, who is in a
 * project's team (its Lead and Workers), which project and tab it opens on,
 * and the narrowed snapshot its Task tab shows. Nothing here touches the DOM.
 */
import type {
  BoardTask,
  CodexTask,
  EngineAction,
  EngineProject,
  EngineState,
  OfficeOrchestrator,
  OfficeSnapshot,
} from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import { NAME_RE } from '../engine.js';
import type { CldSnapshot } from '../officeStore.js';
import { codexKind } from '../panels/jobs.js';

export const WORKBENCH_TABS = ['agents', 'tasks', 'worktrees', 'changes'] as const;
export type WorkbenchTab = (typeof WORKBENCH_TABS)[number];
export const DEFAULT_TAB: WorkbenchTab = 'agents';

/** UI-C1: the picker's last entry, for the jobs and Codex runs that belong to no project. Not a
 *  valid project name (NAME_RE), so no project can collide with it. */
export const NO_PROJECT = '?none';
/** The tabs the 프로젝트 없음 entry has: no Lead, no repository. */
export const NO_PROJECT_TABS: readonly WorkbenchTab[] = ['agents', 'tasks'];
/** Finished Codex runs shown on a project's 에이전트 tab; the rest sit behind one fold. */
export const CODEX_FINISHED_SHOWN = 3;

/** What one device remembers: the project it last looked at and the tab. */
export interface WorkbenchSaved {
  project: string | null;
  tab: WorkbenchTab;
}

export function parseSaved(raw: string | null): WorkbenchSaved {
  const fallback: WorkbenchSaved = { project: null, tab: DEFAULT_TAB };
  if (!raw) return fallback;
  try {
    const data = JSON.parse(raw) as { project?: unknown; tab?: unknown };
    return {
      project: typeof data.project === 'string' && data.project ? data.project : null,
      tab: WORKBENCH_TABS.find((tab) => tab === data.tab) ?? DEFAULT_TAB,
    };
  } catch {
    return fallback;
  }
}

/** The projects to pick from: every orchestrator that is not a Worker of another. */
export function workbenchProjects(
  office: OfficeSnapshot | null,
  engine: readonly EngineProject[] = [],
): string[] {
  const workers = new Set(engine.filter((p) => p.role).map((p) => p.name));
  return (office?.orchestrators ?? []).map((o) => o.name).filter((name) => !workers.has(name));
}

/** A Worker's card opens its project's 작업실: a Worker maps to its Lead's project, anything else stays. */
export const projectOfAgent = (name: string, engine: readonly EngineProject[] = []): string =>
  engine.find((p) => p.name === name && p.role)?.project ?? name;

/** The project shown: the remembered one while it still exists, else the first. */
export const resolveProject = (
  projects: readonly string[],
  wanted: string | null,
): string | null => (wanted && projects.includes(wanted) ? wanted : (projects[0] ?? null));

export type MemberState = 'working' | 'resting' | 'on' | 'off';

export interface Member {
  name: string;
  role: 'lead' | 'worker' | 'reviewer';
  state: MemberState;
  model?: string;
  effort?: string;
  /** D5: the agent's provider when it is not Claude ('codex'). */
  provider?: string;
  /** Why it is down (the engine's mark): a Codex Worker that cannot start says why. */
  downNote?: string;
  /** The character/conversation id; null while the office does not know the agent. */
  agentId: number | null;
}

function stateOf(
  orch: OfficeOrchestrator | undefined,
  engine: EngineProject | undefined,
): MemberState {
  if (orch) {
    if (orch.state === 'off') return 'off';
    return orch.busy === true ? 'working' : orch.busy === false ? 'resting' : 'on';
  }
  return engine?.live ? 'on' : 'off';
}

/** The project's Lead first, then its Workers in the order the engine lists them. */
export function teamOf(
  project: string,
  office: OfficeSnapshot | null,
  engine: readonly EngineProject[] = [],
): Member[] {
  const orchs = office?.orchestrators ?? [];
  const member = (name: string, role: Member['role']): Member => {
    const orch = orchs.find((o) => o.name === name);
    const proj = engine.find((p) => p.name === name);
    return {
      name,
      role,
      state: stateOf(orch, proj),
      ...(proj?.model && { model: proj.model }),
      ...(proj?.effort && { effort: proj.effort }),
      ...(proj?.provider && { provider: proj.provider }),
      ...(proj?.downNote && { downNote: proj.downNote }),
      agentId: orch?.agentId ?? null,
    };
  };
  const workers = engine.filter((p) => p.role && p.project === project);
  return [
    member(project, 'lead'),
    ...workers.map((w) => member(w.name, w.role === 'reviewer' ? 'reviewer' : 'worker')),
  ];
}

/** A snapshot narrowed to the items whose project passes `keep`: tasks, tracked lists, Codex runs, jobs. */
const scopeBy =
  (keep: (project: string | null | undefined) => boolean) =>
  (s: CldSnapshot): CldSnapshot => ({
    ...s,
    taskBoard: s.taskBoard && {
      ...s.taskBoard,
      tasks: s.taskBoard.tasks.filter((x) => keep(x.project)),
    },
    tracked: Object.fromEntries(
      Object.entries(s.tracked).filter(([project]) => keep(project)),
    ),
    codexTasks: s.codexTasks && {
      ...s.codexTasks,
      tasks: s.codexTasks.tasks.filter((x) => keep(x.project)),
    },
    officeJobs: s.officeJobs && {
      ...s.officeJobs,
      jobs: s.officeJobs.jobs.filter((x) => keep(x.project)),
    },
  });

/** The snapshot the Task tab sees: only the tasks, runs and jobs of `names` (the Lead and its Workers). */
export const scopeToProject = (names: readonly string[]) =>
  scopeBy((project) => !!project && names.includes(project));

/** UI-C1: every Lead and Worker of the picker's projects. */
export function ownedNames(
  projects: readonly string[],
  engine: readonly EngineProject[] = [],
): Set<string> {
  const owned = new Set(projects);
  for (const p of engine) if (p.role && projects.includes(p.project ?? '')) owned.add(p.name);
  return owned;
}

/** UI-C1: the snapshot of the 프로젝트 없음 entry: the Tasks, tracked lists, jobs and Codex runs nobody owns. */
export const scopeToUnowned = (owned: ReadonlySet<string>) =>
  scopeBy((project) => !project || !owned.has(project));

/** UI-C1: the picker's entries: the projects, then 프로젝트 없음 while any Task, tracked list, job or
 *  Codex run has no owner (nothing may become invisible). */
export function pickerProjects(
  projects: readonly string[],
  snap: Pick<CldSnapshot, 'officeJobs' | 'codexTasks'> &
    Partial<Pick<CldSnapshot, 'taskBoard' | 'tracked'>>,
  engine: readonly EngineProject[] = [],
): string[] {
  const owned = ownedNames(projects, engine);
  const orphan = (project: string | null | undefined) => !project || !owned.has(project);
  const any =
    !!snap.officeJobs?.jobs.some((j) => orphan(j.project)) ||
    !!snap.codexTasks?.tasks.some((x) => orphan(x.project)) ||
    !!snap.taskBoard?.tasks.some((x) => orphan(x.project)) ||
    Object.keys(snap.tracked ?? {}).some(orphan);
  return any ? [...projects, NO_PROJECT] : [...projects];
}

/** UI-C1: the picker entry that owns an item of `project` (a notice opens it): its Lead's
 *  project, or 프로젝트 없음. */
export function pickerEntryOf(
  project: string | null | undefined,
  projects: readonly string[],
  engine: readonly EngineProject[] = [],
): string {
  const lead = project ? projectOfAgent(project, engine) : null;
  return lead && projects.includes(lead) ? lead : NO_PROJECT;
}

export interface CodexCards {
  /** Queued, running and waiting for the limit: newest first. */
  live: CodexTask[];
  /** The newest finished runs, at most CODEX_FINISHED_SHOWN. */
  shown: CodexTask[];
  /** The older finished runs, behind one fold. */
  more: CodexTask[];
}

const stamp = (task: CodexTask): number => {
  const at = Date.parse(task.ended ?? task.started ?? task.created ?? '');
  return Number.isFinite(at) ? at : 0;
};

const isLive = (task: CodexTask) => ['queued', 'running', 'limit'].includes(codexKind(task));
const newest = (a: CodexTask, b: CodexTask) => stamp(b) - stamp(a);

/** UI-C1: the Codex runs as the 에이전트 tab lists them: live first, then the newest finished few.
 *  D5: a Codex Worker's runs are not among them (its own card shows them). */
export function codexCards(all: readonly CodexTask[]): CodexCards {
  const tasks = all.filter((x) => !x.agent);
  const finished = tasks.filter((x) => !isLive(x)).sort(newest);
  return {
    live: tasks.filter(isLive).sort(newest),
    shown: finished.slice(0, CODEX_FINISHED_SHOWN),
    more: finished.slice(CODEX_FINISHED_SHOWN),
  };
}

/** D5: what a Codex Worker's card shows: its running run (with its Task), else its last one. */
export interface CodexWorkerView {
  /** The run going now (running, queued or waiting on its limit), or null. */
  current: CodexTask | null;
  /** The last run that ended, only while nothing runs (the running one is `current`). */
  last: CodexTask | null;
  /** The current run's Task, as `T-12 로그인 고치기`, or null (no work given). */
  task: string | null;
  /** The last run's report (its Execution's summary), first line only. */
  summary: string | null;
  /** The last run's log (its Execution's). */
  log: string | null;
}

export function codexWorkerView(
  name: string,
  tasks: readonly CodexTask[],
  board: readonly BoardTask[] = [],
): CodexWorkerView {
  const mine = tasks.filter((x) => x.agent === name).sort(newest);
  const current = mine.find(isLive) ?? null;
  const last = current ? null : (mine[0] ?? null);
  const taskOf = (id: string | undefined) => (id ? board.find((x) => x.id === id) : undefined);
  const work = taskOf(current?.task);
  const execution = last && taskOf(last.task)?.executions?.find((e) => e.id === `codex:${last.id}`);
  return {
    current,
    last,
    task: current?.task ? (work ? `${work.id} ${work.title}` : current.task) : null,
    summary: execution?.summary?.value.split('\n').find((l) => l.trim())?.trim() ?? null,
    log: execution?.log ?? null,
  };
}

/** D3b: the "+ Worker" form, all strings. */
export interface WorkerForm {
  /** D5: which agent runs it. */
  provider: 'claude' | 'codex';
  name: string;
  role: 'worker' | 'reviewer';
  folder: string;
  model: string;
  effort: string;
  permissionMode: string;
}

export const emptyWorkerForm = (folder: string, provider: WorkerForm['provider'] = 'claude'): WorkerForm => ({
  provider,
  name: '',
  role: 'worker',
  folder,
  model: '',
  effort: '',
  permissionMode: '',
});

/** A first check before sending, as the CLI's: a valid name, not taken by any project or
 *  agent (a project's name is its Lead's). The engine checks everything again. */
export function workerFormError(f: WorkerForm, engine: readonly EngineProject[]): string | null {
  const name = f.name.trim();
  if (!NAME_RE.test(name)) return t('engine.error.name');
  const taken = engine.find((p) => p.name === name);
  if (taken) return t(taken.role ? 'workbench.error.taken' : 'workbench.error.project');
  return null;
}

/** The engine `add` action's fields: the project's folder is left out (the Worker's default). */
export function workerFields(
  f: WorkerForm,
  project: string,
  projectFolder: string,
): Partial<EngineAction> {
  const folder = f.folder.trim();
  return {
    role: f.role,
    project,
    ...(folder && folder !== projectFolder && { folder }),
    ...(f.model && { model: f.model }),
    ...(f.effort && { effort: f.effort }),
    // D5: a Codex Worker has no permission mode (Codex exec never asks).
    ...(f.provider === 'codex' ? { provider: 'codex' } : f.permissionMode && { permissionMode: f.permissionMode }),
  };
}

/** D5: the agents the form offers: those installed here (agentChoices), Claude first. */
export const workerProviders = (choices: EngineState['agentChoices']): WorkerForm['provider'][] =>
  (['claude', 'codex'] as const).filter((p) => !!choices?.[p]);
