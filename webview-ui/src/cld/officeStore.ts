import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';

import type {
  AgentCliState,
  CharacterPack,
  CharacterPart,
  CharacterPresets,
  CodexTasks,
  DiskUsage,
  EzRules,
  FolderList,
  GpuBoard,
  HostInfo,
  HwSample,
  OfficeEvent,
  OfficeJobs,
  OfficeLevel,
  OfficeSnapshot,
  PersonPreset,
  ServerMessage,
  StatusOutput,
  TaskBoard,
  TempEmployee,
  TrackedItems,
  UsageState,
} from '../../../core/src/messages.js';
import { FX_LEVELUP_LIVE, FX_REBIRTH_LIVE, OWNER_CHARACTER_ID, REST_SETTLE_MS } from '../constants.js';
import { getLanguage, subscribeLanguage, t } from '../i18n/index.js';
import { recordHw } from './board/hwHistory.js';
import { whiteboardHandleMessage } from './board/whiteboard.js';
import { bypassHandleMessage } from './bypass.js';
import { devroomHandleResult, devroomSetStats } from './devroom/devroomStore.js';
import { mergeHandleMessage, mergeHandleResult } from './devroom/mergeStore.js';
import { CompactBreakWatch, director, InheritWatch, TempStaffWatch } from './director/director.js';
import { engineGetSnapshot, engineHandleMessage } from './engineStore.js';
import { type EzContext, PLAIN_CONTEXT } from './ez/activity.js';
import {
  contextPct,
  type ContextSample,
  type FatigueLook,
  fatigueLook,
  fatigueRules,
  nextContextSample,
} from './ez/fatigueState.js';
import { floorsHandleMessage } from './floors.js';
import { isOff, type OfficePanel } from './format.js';
import { backgroundHandleMessage } from './gfx/bg/settings.js';
import { jobHandleMessage } from './jobStore.js';
import { messengerConnectionLost, messengerHandleMessage } from './messenger/messengerStore.js';
import { cldNoticeEvent, cldNoticeReplay, cldPreviewOpen, cldPushState } from './notify/notices.js';
import { repoHandleMessage } from './repo/repoStore.js';
import { newlyInReview, reviewHandleMessage } from './repo/reviewStore.js';
import { compactHolds, levelWatch, rebirthWatch, restWatch } from './rest.js';
import { serverLine, serverText } from './serverText.js';
import { docSourcesHandleMessage } from './taskboard/taskBoardState.js';
import { workHandleMessage } from './work/workStore.js';
import { approvalsHandleMessage } from './workbench/approvals.js';

export interface ActionToast {
  id: number;
  name: string;
  text: string;
  tone: 'ok' | 'info' | 'error';
  duration?: number;
  /** The answer to the user's own click (cldOwnToast): drawn over every window and the viewer. */
  own?: boolean;
}

export interface CldSnapshot {
  /** T-0017: preset sheets and the look chosen per character name. */
  characterPresets: CharacterPresets | null;
  /** CHAR-HUMAN: the owner's imported parts. */
  characterParts: CharacterPart[];
  /** CHAR-HUMAN: the named person looks saved from the looks window. */
  personPresets: PersonPreset[];
  /** CHAR-FACTORY: the content packs. */
  characterPacks: CharacterPack[];
  officeSnapshot: OfficeSnapshot | null;
  codexTasks: CodexTasks | null;
  officeJobs: OfficeJobs | null;
  /** 작업 현황 (DEV-BOARD): the reported tasks (the daemon sends them on every connection). */
  taskBoard: TaskBoard | null;
  /** U-48: what the agents' own work lists say, per project (the daemon sends them only while this page shows). */
  tracked: Record<string, TrackedItems>;
  hwSample: HwSample | null;
  /** The hardware page's on-demand, cached disk-card snapshot. */
  diskUsage: DiskUsage | null;
  usageState: UsageState | null;
  /** An on-demand Codex usage probe is running for this client. */
  codexUsageChecking: boolean;
  /** AGENT-CLI: the plain office's notice to install the agent CLI; null in a full office. */
  agentCli: AgentCliState | null;
  /** T-0046: the GPU reservations (holders, the line, recent endings). */
  gpuBoard: GpuBoard | null;
  /** The user's EZ phrase rules; null until (unless) the daemon sends some. */
  ezRules: EzRules | null;
  events: OfficeEvent[];
  statusByName: Record<string, StatusOutput>;
  /** officeAccess: this connection may change nothing (its action controls are hidden). */
  officeReadOnly: boolean;
  terminalEnabled: boolean;
  /** T-0032: how the daemon's host writes folders. */
  hostInfo: HostInfo | null;
  /** T-0032: the folder picker's latest answer. */
  folderList: FolderList | null;
  toast: ActionToast | null;
  /** T-0026: agentId -> its context for 피로도, with the drops seen in its current session. */
  contexts: Record<number, ContextSample & { session?: string | null }>;
  /** TEMP-PLATES: roster employees with the execution each was last bound to. */
  tempStaff: TempEmployee[];
}

