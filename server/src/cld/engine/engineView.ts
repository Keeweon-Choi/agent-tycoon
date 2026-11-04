/**
 * The engine's projection for the office: the `engineState` message, the office world with one
 * entry per project, and the turn cache the busy flag reads. Extracted from engine.ts (E5).
 */
import * as fs from 'fs';

import { koText } from '../../../../core/src/cld/serverText.js';
import type {
  EngineProject,
  EngineState,
  OfficeRoom,
} from '../../../../core/src/messages.js';
import { turnEnded } from '../providers/claudeProvider.js';
import type { AgentEntry, World } from '../providers/types.js';
import { ENTRY_DEFAULTS } from '../providers/types.js';
import type { AgentChoicesReader } from './agentCapabilities.js';
import type { AgentProvider } from './agents/types.js';
import { MESSENGER_TIMING, tail, turnOver } from './messenger.js';
import type { ProjectRecord } from './registry.js';
import { DEFAULT_PROVIDER, roomOf } from './registry.js';
import type { Live } from './sessionMatch.js';

/** What engineState() reads: engine state taken fresh at each call (projects and live are reassigned). */
export interface StateCtx {
  projects: ProjectRecord[];
  file: string;
  broken: string | null;
  daemonWarnings: string[];
  /** The engine's SWAP_UNFINISHED text. */
  swapUnfinished: string;
  agentChoices: AgentChoicesReader;
  holder: (p: ProjectRecord) => Live | null;
  projectOf: (name: string) => string | null;
  gaveUp: (name: string) => string | undefined;
  agentOf: (p: ProjectRecord) => AgentProvider | undefined;
  /** What the office shows for an agent whose provider this build does not have. */
  unknownProvider: (id: string) => string;
  untrusted: Set<string>;
  trusting: Set<string>;
  moveAllRun: { total: number; done: number } | null;
}

/** What applyEngine() reads: the same, fresh at each call. */
export interface ApplyCtx {
  projects: ProjectRecord[];
  holder: (p: ProjectRecord) => Live | null;
  claimsName: (q: ProjectRecord, name: string | null | undefined, dir: string) => boolean;
  contested: (
    p: ProjectRecord,
    claimedBy: (q: ProjectRecord) => boolean,
    name: string | null | undefined,
    sessionId: string | null | undefined,
  ) => boolean;
  compactionsFor: (name: string, sessionId: string) => number;
  busyOf: (h: Live, fallback: boolean | null, rowTranscript?: string | null) => boolean | null;
  /** The engine's OPS_ROOM name. */
  opsRoom: string;
}

export function engineState(ctx: StateCtx): EngineState {
  const warnings = [
    ctx.broken &&
      (ctx.broken === ctx.swapUnfinished
        ? ctx.swapUnfinished
        : koText('registry_broken', { file: ctx.file, why: ctx.broken })),
    ...ctx.daemonWarnings,
  ].filter((w): w is string => !!w);
  const choices = ctx.agentChoices.discover();
  return {
    type: 'engineState',
    projects: ctx.projects.map((p): EngineProject => {
      const h = ctx.holder(p);
      const {
        name,
        folder,
        wantRunning,
        room: _r,
        sessionId: _s,
        backgroundId: _b,
        idleRetired,
        role,
        assignmentId: _a,
        workFolder: _w,
        provider,
        resumeAsCopy: _copy,
        ...launch
      } = p;
      const project = role ? ctx.projectOf(name) : null;
      const sessionId = h?.sessionId || p.sessionId;
      const gave = !h && wantRunning ? ctx.gaveUp(name) : undefined;
      const agent = ctx.agentOf(p);
      const cannot = !agent
        ? ctx.unknownProvider(provider ?? DEFAULT_PROVIDER)
        : !h
          ? (agent.ready?.() ?? null)
          : null;
      return {
        name,
        ...(role && { role }),
        ...(project && { project }),
        folder,
        room: roomOf(p),
        ...launch,
        wantRunning,
        live: h !== null,
        ...(h?.kind === 'background' && h.id && !h.resting && { bgId: h.id }),
        ...(provider && provider !== DEFAULT_PROVIDER && { provider }),
        ...(sessionId && { sessionId }),
        ...(!h && ctx.untrusted.has(name) && { needsTrust: true }),
        ...(ctx.trusting.has(name) && { trusting: true }),
        ...(cannot
          ? { downNote: cannot }
          : !h && wantRunning && idleRetired
            ? { downNote: koText('down_idle') }
            : gave !== undefined && { downNote: koText('down_gave_up', { why: gave }) }),
      };
    }),
    ...(Object.keys(choices).length > 0 && { agentChoices: choices }),
    ...(warnings.length > 0 && { warnings }),
    ...(ctx.moveAllRun && { moveAll: { done: ctx.moveAllRun.done, total: ctx.moveAllRun.total } }),
  };
}

