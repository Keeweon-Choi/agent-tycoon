/**
 * P4 개발실, the 터미널 tab (DEVROOM-SUBVIEW, owner 11-03 10:51): the project's agents on one board.
 * Desktop: a strip of agent cards grouped by status (나를 기다림 first, Orca's Agent Dashboard)
 * over 1 · 2 · 2×2 panes like the messenger's; each pane is one agent's live terminal (the
 * PTY-host socket and input path of the 터미널 window) under a header that says who, where, what
 * state, since when, how tired and how much is unread. Phone: the cards, then one agent's
 * terminal full screen. Sub-agents are a `서브 n` chip whose list opens one transcript in the pane
 * (SubTranscript.tsx). Only the terminals on screen are attached, only while the tab is.
 */
import { useContext, useEffect, useRef, useState } from 'react';

import { CHAT_WS_PREFIX } from '../../../../core/src/constants.js';
import type { RepoWorktree } from '../../../../core/src/messages.js';
import { MobileKeyBar } from '../../components/MobileKeyBar.js';
import { submitTerminalLine } from '../../components/mobileSend.js';
import { type TerminalInputHandle, TerminalPane } from '../../components/TerminalPane.js';
import { Button } from '../../components/ui/Button.js';
import {
  DEVROOM_BOARD_TICK_MS,
  DEVROOM_CARD_W_PX,
  DEVROOM_DONE_MS,
  DEVROOM_DROP_EDGE,
  DEVROOM_JUST_NOW_MS,
  DEVROOM_PANE_MIN_PX,
  MOBILE_TERMINAL_FONT_SIZE_PX,
} from '../../constants.js';
import { t } from '../../i18n/index.js';
import { readClipboardText } from '../../terminal/clipboard.js';
import { FatigueBar } from '../ez/Fatigue.js';
import { openJobs } from '../game/openJobs.js';
import { PixelIcon } from '../game/parts.js';
import { Icon } from '../icons/Icon.js';
import { elapsedDuration } from '../kinds.js';
import { type LeadState, leadState, unreadCount, useMessenger } from '../messenger/messengerStore.js';
import { DOT, Mug } from '../messenger/parts.js';
import { fatigueFor, useAgtyStore } from '../officeStore.js';
import { setRunsProject } from '../panels/runsFilter.js';
import { useRepoStore } from '../repo/repoStore.js';
import { terminalMessages } from '../terminal/workspace.js';
import { WaitMark } from '../WaitMark.js';
import { type Bucket, bucketOf, BUCKETS, inStateSince, waitsOnPerson } from './agentBoard.js';
import { BODY, DevroomLooks, DevroomTools, SMALL, useSubs, useTerminalColumns } from './devroomData.js';
import type { AgentColumn, SubColumn } from './devroomState.js';
import { type AgentPick, useDevroom } from './devroomStore.js';
import { PaneChat, PanePermission } from './PaneChat.js';
import {
  closeAt,
  drop,
  fillTree,
  isLeaf,
  leaves,
  loadTree,
  PANE_VIEWS,
  type PaneNode,
  type PaneView,
  type Path,
  pathKey,
  preset,
  RATIO_MIN,
  resize,
  saveTree,
  setView,
  showAt,
  viewOf,
  type Zone,
} from './paneTree.js';
import { takeSeated } from './seatStore.js';
import { lineText, type SubRow } from './subagents.js';
import { SubChip, SubList, SubTranscript } from './SubTranscript.js';

const socketOf = (bgId: string) => `${CHAT_WS_PREFIX}/${bgId}`;
const NO_LOOK = { palette: 0, hueShift: 0 };

/** One agent on the board. */
interface BoardAgent {
  col: AgentColumn;
  state: LeadState;
  bucket: Bucket;
  unread: number;
  /** Its last message (the messenger's preview). */
  preview: string;
  /** What it does right now, in one line. */
  action: string | null;
  branch: string | null;
  subs: SubRow[];
  since: number;
}