const empty: CldSnapshot = {
  characterPresets: null,
  characterParts: [],
  personPresets: [],
  characterPacks: [],
  officeSnapshot: null,
  codexTasks: null,
  officeJobs: null,
  taskBoard: null,
  tracked: {},
  hwSample: null,
  diskUsage: null,
  usageState: null,
  codexUsageChecking: false,
  agentCli: null,
  gpuBoard: null,
  ezRules: null,
  events: [],
  statusByName: {},
  officeReadOnly: true,
  terminalEnabled: false,
  hostInfo: null,
  folderList: null,
  toast: null,
  contexts: {},
  tempStaff: [],
};
let snapshot = empty;
const listeners = new Set<() => void>();

export const cldSubscribe = (listener: () => void) => {
  listeners.add(listener);
  const offLanguage = subscribeLanguage(listener);
  return () => {
    listeners.delete(listener);
    offLanguage();
  };
};
/**
 * The snapshot as this page reads it: the words the daemon wrote for job names
 * (a table text, see core serverText) in the page's language. Memoized per snapshot and language.
 */
let shown: { snap: CldSnapshot; language: string; out: CldSnapshot } | null = null;
export const cldGetSnapshot = (): CldSnapshot => {
  const language = getLanguage();
  if (shown && shown.snap === snapshot && shown.language === language) return shown.out;
  const jobs = snapshot.officeJobs;
  const out = jobs
    ? {
        ...snapshot,
        officeJobs: {
          ...jobs,
          jobs: jobs.jobs.map((job) => ({
            ...job,
            ...(job.label && { label: serverLine(job.label) }),
          })),
        },
      }
    : snapshot;
  shown = { snap: snapshot, language, out };
  return out;
};
/** W1: a subtree that sees a narrowed snapshot (the 작업실's Task tab shows one project's tasks). */
export const CldScope = createContext<((s: CldSnapshot) => CldSnapshot) | null>(null);
export function useCldStore(): CldSnapshot {
  const snap = useSyncExternalStore(cldSubscribe, cldGetSnapshot, cldGetSnapshot);
  const scope = useContext(CldScope);
  return useMemo(() => (scope ? scope(snap) : snap), [scope, snap]);
}

// Rows without a live agentId still need a stable office character. Keep
// their IDs well below the office's -1, -2, … subagent range.
const virtualIds = new Map<string, number>();
export function virtualAgentId(key: string): number {
  let id = virtualIds.get(key);
  if (id === undefined) {
    id = -1_000_000_000 - virtualIds.size;
    virtualIds.set(key, id);
  }
  return id;
}

/** A panel whose data kind the provider never sends is hidden, not left empty (NFR-CMP-003). */
export const panelAvailable = (id: OfficePanel, snap: CldSnapshot = snapshot): boolean =>
  id === 'terminal' ? snap.terminalEnabled : true;

let ezCache: { rules: EzRules | null; ctx: EzContext } | null = null;
/** What the EZ phrase table is read against: the built-in rules plus the user's own. */
export function ezContext(snap: CldSnapshot = snapshot): EzContext {
  if (ezCache && ezCache.rules === snap.ezRules) return ezCache.ctx;
  const ctx: EzContext = snap.ezRules ? { user: snap.ezRules } : PLAIN_CONTEXT;
  ezCache = { rules: snap.ezRules, ctx };
  return ctx;
}

