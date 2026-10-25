import { Fragment, useEffect, useMemo, useState } from 'react';

import type {
  GpuTicket,
  HwSample,
  OfficeOrchestrator,
  UsageWindow,
} from '../../../../core/src/messages.js';
import { Button } from '../../components/ui/Button.js';
import { t } from '../../i18n/index.js';
import type { ToolActivity } from '../../office/types.js';
import { isBrowserRuntime } from '../../runtime.js';
import { transport } from '../../transport/index.js';
import { AddDeviceButton } from '../auth/AddDevice.js';
import { SecurityButton } from '../auth/SecurityPanel.js';
import { ChatAction } from '../ChatAction.js';
import { Chevron } from '../Chevron.js';
import { EngineCardButtons, EngineSection } from '../EngineControls.js';
import { useEngineProject, useEngineStore } from '../engineStore.js';
import { ActivityLegend } from '../ez/ActivityLegend.js';
import { ringSprite } from '../ez/drawVisuals.js';
import { FatigueBar, RestBubble } from '../ez/Fatigue.js';
import { PixelSprite } from '../ez/PixelSprite.js';
import { type RingState, ringWord } from '../ez/visuals.js';
import { openProjectFiles } from '../files/explorerState.js';
import { FileExplorer } from '../files/FileExplorer.js';
import { FloorPicker } from '../FloorControls.js';
import {
  foldedFigures,
  hwClock,
  hwSections,
  hwSensorsHint,
  isOff,
  modelName,
  modelTag,
  type OfficePanel,
  percentTone,
  resetCountdown,
  stateLabel,
  timeAgo,
  usageWindowText,
} from '../format.js';
import { GameOptions } from '../GameOptions.js';
import { HostClock } from '../HostClock.js';
import { RefreshGlyph } from '../hud/glyphs.js';
import { Movable } from '../hud/Movable.js';
import { cpuCoreRows, cpuFigures, ramFigures } from '../hwDetail.js';
import { type HwViewKind, hwViewModel, setHwPrefs, useHwPrefs } from '../hwView.js';
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

const section = 'pixel-panel p-12 min-w-0';
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
          <span className="ml-auto" />
          {isBrowserRuntime && !open && (
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
            <Button size="sm" onClick={() => openWorkbench(orchestrator.name)}>
              {t('status.workbench')}
            </Button>
            {isBrowserRuntime && (
              <Button size="sm" onClick={() => openProjectFiles(orchestrator.name)}>
                {t('status.files')}
              </Button>
            )}
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
      rowLook(o, o.agentId != null ? agentTools[o.agentId] : undefined, ctx),
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

const hwTone = { warn: 'text-red-400', critical: 'text-red-500 font-bold' };
/** T-0030: each reading with its source; what nothing measured is left out. */
function HardwarePanel() {
  const { hwSample: hw } = useCldStore();
  const prefs = useHwPrefs();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    transport.send({ type: 'hwView', on: true });
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => {
      window.clearInterval(timer);
      transport.send({ type: 'hwView', on: false });
    };
  }, []);
  return (
    <div className="space-y-12 pb-[var(--cld-safe-bottom)] min-w-0" data-testid="hw-panel">
      <p className={`${muted} tabular-nums`} data-testid="hw-clock">
        {hwClock(now)}
      </p>
      {!hw && <Empty />}
      {hw && (
        <>
          {hwViewModel(hw, prefs.view).canToggle && (
            <Button
              size="sm"
              data-testid="hw-view-toggle"
              data-view={prefs.view}
              aria-label={t('board.viewToggle')}
              title={t('board.viewToggle')}
              onClick={() => setHwPrefs({ view: prefs.view === 'wsl' ? 'windows' : 'wsl' })}
            >
              <span className={prefs.view === 'wsl' ? 'text-accent-text font-bold' : muted}>
                WSL
              </span>
              {' ↔ '}
              <span className={prefs.view === 'windows' ? 'text-accent-text font-bold' : muted}>
                Windows
              </span>
            </Button>
          )}
          {hw.stale && <p className="text-red-400 font-bold">{t('hardware.stale')}</p>}
          {hw.sensorsHint && <p className={`${muted} break-words`}>{hwSensorsHint()}</p>}
          {hw.lhm === false && !hw.sensorsHint && (
            <p className="text-yellow-300">{t('hardware.noTemperature')}</p>
          )}
          {hwSections(hw, prefs.view).map((card) => (
            <div key={card.title} className={section}>
              <h2 className="font-bold mb-4">{card.title}</h2>
              {card.rows.map((row) => (
                <div
                  key={row.key}
                  className="flex justify-between gap-8 border-b border-border/50 py-4 text-sm"
                >
                  <span className="text-text-muted">{row.label}</span>
                  <span className="text-right">
                    <span className={row.tone ? hwTone[row.tone] : ''}>{row.text}</span>
                    {row.source && <span className={muted}> · {row.source}</span>}
                  </span>
                </div>
              ))}
              {card.fold === 'cpu' && <CoresFold hw={hw} />}
              {card.fold === 'ram' && <RamFold hw={hw} view={prefs.view} />}
            </div>
          ))}
          {hw.warnings.map((warning) => (
            <p key={warning} className="text-red-400 text-sm break-words">
              ⚠ {serverLine(warning)}
            </p>
          ))}
          <GpuBoard />
        </>
      )}
    </div>
  );
}

