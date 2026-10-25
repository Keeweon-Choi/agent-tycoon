import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';

import type {
  CharacterPack,
  CharacterPart,
  CharacterPresets,
  CodexTasks,
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
import { getLanguage, subscribeLanguage, t } from '../i18n/index.js';
import { recordHw } from './board/hwHistory.js';
import { whiteboardHandleMessage } from './board/whiteboard.js';
import { bypassHandleMessage } from './bypass.js';
import { engineGetSnapshot, engineHandleMessage } from './engineStore.js';
import { type EzContext, PLAIN_CONTEXT } from './ez/activity.js';
import {
  contextPct,
  type ContextSample,
  type FatigueLook,
  fatigueLook,
  fatigueRules,
  nextContextSample,
} from './ez/fatigue.js';
import { floorsHandleMessage } from './floors.js';
import { isOff, type OfficePanel } from './format.js';
import { jobHandleMessage } from './jobStore.js';
import { messengerConnectionLost, messengerHandleMessage } from './messenger/messengerStore.js';
import { cldNoticeEvent, cldNoticeReplay, cldPushState } from './notify/notices.js';
import { repoHandleMessage } from './repo/repoStore.js';
import { restWatch } from './rest.js';
import { serverLine, serverText } from './serverText.js';
import { docSourcesHandleMessage } from './taskboard/taskBoard.js';
import { workHandleMessage } from './work/workStore.js';
import { approvalsHandleMessage } from './workbench/approvals.js';

export interface ActionToast {
  id: number;
  name: string;
  text: string;
  tone: 'ok' | 'info' | 'error';
  duration?: number;
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
  usageState: UsageState | null;
  /** An on-demand Codex usage probe is running for this client. */
  codexUsageChecking: boolean;
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
  usageState: null,
  codexUsageChecking: false,
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
      snapshot = { ...snapshot, taskBoard: board };
      if (error) cldToast(t('tasks.toast'), error, 'error');
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
    case 'statusOutput':
      snapshot = { ...snapshot, statusByName: { ...snapshot.statusByName, [msg.name]: msg } };
      break;
    case 'officeAccess':
      restWatch.connected(performance.now()); // the handshake: what follows is replay (REST-ANIM)
      snapshot = {
        ...snapshot,
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
      messengerHandleMessage(msg); // the office messenger (T-0043) keeps its own store
      return;
    case 'pushState':
      cldPushState(msg); // T-0039 (the notices keep it)
      return;
    case 'engineState':
    case 'engineActionResult':
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
): void {
  snapshot = { ...snapshot, toast: { id: ++toastSeq, name, text, tone, duration } };
  emit();
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

/** REST-ANIM: every row's 휴식 count as fatigueFor counts it (the daemon's, or the drops seen). */
function noteRests(): void {
  const now = performance.now();
  for (const o of snapshot.officeSnapshot?.orchestrators ?? []) {
    const id = o.agentId ?? virtualAgentId(`orch:${o.name}`);
    restWatch.observe(id, Math.max(o.compactions, snapshot.contexts[id]?.drops ?? 0), now);
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
