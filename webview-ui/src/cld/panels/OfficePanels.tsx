import { useEffect, useMemo, useState } from 'react';

import type {
  OfficeOrchestrator,
  UsageProvider,
} from '../../../../core/src/messages.js';
import { Button } from '../../components/ui/Button.js';
import { t } from '../../i18n/index.js';
import type { ToolActivity } from '../../office/types.js';
import { transport } from '../../transport/index.js';
import { AddDeviceButton } from '../auth/AddDevice.js';
import { ChatAction } from '../ChatAction.js';
import { Chevron } from '../Chevron.js';
import { EngineCardButtons, EngineSection } from '../EngineControls.js';
import { useEngineProject, useEngineStore } from '../engineStore.js';
import { ActivityLegend } from '../ez/ActivityLegend.js';
import { ringSprite } from '../ez/drawVisuals.js';
import { FatigueBar, RestBubble } from '../ez/Fatigue.js';
import { PixelSprite } from '../ez/PixelSprite.js';
import { openStatDetail } from '../ez/statDetail.js';
import { type RingState, ringWord } from '../ez/visuals.js';
import { openProjectFiles } from '../files/explorerState.js';
import { FileExplorer } from '../files/FileExplorer.js';
import { FloorPicker } from '../FloorControls.js';
import {
  foldedFigures,
  isOff,
  type OfficePanel,
  percentTone,
  resetCountdown,
  stateLabel,
  timeAgo,
  usageWindows,
  usageWindowTitle,
} from '../format.js';
import { HeatGauge, JobCounter, UsageGauge } from '../game/GameHud.js';
import { HudMenu } from '../game/HudMenu.js';
import { GameOptions } from '../GameOptions.js';
import { HostClock } from '../HostClock.js';
import { RefreshGlyph } from '../hud/glyphs.js';
import { Movable } from '../hud/Movable.js';
import { eventIcon, isFeedNoise } from '../notify/newsList.js';
import {
  codexUsageCheckStarted,
  ezContext,
  fatigueFor,
  useCldStore,
  virtualAgentId,
} from '../officeStore.js';
import { serverLine } from '../serverText.js';
import { useStaff } from '../staff.js';
import { DutyMark, TempSummary } from '../TempList.js';
import { TerminalWorkspace } from '../terminal/TerminalWorkspace.js';
import { useToastTop } from '../toastSlot.js';
import { useWaitReasons } from '../waiting.js';
import { WaitMark } from '../WaitMark.js';
import { openWorkbench } from '../workbench/workbenchStore.js';
import {
  FILTERS,
  groupRooms,
  isOpen,
  passesFilter,
  roomSummary,
  type RowLook,
  rowLook,
  setAllOpen,
  setTreeFilter,
  toggleNode,
  type TreeFilter,
  useStatusTree,
  watchProjectStatus,
} from './statusTree.js';

export type { OfficePanel } from '../format.js';

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

const muted = 'text-text-muted text-xs';
const toneClass = { normal: 'text-text', warn: 'text-yellow-300', critical: 'text-red-400' };

/** The state ring's colour (T-0026); the words are always beside it. */
function RingSwatch({ ring }: { ring: RingState }) {
  return (
    <span className="shrink-0" title={ringWord(ring)} data-ring={ring}>
      <PixelSprite sprite={ringSprite(ring)} scale={2} />
    </span>
  );
}