/** A clock for the elapsed times: ticks only while the board is on screen. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), DEVROOM_BOARD_TICK_MS);
    return () => window.clearInterval(timer);
  }, [on]);
  return now;
}

/** Every agent of the board with its state, in status order (needs-you first). */
function useBoard(project: string, cols: readonly AgentColumn[], live: readonly SubColumn[], now: number): BoardAgent[] {
  const store = useAgtyStore();
  const m = useMessenger();
  const looks = useContext(DevroomLooks);
  const { agentTools } = useContext(DevroomTools);
  const repo = useRepoStore().states[project];
  const subs = useSubs(cols, live);
  const orchs = store.officeSnapshot?.orchestrators ?? [];
  const agents = cols.map((col): BoardAgent => {
    const id = col.agentId;
    const contact = m.contacts.find((c) => (id !== null && c.agentId === id) || c.name === col.name);
    const row = orchs.find((o) => o.name === col.name);
    const state: LeadState =
      col.kind === 'off' ? 'off' : leadState(row, id === null ? null : (looks?.statusFor(id) ?? null), waitsOnPerson(contact));
    const unread = contact ? unreadCount(contact.replies, m.read[contact.name]) : 0;
    // Since when it is in this state; after a turn, since its last news (the transcript's newest item).
    const settled = inStateSince(id ?? -1, state, now);
    const news = state === 'resting' || state === 'off' ? (contact?.lastAt ?? settled) : settled;
    const bucket = bucketOf(state, now - news, DEVROOM_DONE_MS);
    const doing = id === null ? undefined : agentTools[id]?.filter((x) => !x.done).at(-1);
    const wt = repo?.ok ? repo.worktrees?.find((w) => w.assignee === col.name) : undefined;
    return {
      col,
      state,
      bucket,
      unread,
      preview: contact?.preview ?? '',
      action: doing ? lineText(doing) : null,
      branch: wt?.branch ?? (repo?.ok ? (repo.branch ?? null) : null),
      subs: id === null ? [] : subs.filter((s) => s.agentId === id),
      since: news,
    };
  });
  return BUCKETS.flatMap((b) => agents.filter((a) => a.bucket === b));
}

/** Why a column has no terminal, in one line (the dimmed 터미널 side's title too). */
const noTerminalWhy = (col: AgentColumn): string =>
  col.kind === 'none' ? t('agentCaps.noTerminal') : t(`devroom.term.${col.kind === 'live' ? 'off' : col.kind}`);

/** A column without a terminal says why; an agent that works in runs links them in the 현황판's 실행
 *  tab, any other (an ACP agent) its 대화. */
function NoTerminal({ col, project, onChat }: { col: AgentColumn; project: string; onChat: () => void }) {
  return (
    <div className={`p-12 flex flex-col items-start gap-8 text-text-muted ${SMALL}`} data-testid="devroom-term-none">
      <p>{noTerminalWhy(col)}</p>
      {col.kind === 'none' && !col.runs && (
        <Button size="sm" data-testid="devroom-term-chat" onClick={onChat}>
          {t('devroom.term.chatLink')}
        </Button>
      )}
      {col.kind === 'none' && col.runs && (
        <Button
          size="sm"
          onClick={() => {
            openJobs();
            setRunsProject(project);
          }}
        >
          {t('devroom.term.codexLink')}
        </Button>
      )}
    </div>
  );
}

function Face({ agent }: { agent: BoardAgent }) {
  const looks = useContext(DevroomLooks);
  const id = agent.col.agentId;
  return <Mug agentId={id ?? -1} getAppearance={(x) => (x >= 0 && looks ? looks.getAppearance(x) : NO_LOOK)} />;
}

const stateWord = (a: BoardAgent): string => t(`devroom.board.bucket.${a.bucket}`);

function StateMark({ agent, now }: { agent: BoardAgent; now: number }) {
  return (
    <span className={`shrink-0 flex items-center gap-4 ${SMALL}`} data-testid="devroom-agent-state" data-bucket={agent.bucket}>
      <span className={`inline-block size-8 ${DOT[agent.state]}`} />
      <span className={agent.bucket === 'needs' ? 'text-status-permission' : 'text-text'}>{stateWord(agent)}</span>
      <WaitMark agentId={agent.col.agentId} />
      <span className="text-text-muted">· {(agent.bucket === 'done' || agent.bucket === 'idle') && now - agent.since < DEVROOM_JUST_NOW_MS ? t('devroom.board.justNow') : elapsedDuration(now - agent.since)}</span>
    </span>
  );
}

function Unread({ n }: { n: number }) {
  if (!n) return null;
  return (
    <span className={`shrink-0 px-4 bg-accent text-white ${SMALL}`} title={t('devroom.board.unread', { n })} data-testid="devroom-unread">
      {n}
    </span>
  );
}