const foldRow = 'flex justify-between gap-8 border-b border-border/50 py-4 text-sm';

/** The CPU's cores, one row each (the lobby board's CPU detail, folded). */
function CoresFold({ hw }: { hw: HwSample }) {
  const { rows } = cpuCoreRows(hw);
  return (
    <details className="mt-4" data-testid="hw-fold-cores">
      <summary className="cursor-pointer text-sm">{t('hwDetail.perCore')}</summary>
      {cpuFigures(hw).map((f) => (
        <div key={f.id} className={foldRow}>
          <span className="text-text-muted">{f.label}</span>
          <span className={f.tone ? hwTone[f.tone] : ''}>{f.text}</span>
        </div>
      ))}
      {rows.length === 0 && <p className={`${muted} py-4`}>{t('hwDetail.needsLhm')}</p>}
      {rows.map((c) => (
        <div key={c.name} className={`${foldRow} tabular-nums`} data-testid="hw-core">
          <span className="text-text-muted">{c.name}</span>
          <span className="text-right">
            {[c.clock && `${c.clock} MHz`, c.temp, c.load].filter(Boolean).join(' · ')}
          </span>
        </div>
      ))}
    </details>
  );
}

/** The memory of the side shown: used, cache, available, swap (WSL) or load and virtual memory (Windows). */
function RamFold({ hw, view }: { hw: HwSample; view: HwViewKind }) {
  const figures = ramFigures(hw, view, hwViewModel(hw, view).ram);
  if (figures.length < 2) return null;
  return (
    <details className="mt-4" data-testid="hw-fold-ram">
      <summary className="cursor-pointer text-sm">{t('hwDetail.ramDetail')}</summary>
      {figures.map((f) => (
        <div key={f.id} className={foldRow}>
          <span className="text-text-muted">{f.label}</span>
          <span>{f.text}</span>
        </div>
      ))}
    </details>
  );
}