export function cldHandleMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case 'characterPresets':
      snapshot = { ...snapshot, characterPresets: msg };
      break;
    case 'characterParts':
      snapshot = {
        ...snapshot,
        characterParts: msg.parts,
        personPresets: msg.presets,
        characterPacks: msg.packs,
      };
      break;
    case 'characterRefused':
      cldToast(msg.key, t(`character.refused.${msg.reason}`), 'error');
      return;
    case 'officeSnapshot':
      snapshot = { ...snapshot, officeSnapshot: msg };
      noteRests();
      break;
    case 'codexTasks':
      snapshot = { ...snapshot, codexTasks: msg };
      break;
    case 'officeJobs':
      snapshot = { ...snapshot, officeJobs: msg };
      break;
    case 'taskBoard': {
      // `error` answers only this screen's refused edit: a toast, not part of the board.
      const { error, ...board } = msg;
      const before = snapshot.taskBoard;
      snapshot = { ...snapshot, taskBoard: board };
      if (error) cldToast(t('tasks.toast'), error, 'error');
      // ponytail: the 검토 대기 notice is this screen's toast only; a bell/push entry needs a new notice cause.
      for (const task of newlyInReview(before, board))
        cldToast(t('review.waitingToast'), t('review.waitingLine', { name: task.assignee?.name ?? task.project, id: task.id }), 'info');
      break;
    }
    case 'trackedItems': {
      const tracked = { ...snapshot.tracked };
      if (msg.items.length) tracked[msg.project] = msg;
      else delete tracked[msg.project];
      snapshot = { ...snapshot, tracked };
      break;
    }
    case 'trackingSources':
      docSourcesHandleMessage(msg);
      break;
    case 'delegationApprovals':
      // C6: the cards live in their own store; this screen's decision gets a toast.
      approvalsHandleMessage(msg, (text, tone) => cldToast(t('approvals.title'), text, tone));
      break;
    case 'hwSample':
      snapshot = { ...snapshot, hwSample: msg };
      recordHw(msg); // T-0046: the board's graphs
      break;
    case 'diskUsage':
      snapshot = { ...snapshot, diskUsage: msg };
      break;
    case 'gpuBoard':
      snapshot = { ...snapshot, gpuBoard: msg };
      break;
    case 'usageState':
      snapshot = { ...snapshot, usageState: msg };
      break;
    case 'codexUsageCheckResult':
      snapshot = { ...snapshot, codexUsageChecking: false };
      if (!msg.ok)
        cldToast(t('usage.checkCodex'), serverText(msg, t('usage.checkFailed')), 'error');
      break;
    case 'tempStaff':
      snapshot = { ...snapshot, tempStaff: msg.staff };
      noteTemps();
      break;
    case 'ezRules':
      snapshot = { ...snapshot, ezRules: msg };
      break;
    case 'agentContextUsage': {
      // A new session (renew, /clear) is a fresh conversation: its drops start over.
      const session = rowOf(msg.id, snapshot.officeSnapshot)?.sessionId;
      const prev = snapshot.contexts[msg.id];
      const sample = nextContextSample(
        prev?.session === session ? prev : undefined,
        msg.contextTokens,
        msg.maxContextTokens,
        fatigueRules(snapshot.ezRules?.fatigue),
      );
      snapshot = {
        ...snapshot,
        contexts: { ...snapshot.contexts, [msg.id]: { ...sample, session } },
      };
      noteRests();
      break;
    }
    case 'officeEvent':
      // A reconnect's resync replays the whole feed (T-0025): keep each event once.
      if (snapshot.events.some((e) => e.ts === msg.ts && e.summary === msg.summary)) break;
      snapshot = { ...snapshot, events: [msg, ...snapshot.events].slice(0, 200) };
      cldNoticeEvent(msg); // T-0039: a job or Codex task that ended
      break;
    case 'previewOpen':
      cldPreviewOpen(msg); // P4 S6: a phone asked this PC for a 미리보기
      break;
    case 'statusOutput':
      snapshot = { ...snapshot, statusByName: { ...snapshot.statusByName, [msg.name]: msg } };
      break;
    case 'agentCliState':
      snapshot = { ...snapshot, agentCli: msg };
      break;
    case 'officeAccess':
      restWatch.connected(performance.now()); // the handshake: what follows is replay (REST-ANIM)
      rebirthWatch.connected(performance.now());
      levelWatch.connected(performance.now());
      inheritWatch.connected(performance.now(), REST_SETTLE_MS);
      tempWatch.connected(performance.now(), REST_SETTLE_MS);
      snapshot = {
        ...snapshot,
        agentCli: null, // a full office never sends one; a plain one sends it again after this
        officeReadOnly: msg.readOnly,
        terminalEnabled: msg.terminal === true,
      };
      break;
    case 'hostInfo':
      cldNoticeReplay(); // a connection's snapshot: its feed is history (T-0039)
      snapshot = { ...snapshot, hostInfo: msg };
      break;
    case 'folderList':
      snapshot = { ...snapshot, folderList: msg };
      break;
    case 'workContent':
      workHandleMessage(msg); // the temp work view (T-0056) keeps its own store
      return;
    case 'chatTranscript':
    case 'chatHistoryResult':
    case 'chatSearchResult':
    case 'chatSendResult':
    case 'chatPendingResult':
    case 'permissionAnswerResult':
    case 'slashCommandsList':
    case 'messengerContacts':
    case 'groupRooms':
    case 'groupTimeline':
    case 'groupActionResult':
    case 'pinnedConversations':
    case 'goneConversationDeleteResult':
      messengerHandleMessage(msg); // the office messenger (T-0043) keeps its own store
      return;
    case 'officeBackground':
      backgroundHandleMessage(msg); // BACKGROUND: the isometric surroundings keep their own store
      return;
    case 'pushState':
      cldPushState(msg); // T-0039 (the notices keep it)
      return;
    case 'engineState':
    case 'engineActionResult':
    case 'engineMoveAllResult':
      engineHandleMessage(msg);
      return;
    case 'newAgentPermission':
      bypassHandleMessage(msg); // O4: the permission mode new agents start with
      return;
    case 'buildingState':
      floorsHandleMessage(msg); // the floors keep their own state (T-0027)
      if (msg.error) cldToast(t('office.floor'), serverText(msg), 'error');
      return;
    case 'whiteboardMemos':
      whiteboardHandleMessage(msg); // the memos keep their own state (T-0065)
      return;
    case 'repoState':
    case 'repoDiff':
    case 'repoWorktreeDetail':
    case 'repoActionResult':
      repoHandleMessage(msg, cldToast); // the repository panel (T-0020) keeps its own state
      if (msg.type === 'repoActionResult') {
        devroomHandleResult(msg, cldToast); // the dev room's 따라잡기
        mergeHandleResult(msg); // its 병합 tab's own writes
      }
      return;
    case 'repoMergeCheckResult':
    case 'repoConflictsResult':
    case 'repoCleanupListResult':
    case 'devroomSettings':
      mergeHandleMessage(msg); // the dev room's 병합 tab keeps its own state
      return;
    case 'devroomStats':
      devroomSetStats(msg); // the dev room's footer
      return;
    case 'reviewNotes':
    case 'reviewNoteResult':
    case 'reviewSendResult':
      reviewHandleMessage(msg, cldToast); // the review loop keeps its own state too
      return;
    case 'jobActionResult':
      jobHandleMessage(msg, cldToast); // the engine's job logs and stops (T-0019)
      return;
    default:
      return;
  }
  emit();
}

