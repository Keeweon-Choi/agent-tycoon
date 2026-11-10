/**
 * P4 개발실 (dev room, mockups-1101/devroom-W1b): the desktop window's body. Left, the worktree
 * rail (WorktreeRail.tsx); right, the picked worktree's tabs 터미널 | 변경 | 머지 and a footer.
 * The 터미널 tab is AgentColumns.tsx, 변경 S3's (ChangesTab), 머지 and the 워크트리 정리 view S4's
 * (MergeTab); the footer's right end is the daemon's devroomStats.
 */
import { useState } from 'react';

import type { AgentAppearance, TabStatus } from '../../components/AgentCard.js';
import { Button } from '../../components/ui/Button.js';
import { DEVROOM_MENU_W_PX } from '../../constants.js';
import { t } from '../../i18n/index.js';
import type { ToolActivity } from '../../office/types.js';
import { useEngineStore } from '../engineStore.js';
import { CommandGlyph } from '../hud/glyphs.js';
import { hudGetSnapshot, minimizeWindow } from '../hud/hudStore.js';
import { useAgtyStore } from '../officeStore.js';
import { projectOfAgent } from '../workbench/workbenchState.js';
import { openWorkbench, setWorkbenchTab } from '../workbench/workbenchStore.js';
import { TerminalColumns } from './AgentColumns.js';
import { ChangesTab } from './ChangesTab.js';
import {
  BODY,
  DevroomLooks,
  DevroomTools,
  SMALL,
  terminalCount,
  useCurrentPick,
  useDevroomGroups,
  useDevroomView,
  useTerminalColumns,
} from './devroomData.js';
import {
  type DevroomTab,
  openDevRoom,
  pickKey,
  setDevroomTab,
  toggleMenu,
  useDevroom,
} from './devroomStore.js';
import { MergeTab } from './MergeTab.js';
import { PreviewTab } from './PreviewTab.js';
import { RunArea, RunRow } from './RunRow.js';
import { liveRuns } from './runState.js';
import { DevroomLoading, type MenuSpot, RepoWatch, WorktreeMenu, WorktreeRail } from './WorktreeRail.js';

/** Mock-up I: a conversation's header button, `⌘` → the dev room on that agent's project (its trunk). */
export function DevroomLink({ name }: { name: string }) {
  const engine = useEngineStore().state?.projects ?? [];
  const project = projectOfAgent(name, engine);
  if (!engine.some((p) => p.name === project && !p.role)) return null;
  return (
    <Button
      size="icon_md"
      aria-label={t('devroom.open')}
      title={t('devroom.open')}
      data-testid="devroom-link"
      onClick={() => openDevRoom(project)}
    >
      <CommandGlyph px={1} />
    </Button>
  );
}

const TABS: readonly Exclude<DevroomTab, 'cleanup' | 'runs'>[] = ['terminal', 'changes', 'merge', 'preview'];

export function DevRoom({
  onScreen,
  getAppearance,
  statusFor,
  agentTools,
  subagentTools,
}: {
  onScreen: boolean;
  getAppearance: (agentId: number) => AgentAppearance;
  statusFor: (agentId: number) => TabStatus | null;
  agentTools: Record<number, ToolActivity[]>;
  subagentTools: Record<number, Record<string, ToolActivity[]>>;
}) {
  return (
    <DevroomLooks.Provider value={{ getAppearance, statusFor }}>
      <DevroomTools.Provider value={{ agentTools, subagentTools }}>
        <DevRoomBody onScreen={onScreen} />
      </DevroomTools.Provider>
    </DevroomLooks.Provider>
  );
}