/** One card of the strip (or the phone's list): face, name, state, its sub-agents, what it does or last said. */
function Card({
  agent,
  shown,
  onPick,
  onSubs,
  onDrag,
  wide,
}: {
  agent: BoardAgent;
  shown?: boolean;
  onPick: () => void;
  onSubs: () => void;
  /** Desktop: a card dragged onto a pane's edge splits it there. */
  onDrag?: (e: React.DragEvent) => void;
  wide?: boolean;
}) {
  const line = agent.action ? `❯ ${agent.action}` : agent.preview;
  return (
    <div
      role="button"
      tabIndex={0}
      className={`shrink-0 flex items-center gap-8 px-8 py-6 border-2 cursor-pointer min-w-0 ${shown ? 'bg-active-bg border-accent' : 'bg-btn-bg border-border hover:bg-btn-hover'} ${agent.bucket === 'needs' ? 'border-l-status-permission' : ''}`}
      style={wide ? undefined : { width: DEVROOM_CARD_W_PX }}
      data-testid="devroom-agent-card"
      data-agent={agent.col.name}
      data-bucket={agent.bucket}
      draggable={!!onDrag}
      onDragStart={onDrag}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onPick();
      }}
    >
      <Face agent={agent} />
      <span className="flex-1 min-w-0 flex flex-col gap-2">
        <span className="flex items-center gap-6 min-w-0">
          <strong className={`min-w-0 truncate ${BODY}`}>{agent.col.name}</strong>
          <span className={`inline-block size-8 shrink-0 ${DOT[agent.state]}`} />
          <WaitMark agentId={agent.col.agentId} />
          <Unread n={agent.unread} />
          <span className="flex-1" />
          <SubChip subs={agent.subs} onClick={onSubs} />
        </span>
        <span className={`block truncate text-text-muted ${SMALL} ${agent.action ? 'font-transcript' : ''}`} title={line}>
          {line || stateWord(agent)}
        </span>
      </span>
    </div>
  );
}

const BUCKET_DOT: Record<Bucket, string> = { needs: DOT.waiting, working: DOT.working, done: DOT.resting, idle: DOT.off };