/** A line of this screen's own among the events of the 알림 list (T-0041: a temp went home). */
export function cldLocalEvent(summary: string, name: string | null): void {
  const event: OfficeEvent = {
    type: 'officeEvent',
    ts: new Date().toISOString(),
    kind: 'temp',
    name,
    summary,
  };
  snapshot = { ...snapshot, events: [event, ...snapshot.events].slice(0, 200) };
  emit();
}

/** Starts the local affordance before the daemon acknowledges the probe. */
export function codexUsageCheckStarted(): void {
  if (snapshot.codexUsageChecking) return;
  snapshot = { ...snapshot, codexUsageChecking: true };
  emit();
}

/** The app's one toast (repository writes and the engine's results). */
export function cldToast(
  name: string,
  text: string,
  tone: ActionToast['tone'],
  duration?: number,
  own?: boolean,
): void {
  snapshot = {
    ...snapshot,
    toast: { id: ++toastSeq, name, text, tone, duration, ...(own && { own }) },
  };
  emit();
}

/**
 * DESKTOP-ACTIONS: the answer to the user's own click (복사, 내려받기, ...). Only this goes over the
 * windows and the attachment viewer (owner 11-01); a notice the server pushes or a later result keeps
 * the slot under the windows (UI-FIX 2).
 */