/** T-0021: who holds the GPU and who waits, in line order (gpuBoard: office's and the engine's). */
function GpuBoard() {
  const { gpuBoard: g } = useCldStore();
  if (!g) return null;
  const kind = (ticket: GpuTicket) =>
    ticket.exclusive
      ? t('gpu.kind.exclusive')
      : t('gpu.kind.shared', { amount: ticket.vramGib ?? '?' });
  const row = (t: GpuTicket, head: string, tone: string) => (
    <div key={t.id} className="flex justify-between gap-8 border-b border-border/50 py-4 text-sm">
      <span className="min-w-0 break-words">
        <span className={tone}>{head}</span> {t.project}
        {t.label && <span className={muted}> · {t.label}</span>}
      </span>
      <span className={`${muted} shrink-0`}>{kind(t)}</span>
    </div>
  );
  return (
    <div className={section} data-testid="gpu-board">
      <h2 className="font-bold mb-4">{t('gpu.title')}</h2>
      {!g.holders.length && !g.queue.length && <p className={muted}>{t('gpu.empty')}</p>}
      {g.holders.map((ticket) => row(ticket, t('gpu.reserved'), 'text-accent-text'))}
      {g.queue.map((ticket, i) =>
        row(ticket, t('gpu.waiting', { position: i + 1 }), 'text-yellow-300'),
      )}
      {g.unleased?.map((p) => (
        <p key={p.pid} className="text-yellow-300 text-sm break-words">
          {t('gpu.unleased')} · {p.cmd ? `${p.cmd}(${p.pid})` : `pid ${p.pid}`}
          {p.usedMib != null && ` · ${p.usedMib} MiB`}
        </p>
      ))}
      {g.processesUnknown && <p className={muted}>{t('gpu.unknown')}</p>}
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
  panel: OfficePanel;
  agentTools: Record<number, ToolActivity[]>;
  /** The phone's panel (T-0052: the terminal's key bar). */
  mobile?: boolean;
  keyboardOpen?: boolean;
}) {
  const now = useNow();
  if (panel === 'terminal')
    return <TerminalWorkspace mobile={mobile} keyboardOpen={keyboardOpen} />;
  if (panel === 'status') return <StatusPanel agentTools={agentTools} now={now} />;
  if (panel === 'files') return <FileExplorer />;
  return <HardwarePanel />;
}

export function UsagePair({
  provider,
  name,
  now,
}: {
  provider: UsageWindow | null | undefined;
  name: string;
  now: number;
}) {
  if (!provider) return <span className={muted}>{t('usage.noInfo', { name })}</span>;
  return (
    <div className="flex flex-wrap gap-x-12 gap-y-4 items-center text-xs min-w-0">
      <strong className="text-accent-text">{name}</strong>
      {(
        [
          ['5h', provider.fiveHourPct, provider.fiveHourReset, provider.fiveHourIsReset],
          ['7d', provider.sevenDayPct, provider.sevenDayReset, provider.sevenDayIsReset],
          ...(provider.models ?? []).map(
            (m) => [modelTag(m.family), m.pct, m.reset ?? null, null] as const,
          ),
        ] as const
      ).map(([window, pct, reset, isReset], i) => (
        <span
          key={window}
          className={`${toneClass[percentTone(pct)]} whitespace-nowrap`}
          title={
            i > 1
              ? t('usage.modelWeekly', {
                  name: modelName(provider.models?.[i - 2]?.family ?? ''),
                  reset: resetCountdown(reset, now),
                })
              : resetCountdown(reset, now)
          }
        >
          {window} {usageWindowText(pct, isReset)}
          {!isReset && <span className="text-text-muted"> · {resetCountdown(reset, now)}</span>}
        </span>
      ))}
    </div>
  );
}

/** Folded usage strip, per viewer (default open). */
const USAGE_FOLDED_KEY = 'cld.usage-folded';
function usageFolded(): boolean | null {
  try {
    const saved = localStorage.getItem(USAGE_FOLDED_KEY);
    return saved === null ? null : saved === '1';
  } catch {
    return null;
  }
}

/** The cld top bar: usage (when office reports it; a provider nobody reports reads
 *  "알 수 없음", never a made-up number) and the host's date and time. It is the top
 *  of the page, so it clears the iPhone safe-area insets. The usage folds to
 *  one line, "Claude 5h 1% · 7d 66%   Codex 5h 73% · 7d 27%"; a phone wraps it
 *  between the providers, on a row of its own above the buttons. */