/** D1's status chips: `나를 기다림 n · 일하는 중 n · 끝남 n · 쉬는 중 n · 보기` (stateGroup's reading, empty ones left out). */
function StatusChips({ agents, open, onOpen }: { agents: readonly BoardAgent[]; open: Bucket | null; onOpen: (b: Bucket) => void }) {
  return (
    <div className="min-w-0 flex items-center gap-6 overflow-x-auto" role="group" aria-label={t('devroom.pane.chips')} data-testid="devroom-status-chips">
      {BUCKETS.map((b) => {
        const n = agents.filter((a) => a.bucket === b).length;
        if (!n) return null;
        return (
          <button
            key={b}
            type="button"
            className={`ui-tab shrink-0 ${SMALL} ${open === b ? 'ui-on' : ''}`}
            aria-expanded={open === b}
            data-testid="devroom-status-chip"
            data-bucket={b}
            onClick={() => onOpen(b)}
          >
            <span className={`inline-block size-8 rounded-ui-pill ${BUCKET_DOT[b]}`} aria-hidden="true" />
            <span className={b === 'needs' ? 'text-status-permission' : undefined}>
              {t(`devroom.board.bucket.${b}`)} {n}
            </span>
            {b === 'idle' && <span className="text-text-muted">· {t('devroom.board.showIdle')}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** The cards in status groups: 나를 기다림, 일하는 중, 끝남, 쉬는 중 (empty groups left out). */
function Groups({
  agents,
  shown,
  onPick,
  onSubs,
  onDrag,
  phone,
  idleOpen = false,
}: {
  agents: readonly BoardAgent[];
  shown: readonly (string | null)[];
  onPick: (name: string) => void;
  onSubs: (name: string) => void;
  onDrag?: (e: React.DragEvent, name: string) => void;
  phone?: boolean;
  /** 쉬는 중 starts unfolded (its status chip's `보기` opened the list). */
  idleOpen?: boolean;
}) {
  // Orca's Idle column: 쉬는 중 is folded until asked for (this view only).
  const [showIdle, setShowIdle] = useState(idleOpen);
  return (
    <div
      className={phone ? 'flex flex-col gap-12 p-10' : 'flex flex-wrap gap-14 px-10 py-8'}
      data-testid="devroom-agent-strip"
    >
      {BUCKETS.map((b) => {
        const list = agents.filter((a) => a.bucket === b);
        if (!list.length) return null;
        const folded = b === 'idle' && !showIdle;
        return (
          <section key={b} className="shrink-0 flex flex-col gap-4 min-w-0" data-testid="devroom-agent-group" data-bucket={b}>
            <p className={`flex items-center gap-6 ${SMALL} ${b === 'needs' ? 'text-status-permission' : 'text-text-muted'}`}>
              {t(`devroom.board.bucket.${b}`)} {list.length}
              {b === 'idle' && (
                <button
                  type="button"
                  className="px-6 border-2 border-border bg-btn-bg hover:bg-btn-hover text-text pointer-coarse:min-h-36"
                  aria-expanded={!folded}
                  data-testid="devroom-show-idle"
                  onClick={() => setShowIdle(!showIdle)}
                >
                  {t(folded ? 'devroom.board.showIdle' : 'devroom.board.hideIdle', { n: list.length })}
                </button>
              )}
            </p>
            {!folded && (
            <div className={phone ? 'flex flex-col gap-6' : 'flex gap-6'}>
              {list.map((a) => (
                <Card
                  key={a.col.name}
                  agent={a}
                  wide={phone}
                  shown={shown.includes(a.col.name)}
                  onPick={() => onPick(a.col.name)}
                  onSubs={() => onSubs(a.col.name)}
                  onDrag={onDrag && ((e) => onDrag(e, a.col.name))}
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

/** The pane head's `대화 | 터미널` (D1). An agent without a terminal has that side dimmed; pressed, it says why. */
function ViewSwitch({ agent, view, onView, wide }: { agent: BoardAgent; view: PaneView; onView: (v: PaneView) => void; wide?: boolean }) {
  const live = agent.col.kind === 'live';
  return (
    <div
      className={`ui-subtabs shrink-0 ${wide ? 'w-full' : ''}`}
      role="tablist"
      aria-label={t('devroom.pane.views')}
      data-testid="devroom-pane-views"
    >
      {PANE_VIEWS.map((v) => {
        const dim = v === 'terminal' && !live;
        return (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            aria-disabled={dim || undefined}
            title={dim ? noTerminalWhy(agent.col) : undefined}
            className={`ui-tab ${SMALL} ${wide ? 'flex-1 justify-center' : ''} aria-disabled:opacity-(--btn-disabled-opacity)`}
            data-testid="devroom-pane-view"
            data-view={v}
            onClick={() => onView(v)}
          >
            {v === 'chat' ? <Icon name="message-square-text" size={14} pixel={null} /> : <PixelIcon name="term" size={12} />}
            {/* A narrow pane keeps the icons (the picker needs the room); the name stays for screen readers. */}
            <span className={wide ? undefined : '@max-[480px]:sr-only'}>{t(`devroom.pane.view.${v}`)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A pane's body: the picked sub-agent's transcript; else in 대화 the agent's conversation, in 터미널 its
 *  terminal (or why it has none) with its permission card over it. */
function PaneBody({
  agent,
  project,
  on,
  now,
  view,
  onView,
  sub,
  onSubBack,
  phone,
  onInput,
}: {
  agent: BoardAgent;
  project: string;
  on: boolean;
  now: number;
  view: PaneView;
  onView: (v: PaneView) => void;
  sub: string | null;
  onSubBack: () => void;
  phone?: boolean;
  onInput?: (handle: TerminalInputHandle | null) => void;
}) {
  const picked = sub ? agent.subs.find((s) => s.key === sub) : undefined;
  if (picked) return <SubTranscript sub={picked} on={on} now={now} onBack={onSubBack} />;
  const col = agent.col;
  if (view === 'chat')
    return <PaneChat agentId={col.agentId} project={project} on={on} onTerminal={col.kind === 'live' ? () => onView('terminal') : null} />;
  const card = <PanePermission agentId={col.agentId} name={col.name} />;
  if (col.kind !== 'live')
    return (
      <>
        <NoTerminal col={col} project={project} onChat={() => onView('chat')} />
        {card}
      </>
    );
  if (!on) return null;
  return (
    <div className={`relative flex-1 min-h-0 ${phone ? 'p-4' : 'px-8 py-6'}`}>
      {card}
      <TerminalPane
        agentId={col.agentId ?? -1}
        socketPath={socketOf(col.bgId)}
        isActive
        autoFocus={false}
        messages={terminalMessages()}
        {...(phone && {
          mobileKeyBar: true,
          fontSizePx: MOBILE_TERMINAL_FONT_SIZE_PX,
          onRegisterInput: (_: number, handle: TerminalInputHandle | null) => onInput?.(handle),
        })}
      />
    </div>
  );
}

/** The sub-agent list a chip opened, over the pane's body. */
function SubsOverlay({ agent, now, onPick, onClose }: { agent: BoardAgent; now: number; onPick: (key: string) => void; onClose: () => void }) {
  return (
    <>
      <div className="absolute inset-0 z-10" aria-hidden="true" onClick={onClose} />
      <div className="absolute left-8 right-8 top-0 z-20 max-h-full overflow-y-auto bg-devroom-menu border-2 border-devroom-main-line shadow-pixel">
        <p className={`px-10 py-6 border-b-2 border-border text-text-muted ${SMALL}`}>
          {t('devroom.sub.title', { name: agent.col.name, n: agent.subs.length })}
        </p>
        <SubList subs={agent.subs} now={now} onPick={onPick} />
      </div>
    </>
  );
}

const DRAG_TYPE = 'application/x-devroom-agent';
const dragging = (e: React.DragEvent) => e.dataTransfer.types.includes(DRAG_TYPE);
const startDrag = (e: React.DragEvent, name: string) => {
  e.dataTransfer.setData(DRAG_TYPE, name);
  e.dataTransfer.effectAllowed = 'move';
};

/** Where in a pane a drag is: an edge (a quarter of the way in) splits, the middle replaces. */
function zoneAt(e: React.DragEvent, el: HTMLElement): Zone {
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  const d = Math.min(x, 1 - x, y, 1 - y);
  if (d > DEVROOM_DROP_EDGE) return 'center';
  return d === x ? 'left' : d === 1 - x ? 'right' : d === y ? 'top' : 'bottom';
}

/** The drop preview: the half the new pane will take, or the whole pane. */
const ZONE_BOX: Record<Zone, string> = {
  left: 'left-0 top-0 bottom-0 w-1/2',
  right: 'right-0 top-0 bottom-0 w-1/2',
  top: 'left-0 right-0 top-0 h-1/2',
  bottom: 'left-0 right-0 bottom-0 h-1/2',
  center: 'inset-0',
};

/** One pane: the header (face, name, branch, state and since when, fatigue, unread, 서브 n, the
 *  agent picker; dragged, it moves the pane), then its terminal or a sub-agent's transcript.
 *  A card or another pane's header dropped on an edge splits it there, in the middle replaces it. */
function Pane({
  agent,
  agents,
  project,
  on,
  now,
  focused,
  subsOpen,
  onFocus,
  onShow,
  onSubs,
  onDrop,
  onClose,
  sub,
  onSub,
  view,
  onView,
}: {
  agent: BoardAgent | null;
  agents: readonly BoardAgent[];
  project: string;
  on: boolean;
  now: number;
  focused: boolean;
  subsOpen: boolean;
  onFocus: () => void;
  onShow: (name: string) => void;
  onSubs: (open: boolean) => void;
  onDrop: (zone: Zone, name: string) => void;
  onClose?: () => void;
  /** The sub-agent it shows instead of the terminal (kept by the board: a new layout keeps it). */
  sub: string | null;
  onSub: (key: string | null) => void;
  view: PaneView;
  onView: (v: PaneView) => void;
}) {
  const store = useAgtyStore();
  const [zone, setZone] = useState<Zone | null>(null);
  const fatigue = agent?.col.agentId != null ? fatigueFor(agent.col.agentId, store) : null;
  return (
    <section
      className={`@container relative flex-1 min-w-0 min-h-0 flex flex-col bg-bg-dark border-2 ${focused ? 'border-accent' : 'border-border'}`}
      data-testid="devroom-pane"
      data-agent={agent?.col.name}
      data-agent-id={agent?.col.agentId ?? undefined}
      data-view={view}
      data-focused={focused || undefined}
      tabIndex={-1}
      onPointerDownCapture={onFocus}
      // DV3 Alt+1..6 and the palette focus a pane by key: the board follows as it does a click.
      onFocusCapture={onFocus}
      onDragOver={(e) => {
        if (!dragging(e)) return;
        e.preventDefault();
        setZone(zoneAt(e, e.currentTarget));
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setZone(null);
      }}
      onDrop={(e) => {
        const name = e.dataTransfer.getData(DRAG_TYPE);
        const z = zoneAt(e, e.currentTarget);
        setZone(null);
        if (!name) return;
        e.preventDefault();
        onDrop(z, name);
      }}
    >
      <header
        className="shrink-0 flex items-center gap-8 px-8 py-4 bg-bg border-b-2 border-border min-w-0 cursor-grab"
        draggable={!!agent}
        title={t('devroom.board.dragPane')}
        data-testid="devroom-pane-head"
        onDragStart={(e) => agent && startDrag(e, agent.col.name)}
      >
        {agent && <Face agent={agent} />}
        <span className="flex-1 min-w-0 flex flex-col gap-2">
          <span className="flex items-center gap-8 min-w-0">
            <select
              className={`min-w-80 max-w-[60%] bg-bg text-text border-2 border-border ${BODY} font-bold`}
              aria-label={t('devroom.board.pick')}
              data-testid="devroom-pane-pick"
              value={agent?.col.name ?? ''}
              onChange={(e) => onShow(e.target.value)}
            >
              {!agent && <option value="">{t('devroom.board.none')}</option>}
              {agents.map((a) => (
                <option key={a.col.name} value={a.col.name}>
                  {a.col.name}
                </option>
              ))}
            </select>
            {agent && <StateMark agent={agent} now={now} />}
            {agent && <Unread n={agent.unread} />}
          </span>
          {agent && (
            <span className={`flex items-center gap-8 min-w-0 text-text-muted ${SMALL}`}>
              {agent.branch && (
                <span className="min-w-0 truncate font-transcript" title={agent.branch} data-testid="devroom-pane-branch">
                  ⎇ {agent.branch}
                </span>
              )}
              {fatigue && <FatigueBar look={fatigue} />}
            </span>
          )}
        </span>
        {agent && <SubChip subs={agent.subs} open={subsOpen} onClick={() => onSubs(!subsOpen)} />}
        {agent && <ViewSwitch agent={agent} view={view} onView={onView} />}
        {onClose && (
          <Button size="icon_md" aria-label={t('devroom.board.closePane')} title={t('devroom.board.closePane')} onClick={onClose}>
            ×
          </Button>
        )}
      </header>
      <div className="relative flex-1 min-h-0 flex flex-col">
        {agent ? (
          <PaneBody agent={agent} project={project} on={on} now={now} view={view} onView={onView} sub={sub} onSubBack={() => onSub(null)} />
        ) : (
          <p className={`m-auto p-12 text-center text-text-muted ${BODY}`}>{t('devroom.board.empty')}</p>
        )}
        {agent && subsOpen && (
          <SubsOverlay
            agent={agent}
            now={now}
            onClose={() => onSubs(false)}
            onPick={(key) => {
              onSub(key);
              onSubs(false);
            }}
          />
        )}
      </div>
      {zone && (
        <div
          className={`absolute z-30 pointer-events-none border-2 border-accent bg-devroom-review-bg ${ZONE_BOX[zone]}`}
          data-testid="devroom-drop-zone"
          data-zone={zone}
        />
      )}
    </section>
  );
}

/** A split: its two sides and the bar between them, dragged to resize (never under the minimum). */
function Split({
  node,
  path,
  onResize,
  children,
}: {
  node: Extract<PaneNode, { dir: string }>;
  path: Path;
  onResize: (path: Path, ratio: number, min: number) => void;
  children: [React.ReactNode, React.ReactNode];
}) {
  const box = useRef<HTMLDivElement>(null);
  const row = node.dir === 'row';
  return (
    <div ref={box} className={`flex-1 min-w-0 min-h-0 flex ${row ? 'flex-row' : 'flex-col'}`} data-testid="devroom-split" data-dir={node.dir}>
      <div className="min-w-0 min-h-0 flex" style={{ flexBasis: `${node.ratio * 100}%`, flexGrow: 0, flexShrink: 0 }}>
        {children[0]}
      </div>
      <div
        role="separator"
        aria-orientation={row ? 'vertical' : 'horizontal'}
        className={`shrink-0 bg-border hover:bg-accent ${row ? 'w-6 cursor-col-resize' : 'h-6 cursor-row-resize'}`}
        data-testid="devroom-divider"
        onPointerDown={(e) => {
          const el = box.current;
          if (!el) return;
          e.preventDefault();
          const r = el.getBoundingClientRect();
          const size = row ? r.width : r.height;
          const move = (ev: PointerEvent) =>
            onResize(path, ((row ? ev.clientX - r.left : ev.clientY - r.top) / size), DEVROOM_PANE_MIN_PX / size);
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }}
      />
      <div className="flex-1 min-w-0 min-h-0 flex">{children[1]}</div>
    </div>
  );
}

/** Desktop: the status strip over the free panes (one board per project). */
export function TerminalColumns(props: {
  project: string;
  cols: readonly AgentColumn[];
  subs: readonly SubColumn[];
  /** The rail's pick: its agent comes into the focused pane. */
  focus: string | null;
  /** DEVROOM-SIDEBAR: the agent row clicked (focus is its agent): its sub-agent's transcript, or none. */
  want?: AgentPick | null;
  /** The tab is on screen: only then do the terminals attach and the clock tick. */
  on: boolean;
}) {
  return <Board key={props.project} {...props} />;
}

function Board({
  project,
  cols,
  subs,
  focus,
  want = null,
  on,
}: {
  project: string;
  cols: readonly AgentColumn[];
  subs: readonly SubColumn[];
  focus: string | null;
  want?: AgentPick | null;
  on: boolean;
}) {
  const now = useNow(on);
  const agents = useBoard(project, cols, subs, now);
  const [stored, setStored] = useState<PaneNode>(() => loadTree(project) ?? preset(1, []));
  const [focusKey, setFocusKey] = useState('root');
  const [subsOpen, setSubsOpen] = useState<string | null>(null);
  const [subOf, setSubOf] = useState<Record<string, string | null>>({});
  // The status chip whose cards are open (any opens them all, its own group unfolded), and a card's drag.
  const [strip, setStrip] = useState<Bucket | null>(null);
  const [dragging, setDragging] = useState(false);
  const closeStrip = () => {
    setStrip(null);
    setDragging(false);
  };
  const order = agents.map((a) => a.col.name);
  const tree = fillTree(stored, order);
  const panes = leaves(tree);
  const focused = panes.find((l) => pathKey(l.path) === focusKey) ?? panes[0];
  useEffect(() => saveTree(project, stored), [project, stored]);
  const show = (name: string) => {
    const there = panes.find((l) => l.name === name);
    if (there) setFocusKey(pathKey(there.path));
    else setStored(showAt(tree, focused.path, name));
  };
  const openSub = (name: string, key: string | null) => setSubOf((m) => ({ ...m, [name]: key }));
  /** `name`'s pane, shown and switched to `view`. */
  const showView = (name: string, view: PaneView) => {
    const shown = panes.some((l) => l.name === name) ? tree : showAt(tree, focused.path, name);
    const leaf = leaves(shown).find((l) => l.name === name);
    if (!leaf) return;
    setStored(setView(shown, leaf.path, view));
    setFocusKey(pathKey(leaf.path));
  };
  // The rail's pick shows its agent (once per pick, never against the owner's own choice after).
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!focus || !order.includes(focus)) return;
    // T-70: an agent the owner just seated opens on its 터미널 (it is starting there; seatStore.ts),
    // one with no terminal of ours (a run per message, still `claude --bg`) in 대화.
    const seated = takeSeated(focus);
    // An agent row clicked again shows it again (its stamp changed).
    const stamp = `${focus}\0${want?.at ?? ''}`;
    if (!seated && stamp === last.current) return;
    last.current = stamp;
    const kind = agents.find((a) => a.col.name === focus)?.col.kind;
    if (seated) showView(focus, kind === 'none' || kind === 'old' ? 'chat' : 'terminal');
    else show(focus);
    if (want) openSub(focus, want.sub);
  });
  if (!cols.length) return <p className={`m-auto text-text-muted ${BODY}`}>{t('devroom.term.nobody')}</p>;
  const byName = (name: string | null) => agents.find((a) => a.col.name === name) ?? null;
  const render = (node: PaneNode, path: Path): React.ReactNode => {
    if (!isLeaf(node)) {
      return (
        <Split node={node} path={path} onResize={(p, ratio, min) => setStored(resize(tree, p, ratio, Math.max(min, RATIO_MIN)))}>
          {[render(node.a, [...path, 'a']), render(node.b, [...path, 'b'])]}
        </Split>
      );
    }
    const name = node.leaf;
    const key = pathKey(path);
    return (
      <Pane
        key={name ?? key}
        agent={byName(name)}
        agents={agents}
        project={project}
        on={on}
        now={now}
        focused={panes.length > 1 && pathKey(focused.path) === key}
        subsOpen={!!name && subsOpen === name}
        onFocus={() => setFocusKey(key)}
        onShow={(n) => setStored(showAt(tree, path, n))}
        onSubs={(open) => setSubsOpen(open ? name : null)}
        onDrop={(zone, n) => {
          const next = drop(tree, path, zone, n);
          setStored(next);
          const at = leaves(next).find((l) => l.name === n);
          if (at) setFocusKey(pathKey(at.path));
        }}
        onClose={panes.length > 1 ? () => setStored(closeAt(tree, path)) : undefined}
        sub={name ? (subOf[name] ?? null) : null}
        onSub={(k) => name && setSubOf({ ...subOf, [name]: k })}
        view={viewOf(node)}
        onView={(v) => {
          setStored(setView(tree, path, v));
          // A sub-agent's transcript gives the pane back to the view the owner asked for.
          if (name) setSubOf({ ...subOf, [name]: null });
        }}
      />
    );
  };
  const quick = (n: 1 | 2 | 4) => {
    const first = focused.name;
    const fresh = preset(n, [first, ...order.filter((x) => x !== first)]);
    // Each agent keeps the view it had (a 터미널 stays a 터미널).
    const views = new Map(panes.map((l) => [l.name, l.view]));
    setStored(leaves(fresh).reduce((t, l) => setView(t, l.path, views.get(l.name) ?? 'chat'), fresh));
    setFocusKey('root');
  };
  return (
    <div
      className="relative flex-1 min-h-0 flex flex-col"
      data-testid="devroom-terminals"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && strip) closeStrip();
      }}
    >
      {/* D1: one row, the status chips (each opens the agent cards) left, the layouts right. */}
      <div className="relative z-30 shrink-0 flex items-center gap-8 px-10 py-4 bg-bg border-b-ui border-border min-w-0">
        <StatusChips agents={agents} open={strip} onOpen={(b) => setStrip(b === strip ? null : b)} />
        <div className="ml-auto shrink-0 flex items-center gap-4" role="group" aria-label={t('devroom.board.layout')}>
          {([1, 2, 4] as const).map((n) => (
            <Button key={n} size="sm" aria-pressed={panes.length === n || (n === 4 && panes.length > 2)} data-testid={`devroom-layout-${n}`} onClick={() => quick(n)}>
              {t(`msgSplit.layout${n}`)}
            </Button>
          ))}
        </div>
        <p className={`shrink min-w-0 truncate text-text-muted ${SMALL}`} title={t('devroom.board.dragHint')}>
          {t('devroom.board.dragHint')}
        </p>
      </div>
      {strip && (
        <>
          <div className={`absolute inset-0 z-20 ${dragging ? 'pointer-events-none' : ''}`} aria-hidden="true" onClick={closeStrip} />
          <div className="relative h-0 z-30">
            {/* While a card is dragged the list steps aside (kept, not removed: the drag would end). */}
            <div
              className={`absolute left-8 right-8 top-4 max-h-320 overflow-y-auto bg-devroom-menu border-ui border-devroom-main-line rounded-ui-card shadow-pixel ${dragging ? 'opacity-0 pointer-events-none' : ''}`}
              data-testid="devroom-strip"
              onDragEnd={closeStrip}
            >
              <Groups
                agents={agents}
                shown={panes.map((l) => l.name)}
                idleOpen={strip === 'idle'}
                onPick={(name) => {
                  closeStrip();
                  show(name);
                }}
                onDrag={(e, name) => {
                  startDrag(e, name);
                  window.setTimeout(() => setDragging(true));
                }}
                onSubs={(name) => {
                  closeStrip();
                  show(name);
                  setSubsOpen(name);
                }}
              />
            </div>
          </div>
        </>
      )}
      <div className="flex-1 min-h-0 flex p-2 bg-border" data-testid="devroom-panes">
        {render(tree, [])}
      </div>
    </div>
  );
}

/** Phone: the cards in status groups; one tapped (or the pick's agent) fills the screen. */
export function PhoneTerminal({
  project,
  wt,
  on,
  keyboardOpen,
}: {
  project: string;
  wt: RepoWorktree | null;
  on: boolean;
  keyboardOpen: boolean;
}) {
  const { cols, subs, focus } = useTerminalColumns(project, wt);
  const now = useNow(on);
  const agents = useBoard(project, cols, subs, now);
  // DEVROOM-SIDEBAR: a tapped agent row opens on that agent (a sub-agent: its transcript).
  const { agent: tapped } = useDevroom();
  const want = tapped?.project === project ? tapped : null;
  const [chosen, setChosen] = useState<string | null>(want?.name ?? focus);
  const [subsOpen, setSubsOpen] = useState(false);
  const [sub, setSub] = useState<string | null>(want?.sub ?? null);
  // P1: an agent opens in 대화 (its terminal one tap away).
  const [view, setView] = useState<PaneView>('chat');
  const input = useRef<TerminalInputHandle | null>(null);
  const agent = agents.find((a) => a.col.name === chosen);
  const pick = (name: string | null, list = false) => {
    setChosen(name);
    setSub(null);
    setSubsOpen(list);
  };
  const showView = (v: PaneView) => {
    setView(v);
    setSub(null);
    setSubsOpen(false);
  };
  if (!cols.length) return <p className={`m-auto text-text-muted ${BODY}`}>{t('devroom.term.nobody')}</p>;
  if (!agent)
    return (
      <div className="flex-1 min-h-0 overflow-y-auto bg-bg-dark" data-testid="devroom-phone-term">
        <Groups agents={agents} shown={[]} phone onPick={(n) => pick(n)} onSubs={(n) => pick(n, true)} />
      </div>
    );
  return (
    <div className="flex-1 min-h-0 flex flex-col bg-bg-dark" data-testid="devroom-phone-term" data-agent={agent.col.name}>
      <div className="shrink-0 flex items-center gap-8 px-8 py-4 bg-bg border-b-2 border-border min-w-0">
        <Button size="sm" className="text-2xs" data-testid="devroom-phone-all" onClick={() => pick(null)}>
          {t('devroom.board.all')}
        </Button>
        <Face agent={agent} />
        <span className="flex-1 min-w-0 flex flex-col gap-2">
          <strong className={`truncate ${BODY}`}>{agent.col.name}</strong>
          <StateMark agent={agent} now={now} />
        </span>
        <Unread n={agent.unread} />
        <SubChip subs={agent.subs} open={subsOpen} onClick={() => setSubsOpen(!subsOpen)} />
      </div>
      <div className="shrink-0 px-8 py-4 bg-bg border-b-ui border-border">
        <ViewSwitch agent={agent} view={view} onView={showView} wide />
      </div>
      <div className="relative flex-1 min-h-0 flex flex-col">
        {subsOpen ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <p className={`px-10 py-6 border-b-2 border-border text-text-muted ${SMALL}`}>
              {t('devroom.sub.title', { name: agent.col.name, n: agent.subs.length })}
            </p>
            <SubList
              subs={agent.subs}
              now={now}
              onPick={(key) => {
                setSub(key);
                setSubsOpen(false);
              }}
            />
          </div>
        ) : (
          <PaneBody
            agent={agent}
            project={project}
            on={on}
            now={now}
            view={view}
            onView={showView}
            sub={sub}
            onSubBack={() => setSub(null)}
            phone
            onInput={(handle) => {
              input.current = handle;
            }}
          />
        )}
      </div>
      {on && keyboardOpen && view === 'terminal' && !sub && !subsOpen && agent.col.kind === 'live' && (
        <MobileKeyBar
          onKey={(seq) => input.current?.send(seq)}
          onPaste={() => {
            void readClipboardText(t('upstream.paste')).then((text) => {
              if (text) input.current?.paste(text);
            });
          }}
          onSend={() => {
            if (input.current) submitTerminalLine(input.current);
          }}
        />
      )}
    </div>
  );
}
