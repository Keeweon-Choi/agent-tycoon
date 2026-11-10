/**
 * P4 개발실 on the phone (mockups-1101/devroom-W5, left; owner 11-01 13:30): a project chip row,
 * then per project its trunk and compact Task cards (face, title, one chip) on a 4 px rail: what
 * needs the owner first, then work, then resting; old worktrees with no Task and nobody on them
 * fold into one `쉬는 작업 N개` row. A tap shows a card's 터미널 / 변경 / 머지 (plus 미리보기 and
 * 탐색기); each opens a full-screen sub-page with ‹ 뒤로. `머지된·쉬는 작업 정리` closes each group.
 */
import { Fragment, lazy, type ReactNode, Suspense, useEffect, useState } from 'react';

import type { AgentAppearance, TabStatus } from '../../components/AgentCard.js';
import { DEVROOM_PHONE_CARD_LEFT_PX, DEVROOM_PHONE_FACE_PX, DEVROOM_PHONE_GRAPH_STEP_PX, DEVROOM_SIDE_INDENT_PX, DEVROOM_TREE_STEP_PX } from '../../constants.js';
import { t } from '../../i18n/index.js';
import type { ToolActivity } from '../../office/types.js';
import { openExplorer } from '../files/explorerState.js';
import { timeAgo } from '../format.js';
import { BranchGlyph } from '../hud/glyphs.js';
import { closeWindow } from '../hud/hudStore.js';
import { useCanAct } from '../workbench/workbenchStore.js';
import { AddProjectDialog } from './AddProject.js';
import { PhoneTerminal } from './AgentColumns.js';
import { ChangesTab } from './ChangesTab.js';
import {
  BIG,
  BODY,
  DevroomLooks,
  DevroomTools,
  type Group,
  type Row,
  SMALL,
  TINY,
  useCurrentPick,
  useDevroomGroups,
  useDevroomView,
  useSideTree,
  whoName,
} from './devroomData.js';
import { PaletteSearchButton } from './DevroomPalette.js';
import { codexStamp, graphLeft, shownProject } from './devroomState.js';
import {
  closeDevroomPage,
  expandCard,
  openDevroomPage,
  pickKey,
  setDevroomFilter,
  toggleMenu,
  useDevroom,
} from './devroomStore.js';
import { GRAPH_NODE, useFoldedGraph } from './graphFold.js';
import { sizeText, totalBytes } from './mergeState.js';
import { requestCleanup, useMergeStore } from './mergeStore.js';
import { MergeTab } from './MergeTab.js';
import { AgentTray } from './NewSpace.js';
import { PreviewTab } from './PreviewTab.js';
import { PhoneRuns } from './RunRow.js';
import { useOpenWhenShown } from './seatStore.js';
import {
  AgentRows,
  BranchLine,
  DevroomLoading,
  ExternalRow,
  FoldToggle,
  HiddenLine,
  NewTaskDialog,
  ProjectHead,
  RepoWatch,
  RestingRow,
  RowFace,
  StatusChip,
  WorktreeMenu,
} from './WorktreeRail.js';

// BRN K5: the overview's five lines, in the spec chunk (loaded when the devroom shows a project).
const ResumeLines = lazy(() => import('../spec/ResumeLines.js').then((m) => ({ default: m.ResumeLines })));

const HINT_KEY = 'agty.devroom.phoneHint.v1';
const MAIN: readonly ('terminal' | 'changes' | 'merge')[] = ['terminal', 'changes', 'merge'];
const button = `flex-1 min-h-40 border-2 shadow-pixel justify-center ${BIG}`;
const small = `px-8 py-3 border-2 border-border bg-btn-bg ${SMALL}`;

/** The card's title: its Task's; a Codex run's folder as `<who> · 10-22 13:02` (`Codex 작업 · …` when nobody is known); else the folder. */
function phoneTitle(row: Row): string {
  const stamp = codexStamp(row.wt.task);
  if (row.task || !stamp) return row.title;
  const name = whoName(row.wt);
  return name ? t('devroomNames.codexTitle', { name, when: stamp }) : t('devroom.phone.codexTitle', { when: stamp });
}