/** apply(): per transcript, its size and mtime when last read, and whether the main turn was over. */
export class TurnCache {
  private readonly seen = new Map<string, { sig: string; over: boolean; at: number }>();

  /**
   * Is the project's session working? Its file's status, as the messenger reads
   * it (the typing indicator and 보냄(대기 중) agree); else the provider row's.
   * `busy` also holds while only a background task runs (a sleep loop, a
   * sub-agent): a main turn that ended by its transcript (the messenger's
   * turnOver) is rest, not "thinking".
   */
  busyOf(h: Live, fallback: boolean | null, rowTranscript?: string | null) {
    const busy = h.status === 'busy' ? true : turnEnded(h.status) ? false : fallback;
    if (busy !== true) return busy;
    const file = rowTranscript ?? h.agent.transcript(h);
    let sig: string;
    try {
      const st = fs.statSync(file);
      sig = `${st.size}:${st.mtimeMs}`;
    } catch {
      return busy;
    }
    const now = Date.now();
    let seen = this.seen.get(file);
    // An unchanged file settles a finished turn for good; a running one is read
    // again soon (a text-only reply ends its turn only once it is quiet).
    if (!seen || seen.sig !== sig || (!seen.over && now - seen.at >= MESSENGER_TIMING.quietMs)) {
      seen = { sig, over: turnOver(tail(file), now, MESSENGER_TIMING.quietMs), at: now };
      this.seen.set(file, seen);
    }
    return !seen.over;
  }
}

/**
 * The office with one entry per project (key `engine:<name>`) in its room;
 * the Claude provider's rows of the same conversation fold into it (also the
 * pid-less rows `claude agents --json` keeps after a reboot).
 */
export function applyEngine(world: World, ctx: ApplyCtx): World {
  const absorbed = new Set<AgentEntry>();
  const entries = ctx.projects.map((p): AgentEntry => {
    const h = ctx.holder(p);
    const ids = new Set([p.sessionId, h?.sessionId].filter(Boolean));
    const rows = world.agents.filter(
      (a) =>
        (a.sessionId !== null && a.sessionId !== undefined && ids.has(a.sessionId)) ||
        (a.bg !== null &&
          ctx.claimsName(p, a.name, a.dir) &&
          !ctx.contested(p, (q) => ctx.claimsName(q, a.name, a.dir), a.name, a.sessionId)),
    );
    rows.forEach((a) => absorbed.add(a));
    const row = h ? (rows.find((a) => a.sessionId === h.sessionId) ?? rows[0]) : undefined;
    return {
      ...ENTRY_DEFAULTS,
      // The count the board's 컴팩션 N회 shows: the stat's 압축 N/M must agree (10-22 18:26).
      compactions: h ? ctx.compactionsFor(p.name, h.sessionId) : 0,
      key: `engine:${p.name}`,
      name: p.name,
      dir: p.folder,
      title: p.title ?? null,
      tab: roomOf(p),
      order: 0,
      state: h ? 'running' : 'off',
      // The session file's status, as the messenger reads it to queue (T-0043:
      // the typing indicator and 보냄(대기 중) agree); else the provider row's.
      busy: !h ? null : ctx.busyOf(h, row?.busy ?? null, row?.transcript),
      // STATE-SYNC: turn over, a background shell still running (Claude Code calls it Working).
      ...(h?.status === 'shell' && { shellWait: true }),
      // D5: a resting session has no process, conversation or job to show.
      pid: h?.pid || null,
      sessionId: h?.sessionId || p.sessionId || null,
      bg:
        h?.kind === 'background' && !h.resting
          ? {
              id: h.id ?? h.sessionId.slice(0, 8),
              state: row?.bg?.state ?? 'unknown',
              sessionId: h.sessionId,
              started: h.startedAt ? new Date(h.startedAt).toISOString() : null,
            }
          : null,
      remoteControl: { on: !!h && p.remoteControl === true, url: null },
      alive: h !== null,
      transcript: h ? (row?.transcript ?? h.agent.transcript(h)) || null : null,
    };
  });
  const kept = world.agents.filter((a) => !absorbed.has(a));
  const agents = [...kept, ...entries];
  // After the room's other members.
  const last = new Map<string, number>();
  for (const a of kept) last.set(a.tab, Math.max(last.get(a.tab) ?? 0, a.order));
  for (const e of entries) {
    e.order = (last.get(e.tab) ?? 0) + 1;
    last.set(e.tab, e.order);
  }
  const used = (all: AgentEntry[], room: string) => all.some((a) => a.tab === room);
  // A room the folded rows leave empty goes.
  const rooms: OfficeRoom[] = world.rooms.filter(
    (r) => !used(world.agents, r.name) || used(agents, r.name),
  );
  for (const e of entries)
    if (!rooms.some((r) => r.name === e.tab))
      rooms.push({ name: e.tab, kind: e.tab === ctx.opsRoom ? 'ops' : 'orch', order: 0 });
  return { agents, rooms: rooms.map((r, i) => ({ ...r, order: i + 1 })) };
}