export function cldOwnToast(
  name: string,
  text: string,
  tone: ActionToast['tone'],
  duration?: number,
): void {
  cldToast(name, text, tone, duration, true);
}

/** Existing callers keep their familiar four-second notices and eight-second errors. */
export function actionToastDuration({
  tone,
  duration,
}: Pick<ActionToast, 'tone' | 'duration'>): number {
  return duration ?? (tone === 'error' ? 8_000 : 4_000);
}

function emit(): void {
  listeners.forEach((listener) => listener());
}

let toastSeq = 0;

/** The socket dropped: the messenger's pending requests can no longer be answered here. */
export function cldConnectionLost(): void {
  messengerConnectionLost();
  // A project that emptied while the socket was down would stay: the daemon resends what exists.
  if (Object.keys(snapshot.tracked).length) {
    snapshot = { ...snapshot, tracked: {} };
    emit();
  }
}

export function cldDismissToast(id: number): void {
  if (snapshot.toast?.id !== id) return;
  snapshot = { ...snapshot, toast: null };
  emit();
}

/** Test helper: restore the empty snapshot without carrying events between tests. */
export function cldResetForTests(): void {
  snapshot = empty;
  listeners.forEach((listener) => listener());
}

const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];

/** REST-ANIM + C1: every row's 휴식 count as fatigueFor counts it (the daemon's, or the drops
 *  seen), its Lv and its 환생 count; one that went up live plays a coffee break, a level-up or a
 *  rebirth (director). */
const inheritWatch = new InheritWatch();
const compactWatch = new CompactBreakWatch();

function noteRests(): void {
  const now = performance.now();
  compactHolds.clear();
  for (const o of snapshot.officeSnapshot?.orchestrators ?? []) {
    const id = o.agentId ?? virtualAgentId(`orch:${o.name}`);
    // COMPACT-COFFEE: the break starts with the compaction and drinks on while it lasts; the
    // boundary's 휴식 +1 of the same compaction plays no second one.
    const rose = restWatch.observe(id, Math.max(o.compactions, snapshot.contexts[id]?.drops ?? 0), now);
    if (o.compacting) compactHolds.add(id);
    if (compactWatch.observe(id, o.compacting === true, rose, now)) director.play(id, { kind: 'coffee' });
    if (!o.level) continue;
    if (levelWatch.observe(id, o.level.level, now))
      director.play(id, { kind: pick(FX_LEVELUP_LIVE), count: o.level.level });
    if (rebirthWatch.observe(id, o.level.rebirths, now))
      director.play(id, { kind: pick(FX_REBIRTH_LIVE), count: o.level.rebirths });
    // INHERIT: a new agent that took a removed one's records over, once it has its character
    if (inheritWatch.observe(o.name, o.level.inherit ?? 0, o.agentId !== null, now))
      director.play(id, { kind: 'inherit', count: o.level.inherit });
  }
  const owner = snapshot.officeSnapshot?.owner?.level.level; // OWNER-STATS: the owner levels up too
  if (owner !== undefined && levelWatch.observe(OWNER_CHARACTER_ID, owner, now))
    director.play(OWNER_CHARACTER_ID, { kind: pick(FX_LEVELUP_LIVE), count: owner });
}

