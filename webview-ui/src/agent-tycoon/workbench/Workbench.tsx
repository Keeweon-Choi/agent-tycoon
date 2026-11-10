/**
 * W1, the 현황판's 프로젝트 tab (once the 작업실): one project in one window (desktop) or one Dock page
 * (phone). A project picker, then the tabs 지금 상황 · 이슈 · 요구사항 · 지도 · 문서, each a small
 * component: 이슈 is C6's delegations waiting for the user's approval, then the task board narrowed
 * to this project (W2: each card's worktree, "워크트리 만들기", and its 검토). A card's 검토
 * replaces the whole window body with that worktree's review (P4). The agents and the changes
 * are the 개발실's, the runs the 실행 tab's (owner 11-06 18:24). What is left open (project, tab)
 * is remembered per device (workbenchStore).
 */
import { lazy, Suspense, useEffect, useMemo } from 'react';

import { JOSA, josa } from '../../../../core/src/agent-tycoon/josa.js';
import { Button } from '../../components/ui/Button.js';
import { getLanguage, t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { TaskReview } from '../devroom/TaskReview.js';
import { useEngineStore } from '../engineStore.js';
import { AgtyScope, type AgtySnapshot, useAgtyStore } from '../officeStore.js';
import { repoAsk, useRepoStore } from '../repo/repoStore.js';
import { useRepoView } from '../repo/useRepoView.js';
import { DocSources } from '../taskboard/DocSources.js';
import { approvalsFor, decide, useApprovals } from './approvals.js';
import { JobsTab } from './JobsTab.js';
import { TaskWorktreeScope } from './taskWorktreeScope.js';
import {
  type Member,
  NO_PROJECT,
  NO_PROJECT_TABS,
  ownedNames,
  pickerProjects,
  resolveProject,
  scopeToProject,
  scopeToUnowned,
  teamOf,
  WORKBENCH_TABS,
  workbenchProjects,
  type WorkbenchTab,
} from './workbenchState.js';
import {
  closeReview,
  setWorkbenchProject,
  setWorkbenchTab,
  tabFocus,
  useCanAct,
  useWorkbench,
  useWorkbenchReview,
} from './workbenchStore.js';

const muted = 'text-text-muted text-xs';

// SPT-P1A/P1B, RQ2: the 개요 and 요구사항 tabs are their own chunk (the main bundle stays as it was).
const Overview = lazy(() => import('../spec/Overview.js').then((m) => ({ default: m.Overview })));
const ReqsTab = lazy(() => import('../spec/ReqsTab.js').then((m) => ({ default: m.ReqsTab })));
// SPT-P3-GRAPH, MAP-A: the 지도 tab (React Flow + dagre with it) loads only when opened.
const MapTab = lazy(() => import('../spec/CockpitMap.js').then((m) => ({ default: m.MapTab })));
const TAB_LABEL = {
  cockpit: 'spec.tab.cockpit',
  tasks: 'workbench.tab.tasks',
  reqs: 'spec.tab.reqs',
  graph: 'spec.tab.graph',
} as const satisfies Record<WorkbenchTab, string>;

/** C6: the project's delegate_task calls waiting for the user, each with 승인 / 거절. */
function ApprovalCards({ project }: { project: string }) {
  const { approvals, busy } = useApprovals();
  // A read-only viewer sees the cards, not the buttons (as the board hides its editor).
  const readOnly = useAgtyStore().officeReadOnly;
  const mine = approvalsFor(approvals, project);
  if (!mine.length) return null;
  const send = (msg: Parameters<typeof transport.send>[0]) => transport.send(msg);
  return (
    <section className="mb-8 min-w-0" aria-label={t('approvals.title')}>
      <h3 className="text-xs text-accent-text mb-4">{t('approvals.title')}</h3>
      <ul className="space-y-4">
        {mine.map((a) => (
          <li
            key={a.id}
            className="pixel-panel p-8 text-xs min-w-0"
            data-testid="approval-card"
            data-approval-id={a.id}
          >
            <p className="min-w-0 break-words">
              <strong>{a.caller}</strong>
              {getLanguage() === 'ko' ? '' : ' '}
              {t('approvals.wants', {
                ga: josa(a.caller, JOSA.subject),
                title: a.title || '—',
                target: a.target,
              })}
            </p>
            <p className={muted}>
              {t(a.check === 'mode' ? 'approvals.why.mode' : 'approvals.why.limits')} · {a.why}
              {a.newWorker && ` · ${t('approvals.newWorker')}`}
            </p>
            {a.counts && (
              <p className={muted} data-testid="approval-counts">
                {t('approvals.counts', {
                  w: a.counts.workersRunning[0],
                  wm: a.counts.workersRunning[1],
                  h: a.counts.hostWorkersRunning[0],
                  hm: a.counts.hostWorkersRunning[1],
                  n: a.counts.newWorkersToday[0],
                  nm: a.counts.newWorkersToday[1],
                  d: a.counts.delegationsToday[0],
                  dm: a.counts.delegationsToday[1],
                })}
              </p>
            )}
            {!readOnly && (
              <div className="mt-4 flex gap-8">
                <Button
                  size="sm"
                  variant="active"
                  disabled={!!busy[a.id]}
                  onClick={() => decide(send, a.id, 'approve')}
                >
                  {t('approvals.approve')}
                </Button>
                <Button
                  size="sm"
                  disabled={!!busy[a.id]}
                  onClick={() => decide(send, a.id, 'deny')}
                >
                  {t('approvals.deny')}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Task: the waiting approvals, then the old 작업 tab (업무 | 실행) seeing only this project's items
 *  (프로젝트 없음: the items nobody owns). */
function TasksTab({
  project,
  scope,
  team,
}: {
  project: string;
  scope: (s: AgtySnapshot) => AgtySnapshot;
  team: Member[];
}) {
  const unowned = project === NO_PROJECT;
  // W2: the cards show their Task's worktree and offer to make one (the repository's state).
  useRepoView(unowned ? null : project);
  const { states, busy } = useRepoStore();
  const canAct = useCanAct();
  const repo = states[project];
  const names = team.map((m) => m.name).join('\n');
  const worktrees = useMemo(
    () =>
      unowned
        ? null
        : {
            project,
            names: names ? names.split('\n') : [],
            worktrees: repo?.ok ? (repo.worktrees ?? []) : undefined,
            canAct,
            busy: busy[project] !== undefined,
          },
    [unowned, project, names, repo, canAct, busy],
  );
  // Like the board's own "+ 업무" button: the connection's privilege (the daemon refuses the rest).
  const readOnly = useAgtyStore().officeReadOnly;
  // SPT-P3-OVERVIEW: opened from a 개요 status number: the board has no status filter, so its column scrolls into view.
  useEffect(() => {
    const status = tabFocus('tasks')?.key.replace(/^status:/, '');
    if (!status) return;
    const frame = requestAnimationFrame(() => document.querySelector(`[data-testid="task-group"][data-status="${status}"]`)?.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <AgtyScope.Provider value={scope}>
      <TaskWorktreeScope.Provider value={worktrees}>
        {!unowned && <ApprovalCards project={project} />}
        {!unowned && !readOnly && <DocSources project={project} />}
        <JobsTab />
      </TaskWorktreeScope.Provider>
    </AgtyScope.Provider>
  );
}

/** 검토: one task worktree's review in place of the tabs; 머지 asks the usual confirmation. */
function ReviewPage({ project, task }: { project: string; task: string }) {
  useRepoView(project);
  return (
    <TaskReview
      project={project}
      task={task}
      onBack={closeReview}
      onMerge={(worktree) => repoAsk({ kind: 'merge', project, worktree })}
    />
  );
}

/** The project picker and the tabs, then the open tab's body. */
export function Workbench({ mobile = false }: { mobile?: boolean }) {
  const reviewing = useWorkbenchReview();
  return reviewing ? <ReviewPage project={reviewing.project} task={reviewing.task} /> : <WorkbenchTabs mobile={mobile} />;
}

function WorkbenchTabs({ mobile }: { mobile: boolean }) {
  const store = useAgtyStore();
  const engine = useEngineStore().state?.projects;
  const saved = useWorkbench();
  const leads = useMemo(
    () => workbenchProjects(store.officeSnapshot, engine),
    [store.officeSnapshot, engine],
  );
  const { officeJobs, codexTasks, taskBoard, tracked } = store;
  const projects = useMemo(
    () => pickerProjects(leads, { officeJobs, codexTasks, taskBoard, tracked }, engine),
    [leads, officeJobs, codexTasks, taskBoard, tracked, engine],
  );
  const project = resolveProject(projects, saved.project);
  const team = useMemo(
    () => (project && project !== NO_PROJECT ? teamOf(project, store.officeSnapshot, engine) : []),
    [project, store.officeSnapshot, engine],
  );
  // The items of the shown entry: its Lead and Workers, or (프로젝트 없음) what nobody owns.
  const names = team.map((m) => m.name).join('\n');
  const scope = useMemo(
    () =>
      project === NO_PROJECT
        ? scopeToUnowned(ownedNames(leads, engine))
        : scopeToProject(names ? names.split('\n') : []),
    [project, names, leads, engine],
  );
  const tabs = project === NO_PROJECT ? NO_PROJECT_TABS : WORKBENCH_TABS;
  const tab: WorkbenchTab = tabs.includes(saved.tab) ? saved.tab : 'tasks';
  const tap = mobile ? 'pointer-coarse:min-h-44' : '';
  const agentIds = team.flatMap((m) => (m.agentId === null ? [] : [m.agentId]));
  // Desktop (window mock v3-2): the picker and the tabs share one row.
  return (
    <>
      <div className={`shrink-0 ${mobile ? '' : 'flex items-center gap-12 min-w-0'}`}>
      <div className={`shrink-0 ${mobile ? 'px-8 pt-4' : ''} flex items-center gap-8 min-w-0`}>
        <label className="flex items-center gap-4 text-xs min-w-0">
          <span className="shrink-0">{t('workbench.project')}</span>
          <select
            aria-label={t('workbench.pickProject')}
            className={`bg-bg border border-border px-4 py-2 text-xs min-w-0 ${tap}`}
            value={project ?? ''}
            disabled={projects.length === 0}
            onChange={(e) => setWorkbenchProject(e.target.value)}
          >
            {projects.map((name) => (
              <option key={name} value={name}>
                {name === NO_PROJECT ? t('workbench.unowned') : name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <nav
        className={`ui-tabs overflow-x-auto ${mobile ? 'px-8 py-4' : 'py-8 flex-1 min-w-0'} shrink-0`}
        aria-label={t('workbench.tabs')}
      >
        {tabs.map((id) => (
          <Button
            key={id}
            size="sm"
            aria-pressed={tab === id}
            variant={tab === id ? 'active' : 'default'}
            className={`shrink-0 ${tap}`}
            onClick={() => setWorkbenchTab(id)}
          >
            {t(TAB_LABEL[id])}
          </Button>
        ))}
      </nav>
      </div>
      <div
        className={`overflow-y-auto min-h-0 flex-1 ${mobile ? 'px-8 pb-12' : ''}`}
        data-testid="workbench-body"
        data-tab={tab}
      >
        {!project ? (
          <p className={`${muted} py-12 text-center`}>{t('workbench.noProject')}</p>
        ) : tab === 'tasks' ? (
          <TasksTab project={project} scope={scope} team={team} />
        ) : (
          <Suspense fallback={<p className={muted}>{t('spec.wizard.loading')}</p>}>
            <AgtyScope.Provider value={scope}>
              {tab === 'cockpit' ? (
                <Overview project={project} agentIds={agentIds} />
              ) : tab === 'reqs' ? (
                <ReqsTab project={project} mobile={mobile} />
              ) : (
                <MapTab key={project} project={project} mobile={mobile} />
              )}
            </AgtyScope.Provider>
          </Suspense>
        )}
      </div>
    </>
  );
}