function PhoneCard({ group, row, depth, fold }: { group: Group; row: Row; depth: number; fold?: ReactNode }) {
  const { expanded, menu } = useDevroom();
  const key = pickKey(group.project, row.wt.task);
  const open = expanded === key;
  const title = phoneTitle(row);
  const page = (p: 'terminal' | 'changes' | 'merge' | 'preview' | 'runs') => openDevroomPage(group.project, row.wt.task, p);
  return (
    <div
      className={`relative mr-10 mt-6 px-8 py-6 border-2 ${open ? 'border-devroom-blue bg-devroom-pick shadow-pixel' : 'border-devroom-card-line bg-devroom-card'} ${row.chip === 'merged' ? 'opacity-55' : ''}`}
      style={{ marginLeft: graphLeft(depth, DEVROOM_PHONE_CARD_LEFT_PX, DEVROOM_PHONE_GRAPH_STEP_PX) }}
      data-testid="devroom-card"
      data-depth={depth}
      data-project={group.project}
      data-task={row.wt.task}
      data-open={open || undefined}
    >
      <div className="mr-36 flex items-center gap-8 min-w-0" onClick={() => expandCard(key)}>
        <RowFace row={row} size={DEVROOM_PHONE_FACE_PX} />
        <b className={`flex-1 min-w-0 truncate font-normal leading-tight text-devroom-title ${BIG}`}>{title}</b>
      </div>
      <div className={`mr-36 mt-4 flex items-center gap-6 min-w-0 text-text-muted ${TINY}`} onClick={() => expandCard(key)}>
        <span className="min-w-0 truncate">{row.wt.assignee ?? row.wt.branch}</span>
        <span className="shrink-0">
          <StatusChip row={row} />
        </span>
        {fold && <span className="ml-auto shrink-0">{fold}</span>}
      </div>
      {/* The phone's 44 px touch target (mobile/touchTargets.css) around W5's small `…` box. */}
      <button
        type="button"
        aria-label={t('devroom.more', { title })}
        aria-expanded={menu === key}
        data-testid="devroom-more"
        className="absolute top-0 right-0 grid place-items-center"
        onClick={() => toggleMenu(key)}
      >
        <span className={`w-24 h-20 grid place-items-center border-2 leading-none ${TINY} ${menu === key || open ? 'bg-active-bg border-accent-text' : 'bg-btn-bg border-border'}`}>…</span>
      </button>
      {menu === key && (
        <div className="mt-8 bg-devroom-menu border-2 border-devroom-main-line">
          <WorktreeMenu project={group.project} row={row} base={row.wt.base} />
        </div>
      )}
      {open && (
        <>
          <div className="mt-8 grid grid-cols-3 gap-6">
            {MAIN.map((p) => (
              <button key={p} type="button" data-page={p} className={`${button} ${p === 'terminal' ? 'bg-accent border-accent text-white' : 'bg-btn-bg border-border'}`} onClick={() => page(p)}>
                {t(`devroom.tab.${p}`)}
              </button>
            ))}
          </div>
          <div className="mt-6 flex gap-6">
            <button type="button" data-page="runs" className={small} onClick={() => page('runs')}>
              {t('devroom.run.label')}
            </button>
            <button type="button" data-page="preview" className={small} onClick={() => page('preview')}>
              {t('devroom.tab.preview')}
            </button>
            <button type="button" data-testid="devroom-explorer" className={small} onClick={() => openExplorer(group.project, row.wt.task)}>
              {t('devroom.menu.explorer')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function PhoneGroup({ group }: { group: Group; all: boolean }) {
  const [restOpen, setRestOpen] = useState(false);
  const { cleanup } = useMergeStore();
  const base = group.repo?.branch ?? 'main';
  const last = group.repo?.merges?.[0]?.at;
  const ok = group.repo?.ok === true;
  const asked = cleanup[group.project] !== undefined;
  // One cleanup list per project (sizes are measured then); the 정리 view asks again when it opens.
  useEffect(() => {
    if (ok && !asked) requestCleanup(group.project);
  }, [ok, asked, group.project]);
  const active = group.shown.filter((r) => r.chip !== 'merged').length;
  const list = cleanup[group.project];
  const rows = list && list !== 'loading' && list.ok ? (list.rows ?? []) : null;
  const merged = group.rows.filter((r) => r.chip === 'merged').length;
  const { expanded } = useDevroom();
  const mine = `${group.project}\0`;
  const g = useFoldedGraph(
    group.project,
    base,
    group.shown,
    group.resting,
    restOpen,
    expanded?.startsWith(mine) ? expanded.slice(mine.length) : null,
    () => setRestOpen(true),
  );
  const side = useSideTree(group);
  const left = (depth: number) => graphLeft(depth, DEVROOM_PHONE_CARD_LEFT_PX, DEVROOM_PHONE_GRAPH_STEP_PX);
  const toggle = (l: { id: string; count: number; open: boolean }) =>
    l.count > 0 ? <FoldToggle open={l.open} count={l.count} name={l.id} onToggle={() => g.toggle(l.id)} /> : undefined;
  const lines = g.lines.map((l, i) => (
    <Fragment key={`${i < g.restingFrom ? 's' : 'r'}:${l.id}`}>
      {l.line.kind === 'branch' ? (
        <BranchLine name={l.line.name} className="mr-10 mt-6" style={{ marginLeft: left(l.line.depth) }} fold={toggle(l)} />
      ) : (
        <>
          <PhoneCard group={group} row={l.line.row} depth={l.line.depth} fold={toggle(l)} />
          <AgentRows project={group.project} task={l.line.row.wt.task} agents={side.tree.get(l.line.row.wt.task)} style={{ marginLeft: left(l.line.depth) + DEVROOM_SIDE_INDENT_PX }} className="mr-10" phone />
        </>
      )}
    </Fragment>
  ));
  return (
    <section data-testid="devroom-group" data-project={group.project} className="pb-8">
      <div className="px-8 pt-10">
        <ProjectHead
          project={group.project}
          open
          worktrees={1 + group.rows.length + side.external.length}
          agents={[...side.tree.values()].reduce((n, l) => n + l.length, 0)}
          phone
        />
      </div>
      <div style={{ marginLeft: DEVROOM_TREE_STEP_PX }} data-testid="devroom-project-body">
      <div className="px-8 pt-6">
        <Suspense fallback={null}>
          <ResumeLines project={group.project} />
        </Suspense>
      </div>
      <div className="px-12 pt-6 flex items-center gap-8">
        <p className={`min-w-0 text-text-muted ${SMALL}`} data-testid="devroom-count">
          {t('devroom.phone.count', { base, count: active })}
        </p>
        {ok && <FoldToggle open={g.graphOpen} count={group.rows.length} name={t('devroom.graph')} onToggle={() => g.toggle(GRAPH_NODE)} className="ml-auto" />}
      </div>
      {!group.repo ? (
        <p className={`px-12 text-text-muted ${SMALL}`}>{t('devroom.loading')}</p>
      ) : !ok ? (
        <p className={`px-12 text-text-muted ${SMALL}`}>{t('devroom.noRepo')}</p>
      ) : (
        <>
          {g.graphOpen && (
            <div className="relative pb-2" data-testid="devroom-graph">
              <span className="absolute left-6 top-6 bottom-0 w-4 bg-devroom-trunk" aria-hidden="true" />
              <div className="ml-14 mr-10 mt-6 flex items-stretch gap-6">
                <button
                  type="button"
                  className={`flex-1 min-w-0 flex items-center gap-8 px-8 py-6 border-2 border-devroom-main-line bg-devroom-main text-devroom-title text-left ${BIG}`}
                  data-testid="devroom-trunk"
                  data-project={group.project}
                  onClick={() => openDevroomPage(group.project, null, 'terminal')}
                >
                  <span className="text-accent-text flex">
                    <BranchGlyph />
                  </span>
                  <span className="truncate">{base}</span>
                  <small className={`ml-auto text-text-muted ${TINY}`}>
                    {last ? t('devroom.baseSince', { time: timeAgo(last) }) : t('devroom.base')}
                  </small>
                </button>
                {toggle(g.trunk)}
              </div>
              <AgentRows project={group.project} task={null} agents={side.tree.get('')} className="ml-20 mr-10" phone />
              {lines.slice(0, g.restingFrom)}
              {g.trunk.open && group.resting.length > 0 && (
                <RestingRow count={group.resting.length} open={restOpen} onToggle={() => setRestOpen(!restOpen)} className="ml-14 mr-10 mt-6 w-[calc(100%-24px)]" />
              )}
              {lines.slice(g.restingFrom)}
              {group.rows.length === 0 && <p className={`px-16 py-8 text-text-muted ${SMALL}`}>{t('devroom.noWorktrees')}</p>}
              {(side.external.length > 0 || side.hidden.length > 0) && (
                <div className="ml-14 mr-10 mt-8" data-testid="devroom-externals">
                  <p className={`text-accent-text ${SMALL}`}>{t('devroomSide.externalTitle')}</p>
                  {side.external.map((w) => (
                    <ExternalRow key={w.path} project={group.project} wt={w} agents={side.tree.get(w.path)} phone />
                  ))}
                  <HiddenLine hidden={side.hidden} phone />
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            className={`mx-12 mt-10 w-[calc(100%-24px)] py-10 border-2 border-border bg-btn-bg shadow-pixel ${BODY}`}
            data-testid="devroom-cleanup"
            onClick={() => openDevroomPage(group.project, null, 'cleanup')}
          >
            {rows
              ? t('devroom.phone.cleanup', { count: rows.length, size: rows.some((r) => r.sizePending) ? t('devroomFix.sizeMeasuring') : sizeText(totalBytes(rows)) })
              : t('devroom.cleanup', { count: merged })}
          </button>
        </>
      )}
      </div>
    </section>
  );
}

/** The project filter as one row of chips (W5's header names the project). */
/** The project chips (with more than one project) and, for an owner, `+ 프로젝트 추가`. */
function ProjectChips({ projects, onAdd }: { projects: string[]; onAdd?: () => void }) {
  const { filter } = useDevroom();
  const shown = shownProject(projects, filter);
  return (
    <div className="flex gap-6 px-12 pt-8 overflow-x-auto" role="radiogroup" aria-label={t('devroom.filter')} data-testid="devroom-filter">
      {(projects.length > 1 ? [null, ...projects] : []).map((p) => (
        <button
          key={p ?? ''}
          type="button"
          role="radio"
          aria-checked={p === shown}
          data-project={p ?? ''}
          className={`shrink-0 px-10 py-4 border-2 whitespace-nowrap ${SMALL} ${p === shown ? 'bg-accent border-accent text-white' : 'bg-btn-bg border-border'}`}
          onClick={() => setDevroomFilter(p)}
        >
          {p ?? t('devroom.allProjects')}
        </button>
      ))}
      {onAdd && (
        <button
          type="button"
          data-testid="devroom-add"
          className={`shrink-0 px-10 py-4 border-2 border-dashed border-border bg-btn-bg whitespace-nowrap ${SMALL}`}
          onClick={onAdd}
        >
          {t('devroom.add.button')}
        </button>
      )}
    </div>
  );
}

/** First visit: one line on what a card is and what its buttons do (kept per device). */
function FirstVisitHint() {
  const [seen, setSeen] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) === '1';
    } catch {
      return false;
    }
  });
  if (seen) return null;
  return (
    <div className={`mx-12 mt-8 flex items-start gap-8 px-10 py-6 border-2 border-devroom-box-line bg-devroom-box ${SMALL}`} data-testid="devroom-hint">
      <p className="flex-1 min-w-0">{t('devroom.phone.hint')}</p>
      <button
        type="button"
        className={`shrink-0 ${small}`}
        onClick={() => {
          try {
            localStorage.setItem(HINT_KEY, '1');
          } catch {
            // Private mode: hidden for this visit.
          }
          setSeen(true);
        }}
      >
        {t('devroom.phone.hintOk')}
      </button>
    </div>
  );
}

function Header({ title, onBack, children }: { title: string; onBack: () => void; children?: ReactNode }) {
  return (
    <div className="shrink-0 h-46 flex items-center gap-8 px-8 bg-bg-dark border-b-2 border-border">
      <button type="button" className={`shrink-0 px-9 py-5 border-2 border-border bg-btn-bg shadow-pixel min-h-36 ${SMALL}`} onClick={onBack} data-testid="devroom-back">
        {t('devroom.back')}
      </button>
      <span className={`flex-1 min-w-0 truncate text-text-muted ${BIG}`}>{title}</span>
      {children}
    </div>
  );
}

export function DevRoomPhone({
  onScreen,
  keyboardOpen,
  getAppearance,
  statusFor,
  agentTools,
  subagentTools,
}: {
  onScreen: boolean;
  keyboardOpen: boolean;
  getAppearance: (agentId: number) => AgentAppearance;
  statusFor: (agentId: number) => TabStatus | null;
  agentTools: Record<number, ToolActivity[]>;
  subagentTools: Record<number, Record<string, ToolActivity[]>>;
}) {
  return (
    <DevroomLooks.Provider value={{ getAppearance, statusFor }}>
      <DevroomTools.Provider value={{ agentTools, subagentTools }}>
        <PhoneBody onScreen={onScreen} keyboardOpen={keyboardOpen} />
      </DevroomTools.Provider>
    </DevroomLooks.Provider>
  );
}

function PhoneBody({ onScreen, keyboardOpen }: { onScreen: boolean; keyboardOpen: boolean }) {
  useDevroomView(onScreen);
  const canAct = useCanAct();
  const [asking, setAsking] = useState(false);
  const [adding, setAdding] = useState(false);
  const { projects, groups } = useDevroomGroups();
  const { filter, page } = useDevroom();
  const name = shownProject(projects, filter) ?? t('devroom.allProjects');
  const pick = useCurrentPick(groups);
  const row = pick?.task ? groups.find((g) => g.project === pick.project)?.rows.find((r) => r.wt.task === pick.task) : undefined;
  const wt = pick?.task ? row?.wt : null;
  useOpenWhenShown(groups);
  // DV4 M2: the agent tray when one project is in view (hold a chip, then pick its worktree).
  const one = groups.length === 1 ? groups[0] : undefined;
  return (
    <div className="relative flex-1 min-h-0 flex flex-col" data-testid="devroom-phone">
      <DevroomLoading groups={groups} />
      {groups.map((g) => (
        <RepoWatch key={g.project} project={g.project} />
      ))}
      {page !== null && pick ? (
        <>
          <Header title={`${row ? phoneTitle(row) : (pick.task ?? pick.project)} · ${page === 'runs' ? t('devroom.run.label') : t(`devroom.tab.${page}`)}`} onBack={closeDevroomPage} />
          <div className="flex-1 min-h-0 flex flex-col" data-testid="devroom-page" data-page={page}>
            {page === 'changes' && pick.task ? (
              <ChangesTab project={pick.project} task={pick.task} on={onScreen} />
            ) : page === 'merge' && pick.task ? (
              <MergeTab project={pick.project} task={pick.task} view="merge" phone />
            ) : page === 'runs' && pick.task ? (
              <PhoneRuns project={pick.project} task={pick.task} assignee={row?.wt.assignee} />
            ) : page === 'preview' && pick.task ? (
              <PreviewTab project={pick.project} task={pick.task} phone />
            ) : page === 'cleanup' ? (
              <MergeTab project={pick.project} task={pick.task} view="cleanup" />
            ) : wt !== undefined ? (
              <PhoneTerminal project={pick.project} wt={wt} on={onScreen} keyboardOpen={keyboardOpen} />
            ) : null}
          </div>
        </>
      ) : (
        <>
          <Header title={t('devroom.phone.title', { name })} onBack={() => closeWindow('devroom')}>
            <PaletteSearchButton className={`shrink-0 flex items-center justify-center ${small} shadow-pixel min-h-36 min-w-36`} />
            {canAct && projects.length > 0 && (
              <button type="button" className={`shrink-0 ${small} shadow-pixel min-h-36`} data-testid="devroom-new" onClick={() => setAsking(true)}>
                {t('devroom.phone.newTask')}
              </button>
            )}
          </Header>
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden pb-12">
            {(projects.length > 1 || canAct) && <ProjectChips projects={projects} onAdd={canAct ? () => setAdding(true) : undefined} />}
            <FirstVisitHint />
            {groups.length === 0 && <p className={`p-16 text-text-muted ${BODY}`}>{t('devroom.noProjects')}</p>}
            {groups.map((g) => (
              <PhoneGroup key={g.project} group={g} all={groups.length > 1} />
            ))}
            {canAct && one?.repo?.ok && (
              <div className="px-12">
                <AgentTray group={one} />
              </div>
            )}
          </div>
          {asking && <NewTaskDialog projects={projects} onClose={() => setAsking(false)} />}
          {adding && <AddProjectDialog onClose={() => setAdding(false)} />}
        </>
      )}
    </div>
  );
}