/** 모두 펼치기 / 모두 접기 and the filter chips. */
function TreeControls({ filter }: { filter: TreeFilter }) {
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap gap-8">
        <Button size="sm" onClick={() => setAllOpen(true)}>
          {t('status.expandAll')}
        </Button>
        <Button size="sm" onClick={() => setAllOpen(false)}>
          {t('status.collapseAll')}
        </Button>
      </div>
      <div className="flex flex-wrap gap-4" role="group" aria-label={t('status.filter.label')}>
        {FILTERS.map((id) => (
          <Button
            key={id}
            size="sm"
            variant={filter === id ? 'active' : 'default'}
            aria-pressed={filter === id}
            onClick={() => setTreeFilter(id)}
          >
            {t(`status.filter.${id}`)}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** 최근 활동: the feed's last five events about this orchestrator. */
function RecentActivity({ name, now }: { name: string; now: number }) {
  const { events } = useCldStore();
  const mine = events.filter((event) => event.name === name && !isFeedNoise(event.kind)).slice(0, 5);
  return (
    <div>
      <p className="text-text-muted">{t('status.recent')}</p>
      {mine.length ? (
        <ol className="space-y-2 mt-2">
          {mine.map((event, i) => (
            <li key={`${event.ts}-${i}`} className="flex gap-8 min-w-0">
              <span aria-hidden="true">{eventIcon(event.kind)}</span>
              <span className="truncate flex-1 min-w-0">{serverLine(event.summary)}</span>
              <span className="text-text-muted shrink-0">{timeAgo(event.ts, now)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-text-muted mt-2">{t('status.noneYet')}</p>
      )}
    </div>
  );
}

/**
 * 프로젝트 현황: engine projects and local Claude sessions use the daemon's
 * read-only local report. Open, it refreshes every 10 s for this viewer;
 * collapsed or unmounted, it stops.
 */
function ProjectStatus({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const status = useCldStore().statusByName[name];
  useEffect(
    () => (open ? watchProjectStatus(name, (msg) => transport.send(msg)) : undefined),
    [open, name],
  );
  return (
    <div className="border-t border-border pt-8">
      <button
        type="button"
        className="flex items-start gap-8 w-full text-left pointer-coarse:min-h-44"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Chevron open={open} />
        <span className="break-keep">
          <strong>{t('status.project.title')}</strong>{' '}
          <span className="text-text-muted">{t('status.project.help')}</span>
        </span>
      </button>
      {open && (
        <div className="mt-8 min-w-0">
          {!status ? (
            <p className="text-text-muted">{t('status.loading')}</p>
          ) : (
            <>
              {status.git && (
                <div className="space-y-4">
                  <p>
                    {t('status.git.summary', {
                      branch: status.git.branch ?? '—',
                      count: status.git.dirty ?? 0,
                    })}
                  </p>
                  {status.git.recent.slice(0, 3).map((commit) => (
                    <p
                      key={commit.hash}
                      className="truncate text-text-muted"
                      title={commit.subject}
                    >
                      {commit.hash.slice(0, 7)} {commit.subject}
                    </p>
                  ))}
                </div>
              )}
              <pre
                className="mt-8 max-h-160 overflow-auto whitespace-pre-wrap break-words bg-black/30 p-8 text-xs font-mono"
                aria-label={t('status.commandOutput', { name })}
              >
                {status.output ? serverLine(status.output) : t('status.noOutput')}
                {status.truncated ? t('status.truncated') : ''}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function OrchestratorNode({
  orchestrator,
  look,
  open,
  now,
}: {
  orchestrator: OfficeOrchestrator;
  look: RowLook;
  open: boolean;
  now: number;
}) {
  const store = useCldStore();
  // T-0026: 피로도, once it has reported its context.
  const agentId = orchestrator.agentId ?? virtualAgentId(`orch:${orchestrator.name}`);
  const fatigue = fatigueFor(agentId, store);
  const engine = useEngineProject(orchestrator.name);
  // Who manages the row (T-0032): its badge, and where 설정 and 삭제 go.
  const provider = orchestrator.provider ?? (engine ? 'engine' : 'claude');
  const badge = engine || provider === 'engine' ? t('status.engineBadge') : null;
  // T-0041: its temps and the noise of its Codex tasks and jobs, summarised.
  const temps = useStaff().temps.filter((t) => t.leadId === agentId);
  const line = look.ez; // look.raw (the tool's own words) is the line's tooltip
  return (
    <article
      className={`pixel-panel min-w-0 ${isOff(orchestrator) ? 'opacity-65' : ''}`}
      data-ring={look.ring}
    >
      {/* The head row folds the card; the details stay selectable. */}
      <div
        className="px-8 py-2 min-w-0 pointer-coarse:min-h-44 cursor-pointer"
        onClick={() => toggleNode('orch', orchestrator.name)}
      >
        <div className="flex items-center gap-8 min-w-0">
          <h3 className="font-bold text-sm min-w-0">
            <button
              type="button"
              className="flex items-center gap-8 max-w-full text-left"
              aria-expanded={open}
            >
              <Chevron open={open} />
              <span className="truncate min-w-0">{orchestrator.name}</span>
            </button>
          </h3>
          {badge && (
            <span className="shrink-0 border border-border px-4 text-xs text-accent-text">
              {badge}
            </span>
          )}
          <DutyMark id={agentId} />
          <WaitMark agentId={orchestrator.agentId} />
          <span className="ml-auto" />
          {!open && (
            <Button
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                openProjectFiles(orchestrator.name);
              }}
            >
              {t('status.files')}
            </Button>
          )}
          <RingSwatch ring={look.ring} />
        </div>
        {!open && (
          <div className="flex items-center gap-8 min-w-0 text-xs">
            <span className="truncate flex-1 min-w-0" title={look.raw}>
              {line}
            </span>
            {fatigue && <FatigueBar look={fatigue} />}
          </div>
        )}
      </div>
      {open && (
        <div className="px-12 pb-12 pt-4 space-y-8 text-xs min-w-0">
          <p className="text-text-muted">{stateLabel(orchestrator.state, orchestrator.busy)}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-8 gap-y-4 min-w-0">
            <dt className="text-text-muted">{t('status.currentWork')}</dt>
            {/* One line with an ellipsis (UI-CONSISTENCY); the tool's own words are the tooltip. */}
            <dd className="truncate min-w-0" title={look.raw}>
              {line}
            </dd>
          </dl>
          {fatigue && (
            <div className="flex flex-col items-start gap-4">
              <FatigueBar look={fatigue} />
              {fatigue.rest && <RestBubble />}
            </div>
          )}
          {orchestrator.bg && ['working', 'blocked'].includes(orchestrator.bg.state) && (
            <p className="text-yellow-300">
              {orchestrator.bg.state === 'blocked'
                ? t('status.backgroundBlocked')
                : t('status.backgroundWorking')}
            </p>
          )}
          <TempSummary rows={temps} project={orchestrator.name} />
          <RecentActivity name={orchestrator.name} now={now} />
          {(provider === 'engine' || provider === 'claude') && !!orchestrator.dir && (
            <ProjectStatus name={orchestrator.name} />
          )}
          <div className="flex flex-wrap gap-8">
            <ChatAction agentId={agentId} variant="card" />
            <Button size="sm" data-testid="stat-open" onClick={() => openStatDetail(agentId)}>
              {t('stat.open')}
            </Button>
            <Button size="sm" onClick={() => openWorkbench(orchestrator.name)}>
              {t('dash.openDev')}
            </Button>
            <Button size="sm" onClick={() => openProjectFiles(orchestrator.name)}>
              {t('status.files')}
            </Button>
            {engine && <EngineCardButtons project={engine} />}
          </div>
        </div>
      )}
    </article>
  );
}

/** T-0029: the 현황판 as a tree, rooms → orchestrators, each folding on its own. */
function StatusPanel({
  agentTools,
  now,
}: {
  agentTools: Record<number, ToolActivity[]>;
  now: number;
}) {
  const store = useCldStore();
  const { officeSnapshot: officeState } = store;
  const tree = useStatusTree();
  const reasons = useWaitReasons();
  const engineProjects = useEngineStore().state?.projects;
  const workers = useMemo(
    () => new Set((engineProjects ?? []).filter((p) => p.role).map((p) => p.name)),
    [engineProjects],
  );
  if (!officeState) return <Empty />;
  const ctx = ezContext(store);
  const looks = new Map(
    officeState.orchestrators.map((o) => [
      o.name,
      rowLook(
        o,
        o.agentId != null ? agentTools[o.agentId] : undefined,
        ctx,
        o.agentId != null && reasons[o.agentId] === 'question',
      ),
    ]),
  );
  const ring = (o: OfficeOrchestrator) => looks.get(o.name)!.ring;
  const rooms = groupRooms(officeState, workers);
  const shown = rooms
    .map((room) => ({ room, rows: room.rows.filter((o) => passesFilter(tree.filter, ring(o))) }))
    .filter(({ rows }) => rows.length > 0);
  return (
    <div className="space-y-8 leading-tight">
      <EngineSection />
      {rooms.length > 0 && <TreeControls filter={tree.filter} />}
      {rooms.length > 0 && !shown.length && (
        <p className="text-text-muted text-sm">{t('status.noMatches')}</p>
      )}
      {shown.map(({ room, rows }) => {
        const open = isOpen(tree, 'room', room.name);
        const summary = roomSummary(room.rows.map(ring));
        return (
          <section key={room.name}>
            {/* Folded: the worst badge beside the name, the counts on a line of
                their own. */}
            <div className="flex items-center gap-8">
              <div
                className="flex-1 min-w-0 cursor-pointer pointer-coarse:min-h-44"
                onClick={() => toggleNode('room', room.name)}
              >
                <div className="flex items-center gap-8 min-w-0">
                  <h2 className="text-sm font-bold min-w-0">
                    <button
                      type="button"
                      className="flex items-center gap-8 max-w-full text-left"
                      aria-expanded={open}
                    >
                      <Chevron open={open} />
                      <span className="truncate min-w-0">{serverLine(room.name)}</span>
                    </button>
                  </h2>
                  {!open && (
                    <span
                      className="flex items-center gap-4 shrink-0 text-xs"
                      data-testid="room-worst"
                    >
                      <RingSwatch ring={summary.worst} />
                      {ringWord(summary.worst)}
                    </span>
                  )}
                </div>
                {!open && (
                  <p className="text-xs text-text-muted" data-testid="room-summary">
                    {t('status.roomSummary', {
                      working: summary.working,
                      waiting: summary.waiting,
                      off: summary.off,
                    })}
                  </p>
                )}
              </div>
            </div>
            {open && (
              <div className="space-y-4 mt-4">
                {rows.map((orch) => (
                  <OrchestratorNode
                    key={orch.name}
                    orchestrator={orch}
                    look={looks.get(orch.name)!}
                    open={isOpen(tree, 'orch', orch.name)}
                    now={now}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
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
  return <FileExplorer />;
}

export function UsagePair({ provider, now }: { provider: UsageProvider; now: number }) {
  const windows = usageWindows(provider);
  if (!windows.length)
    return <span className={muted}>{t('usage.noInfo', { name: provider.name })}</span>;
  return (
    <div className="flex flex-wrap gap-x-12 gap-y-4 items-center text-xs min-w-0">
      <strong className="text-accent-text">{provider.name}</strong>
      {windows.map((w) => (
        <span
          key={w.id}
          className={`${toneClass[percentTone(w.pct)]} min-w-0 break-keep [overflow-wrap:anywhere]`}
          title={w.isReset ? undefined : resetCountdown(w.resetAt, now)}
          data-testid="usage-detail-window"
        >
          {usageWindowTitle(w)}
        </span>
      ))}
    </div>
  );
}

/** GAME-UI-1: the gauges are the folded strip and the default; the detail (every window and its reset) is one click, remembered per viewer. */
const USAGE_DETAIL_KEY = 'cld.usage-detail';
function usageDetail(): boolean {
  try {
    return localStorage.getItem(USAGE_DETAIL_KEY) === '1';
  } catch {
    return false;
  }
}

/** The cld top bar as a game HUD (GAME-UI-1, ideas/agents 07; HUD-2B the resource bar): the usage gauges as
 *  rows (HP/MP), the game clock in the bar's exact centre, then the job counter, the CPU heat and 메뉴. It is the top of the page, so it
 *  clears the iPhone safe-area insets. */
export function UsageBar() {
  const bar = useToastTop<HTMLDivElement>();
  return (
    <Movable id="usage" label={t('usage.bar')} z={49}>
      {/* Three tracks, the sides equal: the clock sits in the bar's exact horizontal centre
          and neither side can run under it (owner 10-24). */}
      <div
        ref={bar}
        className="pixel-panel grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-8 gap-y-8 min-w-0 pb-8 pt-[calc(var(--cld-safe-top)+8px)] pl-[calc(var(--cld-safe-left)+10px)] pr-[calc(var(--cld-safe-right)+10px)]">
        <div className="flex min-w-0">
          <UsageLine />
        </div>
        <HostClock game />
        <div className="flex flex-wrap items-center justify-end gap-8 min-w-0">
          <JobCounter />
          <HeatGauge />
          <FloorPicker />
          {/* HUD-2B: 기기 추가 · 보안 · 범례 · 설정 under one 메뉴. */}
          <HudMenu />
          {/* The settings window, its opener and the install note; 메뉴 → 설정 opens it, so no button here. */}
          <GameOptions trigger={false} />
        </div>
      </div>
    </Movable>
  );
}

/** Re-reads Codex's usage on demand (the one provider that can be). */
function CodexRefresh() {
  const { officeReadOnly, codexUsageChecking } = useCldStore();
  if (officeReadOnly) return null;
  return (
    <Button
      size="icon_md"
      title={t('usage.checkCodexTitle')}
      aria-label={t(codexUsageChecking ? 'usage.checkingCodex' : 'usage.checkCodex')}
      aria-busy={codexUsageChecking}
      data-testid="usage-refresh"
      disabled={codexUsageChecking}
      onClick={() => {
        codexUsageCheckStarted();
        transport.send({ type: 'codexUsageCheck' });
      }}
    >
      <span className={codexUsageChecking ? 'animate-spin' : 'flex'}>
        <RefreshGlyph />
      </span>
    </Button>
  );
}

/**
 * The usage figures, folded to one line or open (per viewer). The desktop's top bar
 * carries it beside its buttons; the phone shows it alone at the bottom, folded
 * until the viewer opens it (owner 10-24: the usage goes to the bottom space).
 */
export function UsageLine({ phone = false }: { phone?: boolean }) {
  const { usageState } = useCldStore();
  const now = useNow();
  const [folded, setFolded] = useState(() => !usageDetail());
  const fold = (next: boolean) => {
    setFolded(next);
    try {
      localStorage.setItem(USAGE_DETAIL_KEY, next ? '0' : '1');
    } catch {
      // Private mode: this visit still remembers it.
    }
  };
  if (!usageState) return null;
  // UI-FIX 6: a phone leaves out a provider with no figures, and the whole line when none has any.
  const providers = phone
    ? usageState.providers.filter((provider) => foldedFigures(provider).length > 0)
    : usageState.providers;
  if (phone && providers.length === 0) return null;
  const codex = !phone && providers.some((p) => p.id === 'codex');
  const line = folded ? (
    <div className="flex items-center gap-4 flex-[1_1_240px] min-w-0">
      {/* GAME-UI-1: the gauges; a click opens the detail. The phone keeps the 5-hour windows only. */}
      <button
        type="button"
        className="flex items-center gap-4 min-w-0 text-left pointer-coarse:min-h-44"
        aria-expanded={false}
        title={t('usage.expand')}
        data-testid="usage-folded"
        onClick={() => fold(false)}
      >
        <Chevron open={false} />
        {/* HUD-2B: one row per provider, the bars one under the other (the phone too, MOBILE-QUEST: one ▶ for both rows). */}
        <span className="game-gx-rows">
          {providers.map((provider) => (
            <UsageGauge key={provider.id} provider={provider} now={now} phone={phone} />
          ))}
        </span>
      </button>
      {codex && <CodexRefresh />}
    </div>
  ) : (
    <div className="flex items-start gap-8 flex-[1_1_240px] min-w-0">
      <Button
        size="icon_md"
        variant="ghost"
        aria-expanded
        aria-label={t('usage.collapse')}
        onClick={() => fold(true)}
      >
        <Chevron open />
      </Button>
      <div className="flex flex-wrap gap-x-20 gap-y-4 flex-1 min-w-0" aria-label={t('usage.label')}>
        {providers.map((provider) => (
          <div key={provider.id} className="flex items-center gap-8 min-w-0">
            <UsagePair provider={provider} now={now} />
            {/* ponytail: the one provider whose usage can be re-read on demand is Codex; a provider with its own refresh would add a flag to the message. */}
            {provider.id === 'codex' && <CodexRefresh />}
          </div>
        ))}
      </div>
    </div>
  );
  // The phone's line is the last row of its page, above the tab bar, and only exists with figures. A phone on its
  // side is too short for it (the top bar, page header and tab bar already take half the screen).
  return phone ? (
    <div className="flex border-t-2 border-border pl-[calc(var(--cld-safe-left)+8px)] pr-[calc(var(--cld-safe-right)+8px)] [@media(orientation:landscape)_and_(max-height:500px)]:hidden">
      {line}
    </div>
  ) : (
    line
  );
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
      className="pixel-panel shrink-0 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-8 min-w-0 pt-[calc(var(--cld-safe-top)+4px)] pl-[calc(var(--cld-safe-left)+8px)] pr-[calc(var(--cld-safe-right)+8px)]"
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