export function UsageBar() {
  return (
    <Movable id="usage" label={t('usage.bar')} z={49}>
      {/* Three tracks, the sides equal: the clock sits in the bar's exact horizontal centre
          and neither side can run under it (owner 10-24). */}
      <div className="pixel-panel grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-12 gap-y-8 min-w-0 pb-8 pt-[calc(var(--cld-safe-top)+8px)] pl-[calc(var(--cld-safe-left)+12px)] pr-[calc(var(--cld-safe-right)+12px)]">
        <div className="flex min-w-0">
          <UsageLine />
        </div>
        <HostClock />
        <div className="flex flex-wrap items-start justify-end gap-8 min-w-0">
          <FloorPicker />
          <AddDeviceButton />
          <SecurityButton />
          <ActivityLegend />
          <GameOptions />
        </div>
      </div>
    </Movable>
  );
}

/**
 * The usage figures, folded to one line or open (per viewer). The desktop's top bar
 * carries it beside its buttons; the phone shows it alone at the bottom, folded
 * until the viewer opens it (owner 10-24: the usage goes to the bottom space).
 */
export function UsageLine({ foldedByDefault = false }: { foldedByDefault?: boolean }) {
  const { usageState, officeReadOnly, codexUsageChecking } = useCldStore();
  const now = useNow();
  const [folded, setFolded] = useState(() => usageFolded() ?? foldedByDefault);
  const fold = (next: boolean) => {
    setFolded(next);
    try {
      localStorage.setItem(USAGE_FOLDED_KEY, next ? '1' : '0');
    } catch {
      // Private mode: this visit still remembers it.
    }
  };
  if (!usageState) return null;
  return folded ? (
    <button
      type="button"
      className="flex items-center gap-8 flex-[1_1_240px] min-w-0 text-left text-xs pointer-coarse:min-h-44"
      aria-expanded={false}
      title={t('usage.expand')}
      data-testid="usage-folded"
      onClick={() => fold(false)}
    >
      <Chevron open={false} />
      <span className="min-w-0">
        {(
          [
            ['Claude', usageState.claude],
            ['Codex', usageState.codex],
          ] as const
        ).map(([name, provider], i) => (
          // A phone wraps between the providers, never inside one.
          <Fragment key={name}>
            {i > 0 && ' '}
            <span className="whitespace-nowrap mr-12">
              <strong className="text-accent-text">{name}</strong>
              {provider ? (
                foldedFigures(provider).map((f, j) => (
                  <Fragment key={f.text.slice(0, 2)}>
                    {j > 0 && ' ·'} <span className={toneClass[percentTone(f.pct)]}>{f.text}</span>
                  </Fragment>
                ))
              ) : (
                <span className="text-text-muted"> {t('usage.unknown')}</span>
              )}
            </span>
          </Fragment>
        ))}
      </span>
    </button>
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
        <UsagePair provider={usageState.claude} name="Claude" now={now} />
        <div className="flex items-center gap-8">
          <UsagePair provider={usageState.codex} name="Codex" now={now} />
          {!officeReadOnly && (
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
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The phone's top bar (owner 10-24): only the floor, the clock and 설정 stay on top. 기기 추가,
 * 보안 and 범례 moved into 설정 (its first row), two taps away.
 */
export function MobileTopBar() {
  return (
    <div
      className="pixel-panel shrink-0 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-8 min-w-0 pt-[calc(var(--cld-safe-top)+4px)] pl-[calc(var(--cld-safe-left)+8px)] pr-[calc(var(--cld-safe-right)+8px)]"
      data-testid="mobile-top-bar"
    >
      <div className="flex min-w-0">
        <FloorPicker />
      </div>
      <HostClock size="text-sm" />
      {/* 44×44 for the thumb; the bar has no bottom padding, so it is no taller than before. */}
      <div className="flex justify-end [&>button]:min-h-44 [&>button]:min-w-44 [&>button]:justify-center">
        <GameOptions
          quick={
            <>
              <AddDeviceButton zIndex={62} />
              <SecurityButton />
              <ActivityLegend zIndex={62} />
            </>
          }
        />
      </div>
    </div>
  );
}
