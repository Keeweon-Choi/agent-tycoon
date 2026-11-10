import { useEffect, useMemo, useState } from 'react';

import { t } from '../../i18n/index.js';
import type { ToolActivity } from '../../office/types.js';
import { AddDeviceButton } from '../auth/AddDevice.js';
import { EngineSection } from '../EngineControls.js';
import { useEngineStore } from '../engineStore.js';
import { ActivityLegend } from '../ez/ActivityLegend.js';
import { FileExplorer } from '../files/FileExplorer.js';
import { FloorPicker } from '../FloorControls.js';
import type { OfficePanel } from '../format.js';
import { HeatGauge, JobCounter } from '../game/GameHud.js';
import { GameOptions } from '../GameOptions.js';
import { HostClock } from '../HostClock.js';
import { useAgtyStore } from '../officeStore.js';
import { TerminalWorkspace } from '../terminal/TerminalWorkspace.js';
import { useToastTop } from '../toastSlot.js';
import { useWaitReasons } from '../waiting.js';
import { ActivityList, ApprovalList, KpiRow, RoomColumn, SystemSummary, TaskTable } from './Dashboard.js';
import { approvals, taskRows } from './dashboardModel.js';
import { RunsPanel } from './RunsPanel.js';
import { groupRooms, leadRings, useBoardFilter } from './statusTree.js';

export type { OfficePanel } from '../format.js';

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * A5: the 현황판's first page, the dashboard (GPT mockup gpt-1). The count cards on top; the projects on
 * the left; the issues in progress and who waits on the owner in the middle; the feed, the usage and
 * the host on the right. A project narrows the middle column; the cards count the whole office. The
 * orchestrators themselves are the party's (owner 11-06 15:26).
 */
function StatusPanel({
  agentTools,
  now,
}: {
  agentTools: Record<number, ToolActivity[]>;
  now: number;
}) {
  const store = useAgtyStore();
  const { officeSnapshot: officeState, taskBoard } = store;
  const filter = useBoardFilter();
  const reasons = useWaitReasons();
  const engineProjects = useEngineStore().state?.projects;
  const workers = useMemo(
    () => new Set((engineProjects ?? []).filter((p) => p.role).map((p) => p.name)),
    [engineProjects],
  );
  if (!officeState) return <Empty />;
  const rooms = groupRooms(officeState, workers);
  // Every agent's room, Workers too: their Tasks and their waits follow their project's room.
  const roomOf = new Map(groupRooms(officeState).flatMap((room) => room.rows.map((o) => [o.name, room.name] as const)));
  const room = rooms.some((r) => r.name === filter.room) ? filter.room : null;
  const idOf = new Map(officeState.orchestrators.map((o) => [o.name, o.agentId]));
  const waitOf = (name: string) => {
    const id = idOf.get(name);
    return (id != null && reasons[id]) || null;
  };
  const waiting = approvals(reasons, officeState.orchestrators, agentTools, () => true);
  // Every issue in progress with its pill; the left column counts them per project.
  const open = taskRows(taskBoard?.tasks ?? [], waitOf, () => true);
  const inRoom = (name: string) => room === null || roomOf.get(name) === room;
  return (
    <div className="sb leading-tight" data-board-look>
      <KpiRow rings={leadRings(store, agentTools, reasons, workers)} waiting={waiting} now={now} />
      <div className="sb-cols">
        <RoomColumn rooms={rooms} rows={open} roomOf={roomOf} filter={{ ...filter, room }}>
          <EngineSection />
        </RoomColumn>
        <div className="sb-main">
          <TaskTable
            rows={open.filter((r) => inRoom(r.task.project))}
            now={now}
          />
          <ApprovalList rows={waiting.filter((a) => inRoom(a.name))} />
        </div>
        <div className="sb-right">
          <ActivityList now={now} />
          <SystemSummary />
        </div>
      </div>
    </div>
  );
}

function Empty() {
  return <p className="text-text-muted text-sm py-20 text-center">{t('panel.empty')}</p>;
}

export function OfficePanelContent({
  panel,
  agentTools,
  mobile = false,
  keyboardOpen = false,
}: {
  panel: Exclude<OfficePanel, 'dev'>;
  agentTools: Record<number, ToolActivity[]>;
  /** The phone's panel (T-0052: the terminal's key bar). */
  mobile?: boolean;
  keyboardOpen?: boolean;
}) {
  const now = useNow();
  if (panel === 'terminal')
    return <TerminalWorkspace mobile={mobile} keyboardOpen={keyboardOpen} />;
  if (panel === 'status') return <StatusPanel agentTools={agentTools} now={now} />;
  if (panel === 'runs') return <RunsPanel />;
  return <FileExplorer />;
}

/**
 * The phone's top bar (owner 10-24): only the floor, the clock and 설정 stay on top. 기기 추가,
 * 보안 and 범례 moved into 설정, two taps away: 기기 추가 under 연결, 범례 under 화면, 보안 is
 * its own tab (UI-FONT: they were a second row that looked like the tab row).
 */
export function MobileTopBar() {
  const bar = useToastTop<HTMLDivElement>();
  return (
    <div
      ref={bar}
      className="pixel-panel shrink-0 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-8 min-w-0 pt-[calc(var(--agty-safe-top)+4px)] pl-[calc(var(--agty-safe-left)+8px)] pr-[calc(var(--agty-safe-right)+8px)]"
      data-testid="mobile-top-bar"
    >
      {/* GAME-UI-1 (07): the job chip, and the heat only when it is hot. */}
      <div className="flex items-center gap-4 min-w-0">
        <FloorPicker />
        <JobCounter chip />
        <HeatGauge chip />
      </div>
      <HostClock size="text-sm" game />
      {/* 44×44 for the thumb; the bar has no bottom padding, so it is no taller than before. */}
      <div className="flex justify-end [&>button]:min-h-44 [&>button]:min-w-44 [&>button]:justify-center">
        <GameOptions
          phoneRows={{
            access: <AddDeviceButton zIndex={62} />,
            display: <ActivityLegend zIndex={62} />,
          }}
        />
      </div>
    </div>
  );
}