function DevRoomBody({ onScreen }: { onScreen: boolean }) {
  useDevroomView(onScreen);
  const { projects, groups } = useDevroomGroups();
  const { tab, menu, stats, agent } = useDevroom();
  const [spot, setSpot] = useState<MenuSpot | null>(null);
  const pick = useCurrentPick(groups);
  const group = pick ? groups.find((g) => g.project === pick.project) : undefined;
  const row = pick?.task ? group?.rows.find((r) => r.wt.task === pick.task) : undefined;
  const menuRow = spot && menu === spot.key ? groups.flatMap((g) => g.rows.map((r) => ({ g, r }))).find(({ g, r }) => pickKey(g.project, r.wt.task) === spot.key) : undefined;
  const trunk = pick !== null && pick.task === null;
  const passed = row?.task?.testsPassed?.value === true;
  const runs = liveRuns(useAgtyStore().officeJobs?.jobs ?? []);
  const term = useTerminalColumns(pick && (trunk || row) ? pick.project : null, row?.wt ?? null);
  // DEVROOM-SIDEBAR: an agent row of the rail decides who the pane shows.
  const want = agent && pick && agent.project === pick.project && term.cols.some((c) => c.name === agent.name) ? agent : null;
  return (
    <div
      data-devroom-root
      data-testid="devroom"
      className="relative flex flex-1 min-h-0 -m-10"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && menu) toggleMenu(null);
      }}
    >
      {groups.map((g) => (
        <RepoWatch key={g.project} project={g.project} />
      ))}
      <DevroomLoading groups={groups} />
      <WorktreeRail projects={projects} groups={groups} onMenu={setSpot} />
      <section className="flex-1 min-w-0 flex flex-col min-h-0">
        <nav className="h-44 shrink-0 ui-tabs px-10 bg-surface-head border-b-2 border-devroom-card-line" aria-label={t('devroom.tabs')}>
          {TABS.map((id) => {
            const on = tab === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={on}
                data-tab={id}
                disabled={trunk && id !== 'terminal'}
                className={`ui-tab ui-raise ${BODY}`}
                onClick={() => setDevroomTab(id)}
              >
                {t(`devroom.tab.${id}`)}
                {id === 'merge' && row?.chip === 'conflict' && (
                  <b className="ml-6 font-normal text-devroom-conf">{t('merge.tabConflict')}</b>
                )}
              </button>
            );
          })}
          {tab === 'terminal' && pick && (
            <span className={`ml-auto text-text-muted truncate ${SMALL}`} data-testid="devroom-term-count">
              {terminalCount(term.cols, term.subs)}
            </span>
          )}
        </nav>
        {pick && tab !== 'cleanup' && <RunRow project={pick.project} task={pick.task ?? ''} />}
        <div className="flex-1 min-h-0 flex flex-col" data-testid="devroom-body" data-tab={tab}>
          {!pick ? (
            <p className={`m-auto text-text-muted ${BODY}`}>{t('devroom.pickHint')}</p>
          ) : tab === 'cleanup' ? (
            <MergeTab project={pick.project} task={pick.task} view="cleanup" />
          ) : tab === 'changes' && pick.task ? (
            <ChangesTab project={pick.project} task={pick.task} on={onScreen} />
          ) : tab === 'merge' && pick.task ? (
            <MergeTab project={pick.project} task={pick.task} view="merge" />
          ) : tab === 'preview' && pick.task ? (
            <PreviewTab project={pick.project} task={pick.task} />
          ) : (
            <RunArea project={pick.project} task={pick.task ?? ''} assignee={row?.wt.assignee}>
              <TerminalColumns project={pick.project} cols={term.cols} subs={term.subs} focus={want?.name ?? term.focus} want={want} on={onScreen} />
            </RunArea>
          )}
        </div>
        <footer className={`h-46 shrink-0 flex items-center gap-10 px-12 bg-devroom-foot border-t-2 border-border ${SMALL}`} data-testid="devroom-footer">
          {pick && (
            <span className="text-text-muted truncate" data-testid="devroom-picked">
              {t('devroom.picked', {
                name: row?.title ?? t('devroom.lead', { lead: pick.project }),
                branch: row?.wt.branch ?? group?.repo?.branch ?? 'main',
              })}
            </span>
          )}
          {passed && <span className="text-devroom-ok shrink-0">{t('devroom.tests')}</span>}
          {/* Owner 11-06 18:10: the 개발실 commands, the 현황판 shows how the project goes; one press between them. */}
          {pick && (
            <button
              type="button"
              className="shrink-0 text-accent-text hover:underline"
              data-testid="devroom-open-board"
              title={t('devroom.openBoardTitle', { project: pick.project })}
              onClick={() => {
                // A maximized window stays above the others: a maximized 개발실 steps aside for the 현황판.
                if (hudGetSnapshot().layout.items.devroom?.max) minimizeWindow('devroom');
                setWorkbenchTab('cockpit');
                openWorkbench(pick.project);
              }}
            >
              {t('devroom.openBoard')} →
            </button>
          )}
          <span className="flex-1" />
          {runs > 0 && (
            <span className="shrink-0 text-text-muted" data-testid="devroom-runs">
              {t('devroom.run.count', { count: runs })} ·
            </span>
          )}
          {stats && (
            <span className="shrink-0 text-text-muted" data-testid="devroom-stats">
              {t(stats.hostRssMib === undefined ? 'devroom.stats' : 'devroom.statsHost', {
                terminals: stats.terminals,
                rss: stats.rssMib,
                host: stats.hostRssMib ?? 0,
              })}
            </span>
          )}
        </footer>
      </section>
      {menuRow && spot && (
        <>
          <div className="absolute inset-0 z-10" aria-hidden="true" onClick={() => toggleMenu(null)} />
          <div
            className="absolute z-20 bg-devroom-menu border-2 border-devroom-main-line shadow-pixel"
            style={{ left: spot.x, top: spot.y, width: DEVROOM_MENU_W_PX }}
          >
            <WorktreeMenu project={menuRow.g.project} row={menuRow.r} base={menuRow.g.repo?.branch ?? menuRow.r.wt.base} />
          </div>
        </>
      )}
    </div>
  );
}
