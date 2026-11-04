/**
 * W1, the 작업실 (Workbench): one project's workplace in one window (desktop) or
 * one Dock page (phone). A project picker, then the tabs (SPT-P1A: 개요 · 이슈 · 문서 · 에이전트 · 변경), each a small
 * component: 에이전트 (the Lead and Workers; D3b: "+ Worker" and 'Lead 로'), Task (C6: the
 * delegations waiting for the user's approval, then the task board, narrowed
 * to this project; W2: each card's worktree, "worktree 만들기", and its 검토) and 변경 (the project's
 * own repository). A card's 검토 replaces the whole window body with that worktree's review (P4).
 * What is left open (project, tab) is remembered per device (workbenchStore).
 */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';

import { JOSA, josa } from '../../../../core/src/cld/josa.js';
import { Button } from '../../components/ui/Button.js';
import { getLanguage, t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { openLooks } from '../characters/looks.js';
import { ChatAction } from '../ChatAction.js';
import { TaskReview } from '../devroom/TaskReview.js';
import { useEngineStore } from '../engineStore.js';
import { stateLabel } from '../format.js';
import { CldScope, type CldSnapshot, useCldStore } from '../officeStore.js';
import { codexStatus, codexWord } from '../panels/jobs.js';
import { RepoPanel } from '../repo/RepoPanel.js';
import { repoAsk, useRepoStore } from '../repo/repoStore.js';
import { useRepoView } from '../repo/useRepoView.js';
import { serverLine } from '../serverText.js';
import { DocSources } from '../taskboard/DocSources.js';
import { AddWorker, PromoteButton } from './AgentActions.js';
import { approvalsFor, decide, useApprovals } from './approvals.js';
import { CodexCards } from './CodexCards.js';
import { JobsTab } from './JobsTab.js';
import { TaskWorktreeScope } from './taskWorktreeScope.js';
import {
  codexWorkerView,
  type Member,
  type MemberState,
  NO_PROJECT,
  NO_PROJECT_TABS,
  OPS_TABS,
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
  useNow,
  useWorkbench,
  useWorkbenchReview,
} from './workbenchStore.js';

// GAME-UI-1 G2: the tab row's 수락 HI-SCORE, its own small chunk (the 개요 has the big one).
const TabHiScore = lazy(() => import('../spec/GameScore.js').then((m) => ({ default: m.TabHiScore })));
const muted = 'text-text-muted text-xs';

// SPT-P1A/P1B: the 개요, 요구사항 and 문서 tabs are their own chunk (the main bundle stays as it was).
const Overview = lazy(() => import('../spec/Overview.js').then((m) => ({ default: m.Overview })));
const ReqsTab = lazy(() => import('../spec/SpecTabs.js').then((m) => ({ default: m.ReqsTab })));
const DocsTab = lazy(() => import('../spec/SpecTabs.js').then((m) => ({ default: m.DocsTab })));
// SPT-P3-GRAPH, MAP-A: the 지도 tab (React Flow + dagre with it) loads only when opened.
const MapTab = lazy(() => import('../spec/ProjectMap.js').then((m) => ({ default: m.MapTab })));
const TAB_LABEL = {
  cockpit: 'spec.tab.cockpit',
  tasks: 'workbench.tab.tasks',
  reqs: 'spec.tab.reqs',
  graph: 'spec.tab.graph',
  docs: 'spec.tab.docs',
  agents: 'workbench.tab.agents',
  changes: 'workbench.tab.changes',
} as const satisfies Record<WorkbenchTab, string>;

const STATE_TEXT: Record<MemberState, () => string> = {
  working: () => stateLabel('running', true),
  resting: () => stateLabel('running', false),
  on: () => t('workbench.state.on'),
  off: () => stateLabel('off'),
};

/** D5: the state word of a Codex Worker: resting, working, waiting on the limit, off, or why it
 *  cannot start. */
function codexWorkerState(m: Member, live: Parameters<typeof codexWord>[0] | null, now: number): string {
  if (m.state === 'off') return m.downNote ? serverLine(m.downNote) : t('workbench.codex.off');
  if (live?.state === 'limit') return codexStatus(live, now);
  return t(m.state === 'working' || live ? 'workbench.codex.working' : 'workbench.codex.resting');
}

/** D5: a Codex Worker's card body: model and effort, its current Task, its last run (folded details). */
function CodexWorkerDetails({ m }: { m: Member }) {
  const { codexTasks, taskBoard } = useCldStore();
  const v = codexWorkerView(m.name, codexTasks?.tasks ?? [], taskBoard?.tasks ?? []);
  const last = v.last;
  return (
    <div data-testid="codex-worker" data-codex-ref={(v.current ?? last)?.id}>
      <p className={muted}>{[m.model, m.effort].filter(Boolean).join(' · ') || t('workbench.worker.codexDefault')}</p>
      <p className="mt-4 min-w-0 break-words" data-testid="codex-worker-task">
        {t('workbench.codex.task')}: {v.task ?? t('workbench.codex.noTask')}
      </p>
      {last && (
        <div className="mt-4 min-w-0" data-testid="codex-worker-last">
          <p className="min-w-0 break-words">
            {t('workbench.codex.lastRun')}: {codexWord(last)}
            {last.exit != null && ` · exit ${last.exit}`}
            {` · ${t('panel.commits', { count: last.commits ?? 0 })}`}
            {last.ended && ` · ${new Date(last.ended).toLocaleString()}`}
          </p>
          {v.summary && (
            <p className="text-text-muted truncate" data-testid="codex-worker-summary">
              {t('workbench.codex.report')}: {v.summary}
            </p>
          )}
          <details className="text-text-muted mt-4">
            <summary className="cursor-pointer">{t('panel.details')}</summary>
            <p>
              {t('panel.taskId')} {last.id}
            </p>
            <p>PID {last.pid ?? t('panel.none')}</p>
            {last.branch && <p>{last.branch}</p>}
            {v.log && <p className="break-all">{v.log}</p>}
          </details>
        </div>
      )}
    </div>
  );
}

/** 에이전트: who works on the project, then its Codex runs; D3b: "+ Worker", and 'Lead 로' on a
 *  Worker's row. 프로젝트 없음 has the Codex runs only. */
function AgentsTab({
  team,
  project,
  scope,
}: {
  team: Member[];
  project: string;
  scope: (s: CldSnapshot) => CldSnapshot;
}) {
  const canAct = useCanAct();
  const { codexTasks, officeReadOnly } = useCldStore();
  const now = useNow();
  const codex = (
    <CldScope.Provider value={scope}>
      <CodexCards />
    </CldScope.Provider>
  );
  if (project === NO_PROJECT) return codex;
  return (
    <>
    {canAct && (
      <div className="flex justify-end mb-8">
        <AddWorker key={project} project={project} />
      </div>
    )}
    <ul className="space-y-8 min-w-0" aria-label={t('workbench.tab.agents')}>
      {team.map((m) => (
        <li
          key={m.name}
          className={`pixel-panel p-8 text-xs min-w-0 ${m.state === 'off' ? 'opacity-65' : ''}`}
          data-testid="workbench-agent"
          data-name={m.name}
        >
          <div className="flex flex-wrap items-center gap-8 min-w-0">
            <strong className="text-sm truncate min-w-0">{m.name}</strong>
            <span className="border border-border px-4 text-accent-text shrink-0">
              {t(`workbench.role.${m.role}`)}
            </span>
            {m.provider === 'codex' && (
              <span className="border border-border px-4 shrink-0" data-testid="codex-badge">
                {t('workbench.role.codex')}
              </span>
            )}
            {/* CH-4: cosmetic, so a read-only daemon may still change looks (not a view-only client). */}
            {!officeReadOnly && (
              <Button size="sm" data-testid="workbench-looks" onClick={() => openLooks(m.name)}>
                {t('looks.open')}
              </Button>
            )}
            <span className="ml-auto shrink-0 min-w-0 truncate" data-testid="agent-state">
              {m.provider === 'codex'
                ? codexWorkerState(m, codexWorkerView(m.name, codexTasks?.tasks ?? []).current, now)
                : STATE_TEXT[m.state]()}
            </span>
          </div>
          {m.provider === 'codex' ? (
            // No chat or 'Lead 로': a Codex Worker has no terminal and cannot lead (D5).
            <CodexWorkerDetails m={m} />
          ) : (
            <>
              {(m.model || m.effort) && (
                <p className={muted}>{[m.model, m.effort].filter(Boolean).join(' · ')}</p>
              )}
              {(m.agentId !== null || (canAct && m.role !== 'lead')) && (
                <div className="mt-4 flex flex-wrap gap-8 items-center">
                  {m.agentId !== null && <ChatAction agentId={m.agentId} variant="card" />}
                  {canAct && m.role !== 'lead' && <PromoteButton name={m.name} project={project} />}
                </div>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
    {codex}
    </>
  );
}

/** C6: the project's delegate_task calls waiting for the user, each with 승인 / 거절. */
function ApprovalCards({ project }: { project: string }) {
  const { approvals, busy } = useApprovals();
  // A read-only viewer sees the cards, not the buttons (as the board hides its editor).
  const readOnly = useCldStore().officeReadOnly;
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
  scope: (s: CldSnapshot) => CldSnapshot;
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
  const readOnly = useCldStore().officeReadOnly;
  // SPT-P3-OVERVIEW: opened from a 개요 status number: the board has no status filter, so its column scrolls into view.
  useEffect(() => {
    const status = tabFocus('tasks')?.key.replace(/^status:/, '');
    if (!status) return;
    const frame = requestAnimationFrame(() => document.querySelector(`[data-testid="task-group"][data-status="${status}"]`)?.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <CldScope.Provider value={scope}>
      <TaskWorktreeScope.Provider value={worktrees}>
        {!unowned && <ApprovalCards project={project} />}
        {!unowned && !readOnly && <DocSources project={project} />}
        <JobsTab />
      </TaskWorktreeScope.Provider>
    </CldScope.Provider>
  );
}

/** 검토: one task worktree's review in place of the tabs; 병합 asks the usual confirmation. */
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
  const store = useCldStore();
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
  const tab: WorkbenchTab = tabs.includes(saved.tab) ? saved.tab : 'agents';
  const tap = mobile ? 'pointer-coarse:min-h-44' : '';
  // Phone: 에이전트 and 변경 fold under 더보기 (open while one of them is shown).
  const [more, setMore] = useState(false);
  const folded = mobile && project !== NO_PROJECT && !more && !OPS_TABS.includes(tab);
  const shownTabs = folded ? tabs.filter((id) => !OPS_TABS.includes(id)) : tabs;
  const agentIds = team.flatMap((m) => (m.agentId === null ? [] : [m.agentId]));
  return (
    <>
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
        className={`flex gap-4 overflow-x-auto ${mobile ? 'px-8 py-4' : 'py-8'} shrink-0`}
        aria-label={t('workbench.tabs')}
      >
        {shownTabs.map((id) => (
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
        {folded && (
          <Button size="sm" className={`shrink-0 ${tap}`} aria-expanded={false} onClick={() => setMore(true)}>
            {t('spec.more')}
          </Button>
        )}
        {!mobile && project && project !== NO_PROJECT && tab !== 'cockpit' && (
          <Suspense fallback={null}>
            <TabHiScore project={project} />
          </Suspense>
        )}
      </nav>
      <div
        className={`overflow-y-auto min-h-0 flex-1 ${mobile ? 'px-8 pb-12' : ''}`}
        data-testid="workbench-body"
        data-tab={tab}
      >
        {!project ? (
          <p className={`${muted} py-12 text-center`}>{t('workbench.noProject')}</p>
        ) : tab === 'agents' ? (
          <AgentsTab team={team} project={project} scope={scope} />
        ) : tab === 'tasks' ? (
          <TasksTab project={project} scope={scope} team={team} />
        ) : tab === 'cockpit' || tab === 'reqs' || tab === 'graph' || tab === 'docs' ? (
          <Suspense fallback={<p className={muted}>{t('spec.wizard.loading')}</p>}>
            <CldScope.Provider value={scope}>
              {tab === 'cockpit' ? (
                <Overview project={project} agentIds={agentIds} />
              ) : tab === 'reqs' ? (
                <ReqsTab project={project} mobile={mobile} />
              ) : tab === 'graph' ? (
                <MapTab key={project} project={project} mobile={mobile} />
              ) : (
                <DocsTab project={project} />
              )}
            </CldScope.Provider>
          </Suspense>
        ) : (
          <RepoPanel project={project} />
        )}
      </div>
    </>
  );
}