/** FX-ALL: the character of a temp execution on screen now, or null (staff.ts knows the office). */
let tempCharacter: (execution: string) => number | null = () => null;
export function setTempCharacterLookup(fn: (execution: string) => number | null): void {
  tempCharacter = fn;
}
const tempWatch = new TempStaffWatch();

/** FX-ALL: the temp staff (sub-agents, Codex temporaries) level up and take coffee breaks too,
 *  on the execution's character while it is on screen (none now: skipped). */
function noteTemps(): void {
  const rules = fatigueRules(snapshot.ezRules?.fatigue);
  for (const m of tempWatch.observe(snapshot.tempStaff, rules, performance.now())) {
    const id = tempCharacter(m.execution);
    if (id === null) continue;
    director.play(
      id,
      m.kind === 'coffee' ? { kind: 'coffee' } : { kind: pick(FX_LEVELUP_LIVE), count: m.count },
    );
  }
}

/** The officeState row (an engine project or a Claude session) of a character. */
function rowOf(id: number, office: OfficeSnapshot | null) {
  return office?.orchestrators.find((o) => (o.agentId ?? virtualAgentId(`orch:${o.name}`)) === id);
}

/**
 * A character's 피로도 (T-0026), or null before its first context report.
 * Compactions: the row's count (the engine's from the transcript, the same
 * number the board's 컴팩션 N회 shows), or the context drops this screen saw
 * in the agent's current session when that is more (a plain Claude session
 * reports a neutral 0).
 *
 * ponytail: the drops are counted per screen since it opened (a reload starts
 * over); count them in the daemon if that matters for plain Claude sessions.
 */
export function fatigueFor(id: number, snap: CldSnapshot = snapshot): FatigueLook | null {
  const sample = snap.contexts[id];
  if (!sample) return null;
  const rowCount = rowOf(id, snap.officeSnapshot)?.compactions ?? 0;
  const rules = fatigueRules(snap.ezRules?.fatigue);
  return fatigueLook(
    contextPct(sample),
    Math.max(rowCount, sample.drops),
    rules,
    renewThreshold(id, snap),
  );
}

/**
 * M in "압축 N/M" (T-0045): an engine project has its own `compactionNudge`
 * (off by default); a plain Claude session has none.
 */
function renewThreshold(id: number, snap: CldSnapshot): number | null {
  const row = rowOf(id, snap.officeSnapshot);
  const project = row && engineGetSnapshot().state?.projects.find((p) => p.name === row.name);
  return project ? project.compactionNudge || null : null;
}

export interface OfficeIdentity {
  label: string;
  off: boolean;
  /** The provider says a turn is in progress (T-0045): a character with no tool running thinks, not rests. */
  busy?: boolean;
  /** Due for a hand-over: the engine's nudge (the stat's renew). */
  handoff: boolean;
  background: boolean;
  /** A project of the built-in engine (T-0018). */
  engine?: boolean;
  /** U-15: Lv, XP and 환생, when the daemon keeps them for this row. */
  level?: OfficeLevel;
}

export function identityForAgent(
  id: number,
  office: OfficeSnapshot | null,
  tasks: CodexTasks | null,
): OfficeIdentity | null {
  if (!office) return null;
  const orch = rowOf(id, office);
  if (orch) {
    const engine = !!engineGetSnapshot().state?.projects.some((p) => p.name === orch.name);
    return {
      label: orch.name,
      off: isOff(orch),
      busy: orch.busy === true,
      handoff: engine ? (fatigueFor(id)?.renew ?? false) : false,
      background: orch.bg?.state === 'working' || orch.bg?.state === 'blocked',
      engine,
      ...(orch.level && { level: orch.level }),
    };
  }
  const task = tasks?.tasks.find(
    (item) => (item.agentId ?? virtualAgentId(`codex:${item.id}`)) === id,
  );
  if (task)
    return {
      label: `codex·${task.project}`,
      off: ['done', 'failed', 'stopped'].includes(task.state),
      handoff: false,
      background: false,
    };
  return null;
}
