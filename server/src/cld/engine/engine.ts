/**
 * The built-in engine, E1 (T-0018, ADR-0013, SAD 6.7): projects whose
 * orchestrator is a background session an agent CLI's own daemon hosts. The
 * engine registers projects, starts, stops and restarts their sessions and
 * revives, when the daemon starts, the ones that were on. No tmux.
 *
 * D4 (ADR-0016): everything specific to one CLI sits behind its agent
 * provider (agents/types.ts), picked by the assignment's `provider`; Claude
 * Code (agents/claude/) is the one there is. Liveness is the providers' live
 * sessions, read on demand, when they change and every 30 s; a CLI runs only
 * for actions. A conversation live anywhere is never started or resumed again
 * (one conversation, one manager).
 */
import { randomUUID } from 'node:crypto';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { goneName } from '../../../../core/src/cld/goneAgent.js';
import { leadDefaults } from '../../../../core/src/cld/leadDefaults.js';
import type { PathHost } from '../../../../core/src/cld/projectPath.js';
import { normalizeProjectPath } from '../../../../core/src/cld/projectPath.js';
import { koText } from '../../../../core/src/cld/serverText.js';
import type {
  BoardTask,
  EngineAction,
  EngineActionResult,
  EngineState,
  InheritableAgent,
  ProjectImportResult,
  ProjectImportRow,
} from '../../../../core/src/messages.js';
import {
  AGENT_IDLE_STOP_MS,
  PTY_MOVE_ALL_POLL_MS,
  PTY_MOVE_ALL_WAIT_MS,
  PTY_MOVE_IDLE_MS,
} from '../../constants.js';
import { detectHostInfo } from '../folders.js';
import type { SocketStepUp, WsSend } from '../hooks.js';
import { LABEL, LABEL_OLD } from '../labels.js';
import { seededPermission } from '../newAgentPermission.js';
import {
  clearRenameJournal,
  inheritable,
  moveProjectData,
  NameTaken,
  purgeProjectData,
  readRenameJournal,
  recordFormerName,
  takenBy,
  writeRenameJournal,
} from '../projectData.js';
import { turnEnded } from '../providers/claudeProvider.js';
import type { World } from '../providers/types.js';
import { STEPUP_REQUIRED } from '../shell/gate.js';
import type { SpawnFn } from '../spawnJson.js';
import { gitSummary } from '../statusReport.js';
import { repliedState } from '../transcriptHistory.js';
import type { AgentChoicesReader } from './agentCapabilities.js';
import { ClaudeAgent, claudeCommand } from './agents/claude/claude.js';
import { ClaudePtyAgent } from './agents/claude/claudePty.js';
import type { AgentProvider, DeliverResult } from './agents/types.js';
import { AgentTokens } from './agentTokens.js';
import type { BypassResult } from './bypass.js';
import { acceptBypass, BYPASS_ARGS, BYPASS_TIMING } from './bypass.js';
import { CompactionWatch } from './compactions.js';
import {
  fail,
  MOVE_BUSY,
  MOVE_ROLLED_BACK,
  type Outcome,
  parseEngineAction,
  warned,
} from './engineAction.js';
import type { StateCtx } from './engineView.js';
import { applyEngine, engineState, TurnCache } from './engineView.js';
import { EngineWatch } from './engineWatch.js';
import { configDir, shortStamp } from './events.js';
import { createGitRunner, type GitRunner } from './git/gitRun.js';
import { readRecords } from './git/worktrees.js';
import { basisLines, handoffFormat, handoffRefs, keepCommits, renewPrompt } from './handoff.js';
import { loadOrCreateHost } from './host.js';
import { scanProjects } from './importProjects.js';
import type { LeadTerm, OldLead, SwapJournal } from './leadSwap.js';
import {
  applySwap,
  eventLines,
  fitBriefing,
  leadPrompt,
  promotePair,
  readJournal,
  roleNotice,
  writeJournal,
} from './leadSwap.js';
import type { RosterAgent } from './mcpTools.js';
import { ProjectEdits } from './projectEdits.js';
import type { ProjectRecord } from './registry.js';
import {
  CHECK,
  checkFolder,
  checkName,
  checkRulesFile,
  CLAUDE_PTY_PROVIDER,
  cliOf,
  createAssignmentId,
  createProjectId,
  DEFAULT_PROVIDER,
  linkWorkers,
  loadRegistry,
  migrateRegistry,
  registryPath,
  registryTexts,
  samePath,
  saveRegistry,
  sessionName,
} from './registry.js';
import { Renewals, type RenewRecord } from './renewals.js';
import { ReviveGuard } from './reviveGuard.js';
import { CLD_BIN_DIR, cldBinPath, cleanEnv, findSystemdRun } from './sessionEnv.js';
import {
  claims,
  claimsName,
  collide,
  contested,
  holderOf,
  type Live,
  type MatchCtx,
  newest,
} from './sessionMatch.js';
import { appendMissing } from './sessionPath.js';
import type { TrustResult } from './trust.js';
import { TRUST_ARGS, TRUST_TIMING, trustFolder } from './trust.js';

export type EngineMode = 'auto' | 'on' | 'off';

/** The engine runs unless `--engine off`. */
export const engineOn = (mode: EngineMode): boolean => mode !== 'off';

/** The operations room: environment work, not a product or a personal project (user 10-22 17:05). */
export const OPS_ROOM = koText('room_ops');

export const ENGINE_TIMING = {
  bgMs: 60_000,
  stopMs: 30_000,
  /** A started session shows up in ~/.claude/sessions within this. */
  appearMs: 30_000,
  /** A stopped one leaves it within this. */
  goneMs: 30_000,
  pollMs: 250,
  reviveGapMs: 2_000,
  safetyMs: 30_000,
  debounceMs: 1_000,
  /** renew: how long the caller's turn may take to end, and how often it is looked at. */
  renewWaitMs: 30 * 60_000,
  renewPollMs: 2_000,
  /** T-0091: how often a wantRunning project's session is looked at while the daemon runs (0 = never). */
  watchMs: 30_000,
  /** T-0126: wait for Claude's daemon to take over the same conversation before calling it gone. */
  adoptMs: 60_000,
  /** TERM-P1: a session in our PTY host idle this long with no viewer is stopped (idleRetired). */
  idleStopMs: AGENT_IDLE_STOP_MS,
  /** TERM-P3: a moved agent must be found idle on its own conversation in our PTY host within this. */
  moveIdleMs: PTY_MOVE_IDLE_MS,
  /** TERM-P3 move-all: how often a busy agent is looked at again, and how long before it is skipped. */
  moveAllPollMs: PTY_MOVE_ALL_POLL_MS,
  moveAllWaitMs: PTY_MOVE_ALL_WAIT_MS,
  /** T-0091: the Nth dead-session check inside this window is not revived but left down, marked. */
  reviveWindowMs: 10 * 60_000,
  reviveLimit: 3,
  /** TOKEN-GUARD: at most this many revives of one project in 24 h (each is a resumed turn)... */
  reviveDayLimit: 6,
  /** ...and the k-th of them waits this * 2^(k-1) after the one before. */
  reviveBackoffMs: 60_000,
};

/** TOKEN-GUARD provenance: who a start was for. The engine's own (a revive, a message waking a
 *  resting session), an agent's delegation (MCP), the CLI, or a person in the office. */
export const startedBy = (source: string): 'engine' | 'agent' | 'cli' | 'person' =>
  source === 'revive' || source === 'messenger'
    ? 'engine'
    : source === 'gui:mcp'
      ? 'agent'
      : source === 'gui:cli'
        ? 'cli'
        : 'person';

/** D3b: why the engine refuses every change after a promote that could not write the registry (a restart finishes the swap). */
export const SWAP_UNFINISHED =
  koText('swap_unfinished');

/** K1 (B2): the task worktrees a renew's work basis lists. */
const RENEW_WORKTREES_MAX = 10;

/** How every revive notice starts: a waiting one is replaced by the next (writeInbox `replaces`). */
export const REVIVE_TAG = `[${LABEL} 자동 복구 · `;
/** T-80: the tag before the rename; revive notices still waiting in an inbox carry it (drop a release later). */
export const REVIVE_TAG_OLD = `[${LABEL_OLD} 자동 복구 · `;
/** First message after revive (the 자동 복구 line): why the session was started again. */
export function reviveText(cause: 'reboot' | 'restart' | 'died', when: string): string {
  const why =
    cause === 'reboot'
      ? '컴퓨터가 다시 켜져서 엔진이 이 대화를 다시 띄웠다. 돌던 job 작업과 서브에이전트는 꺼졌다.'
      : cause === 'died'
        ? '같은 부팅에서 세션이 꺼져 다시 띄웠다. job 작업은 살아 있을 수 있다("$CLD_BIN" jobs 로 확인).'
        : 'agty가 다시 뜰 때 이 세션이 꺼져 있어서 엔진이 다시 띄웠다. job 작업은 살아 있을 수 있다("$CLD_BIN" jobs 로 확인).';
  return `${REVIVE_TAG}${when}] ${why} 꺼지기 전에 하던 일을 확인하고 이어서 해 달라. 하던 일이 없었으면 그대로 기다린다.`;
}

/** The compaction nudge (an opt-in per project). */
export const nudgeText = (n: number, fillPct: number): string =>
  `[${LABEL}] 이 대화는 컴팩션을 ${n}번 거친 뒤 컨텍스트가 다시 ${fillPct}% 찼다. 하던 일을 안전한 지점까지 마치고, 인수인계 파일을 제목 '## 목표' '## 완료' '## 미해결' '## 다음 행동'(있으면 '## 결정' '## 시도했다 버린 것')으로 쓰고 줄마다 [사실]·[판단]·[미확인] 을 단 뒤(돌고 있는 작업은 pid·로그까지), 백그라운드 서브에이전트가 끝나면 마지막으로 "$CLD_BIN" renew <그 파일> 을 실행하고 턴을 끝내라. 엔진이 같은 이름의 새 대화를 띄우고 인수인계를 첫 메시지로 넘긴다.`;

export interface EngineOptions {
  claudePath: string;
  /** TERM-P1: dist/cld-ptyhost.js for `claude-pty` agents; null or unset: they cannot start. */
  ptyHostScript?: string | null;
  readOnly: boolean;
  /** T-0110: the installed CLIs' model and effort choices; none (empty) unless given. */
  agentChoices?: AgentChoicesReader;
  /** Claude Code's home (~/.claude) and the HOME of every `claude` it runs. */
  home?: string;
  /** The host's folder rules (T-0032); detected with `home` when unset. */
  host?: PathHost;
  registryFile?: string;
  /** Projects or liveness changed: re-merge the office, publish engineState. */
  changed?: () => void;
  log?: (line: string) => void;
  spawnFn?: SpawnFn;
  /** The environment `claude` runs get their allowlist from (process.env). */
  env?: NodeJS.ProcessEnv;
  /** systemd-run path, or null for setsid; detected when undefined. */
  systemdRun?: string | null;
  timing?: Partial<typeof ENGINE_TIMING>;
  /** cld/bin with the agty CLI (T-0019): CLD_BIN for sessions; null leaves it out. */
  binDir?: string | null;
  /** The PATH sessions and jobs should get (sessionPath.ts), built once by the caller; null = the service's own. */
  sessionPath?: string | null;
  /** T-0019: an event for ~/.config/agent-tycoon/events.jsonl (HIF shape). */
  event?: (type: string, source: string, fields: Record<string, unknown>) => void;
  /** T-0019: a session was started (start, restart, revive, renew): deliver its inbox. */
  started?: (name: string) => void;
  /** W2: the folder a Claude Worker should start in now (the worktree given to it), or null. */
  assignedFolder?: (p: ProjectRecord) => string | null;
  /** T-0019: a message into a project's inbox (revive's notice, renew's handoff); `replaces`: the
   *  first words of an older notice of the same kind still waiting there, which this one replaces. */
  writeInbox?: (name: string, text: string, replaces?: string | readonly string[]) => boolean;
  /** T-0019: a project's conversation refilled after its compaction nudge count. */
  nudge?: (name: string, count: number, fillPct: number) => void;
  /** The clock of the revive window (T-0091); tests move it. */
  now?: () => number;
  /** D4: agent providers beside Claude's (agents/types.ts), by their id (tests; D5 adds Codex). */
  agents?: AgentProvider[];
  /** D3b: what a new Lead's first prompt lists: the project's Tasks, its running jobs and
   *  Codex tasks ("<title> <id>"), and the events.jsonl records to summarize. */
  /** K1 (G6): the background sub-agents agent `name`'s live session still runs (the office's
   *  AgentStateStore); a renew waits until there are none, and while it is not known (null). */
  subagents?: (name: string) => number | null;
  briefing?: (project: string) => {
    tasks: BoardTask[];
    running: string[];
    events: Array<Record<string, unknown>>;
  };
  /** D5 (F4): with each safety refresh (30 s): what the daemon retries on that beat. */
  tick?: () => void;
  /** D3b: a Lead swap committed: forget in-memory state kept for these names (the messenger). */
  swapped?: (names: string[]) => void;
  /** RENAME / remove: runs `change` (projectData, on disk) between the office's flush of its
   *  in-memory stores and their reload; `names` are the agents concerned. Unset: `change` alone. */
  projectData?: (change: () => string[], names: string[]) => string[];
  /** AUTO-TRUST: the trust step's waits (tests shorten them). */
  trustTiming?: Partial<typeof TRUST_TIMING>;
  /** BYPASS-ACCEPT: the Bypass Permissions warning step's waits (tests shorten them). */
  bypassTiming?: Partial<typeof BYPASS_TIMING>;
}

/** What the office shows for an agent whose provider this build does not have. */
const unknownProvider = (id: string): string =>
  koText('agent_unknown_start', { id });
/** D5: why a person's own message to a Codex Worker is refused (open question 1). */
export const NO_DIRECT_CHAT =
  koText('no_direct_chat');
/** D5 (6.3): what a sender is told for a message to such an agent (nothing is queued). */
const unknownProviderSend = (id: string): string =>
  koText('agent_unknown_send', { id });

export class Engine {
  private readonly agentChoices: AgentChoicesReader;
  /** D3: one record per agent, each project's Lead (named as the project) and its Workers,
   *  keyed by the agent's unique name: every per-name map below is per agent. */
  private projects: ProjectRecord[] = [];
  private recentImport: { id: string; names: string[] } | null = null;
  private live: Live[] = [];
  private broken: string | null = null;
  private daemonWarnings: string[] = [];
  /** Projects whose last start Claude refused: their folder is not trusted yet. */
  private readonly untrusted = new Set<string>();
  /** AUTO-TRUST: Leads a person added in the office: their first 켜기 may answer the trust question.
   *  ponytail: in memory, so after a daemon restart the first 켜기 shows the manual way and marks
   *  the project (needsTrust), and the next 켜기 answers it; persist it if that ever matters. */
  private readonly consented = new Set<string>();
  /** AUTO-TRUST: projects whose folder's trust question is being answered right now. */
  private readonly trusting = new Set<string>();
  private readonly running = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private unwatch: Array<() => void> = [];
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private sig = '';
  private disposed = false;
  private scope: string | null;
  readonly home: string;
  private readonly host: PathHost;
  private readonly file: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly t: typeof ENGINE_TIMING;
  /** T-0019: agty's CLI for sessions (CLD_BIN), or null. */
  readonly cldBin: string | null;
  /** S7: each started session's CLD_AGENT_TOKEN, mapped back to its project. */
  readonly tokens: AgentTokens;
  /** The PATH every session and job gets, or null when the service's own stands. */
  private sessionPath: string | null = null;
  /** RENEW-STUCK: pending renewals (renewals.ts). */
  private readonly renewals: Renewals;
  /** K1 (B5): the git runner that checks a handoff's commit references (made on first use). */
  private git: GitRunner | null = null;
  /** D3b: the two names a promote holds, until it is done. */
  private readonly swapping = new Set<string>();
  /** Projects live at the last refresh (orch_exit when one goes). */
  private liveNames = new Set<string>();
  /** contested() conflicts already logged (agent + session). */
  private readonly contestedLogged = new Set<string>();
  /** apply(): per transcript, its size and mtime when last read, and whether the main turn was over. */
  private readonly turns = new TurnCache();
  /** Compactions and the one renew nudge seen per project's conversation. */
  private readonly compactions: CompactionWatch;
  /** COMPACT-COFFEE: projects whose Claude Code shows its Compacting spinner, by the compaction
   *  count when it was first seen (the boundary that raises the count ends it). */
  private readonly compactingSeen = new Map<string, number>();
  /** TOKEN-GUARD: revive counts and give-ups per project (revive-guard.json). */
  private readonly guard: ReviveGuard;
  /** Revive at start, the watch, idle retirement and adoption (engineWatch.ts). */
  private readonly watcher: EngineWatch;
  /** E8: add, addWorker, edit and their checks (projectEdits.ts). */
  private readonly edits: ProjectEdits;
  private hostIdentity: string | null = null;

  constructor(private readonly opts: EngineOptions) {
    this.agentChoices = opts.agentChoices ?? { discover: () => ({}) };
    this.home = opts.home ?? os.homedir();
    this.host = opts.host ?? detectHostInfo(this.home);
    this.file = opts.registryFile ?? registryPath(this.home);
    const binDir = opts.binDir !== undefined ? opts.binDir : CLD_BIN_DIR;
    this.env = cleanEnv(opts.env ?? process.env, this.home, process.platform, binDir);
    this.cldBin = binDir ? cldBinPath(binDir) : null;
    this.tokens = new AgentTokens(this.home, (l) => this.log(l));
    if (opts.sessionPath && process.platform !== 'win32') {
      const key = Object.keys(this.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
      this.env[key] = this.sessionPath = appendMissing(opts.sessionPath, this.env[key]);
    }
    this.scope = opts.systemdRun !== undefined ? opts.systemdRun : findSystemdRun(opts.env);
    this.t = { ...ENGINE_TIMING, ...opts.timing };
    this.compactions = new CompactionWatch({
      event: (...a) => this.opts.event?.(...a),
      nudge: (...a) => this.opts.nudge?.(...a),
    });
    this.guard = new ReviveGuard({
      home: this.home,
      timing: this.t,
      now: () => this.now(),
      log: (l) => this.log(l),
      event: (...a) => this.opts.event?.(...a),
      changed: () => this.opts.changed?.(),
    });
    this.renewals = new Renewals({
      home: this.home,
      timing: this.t,
      running: this.running,
      disposed: () => this.disposed,
      broken: () => this.broken,
      find: (name) => this.find(name),
      rereadLive: () => {
        this.live = this.readLive();
      },
      holder: (p) => this.holder(p),
      refresh: () => this.refresh(),
      sleep: (ms) => this.sleep(ms),
      renaming: (name) => [...this.renames.values()].some((r) => r.from === name),
      enqueue: (fn) => this.enqueue(fn),
      stopSession: (h) => this.stopSession(h),
      startProject: (p, source, newConversation) => this.startProject(p, source, newConversation),
      log: (l) => this.log(l),
      event: (...a) => this.opts.event?.(...a),
      writeInbox: (...a) => this.opts.writeInbox?.(...a),
      compose: (p, r, h) => this.renewCompose(p, r, h),
      ...(this.opts.subagents && { subagents: this.opts.subagents }),
    });
    this.watcher = new EngineWatch({
      timing: this.t,
      file: this.file,
      running: this.running,
      untrusted: this.untrusted,
      guard: this.guard,
      projects: () => this.projects,
      live: () => this.live,
      agents: () => this.agents.values(),
      disposed: () => this.disposed,
      broken: () => this.broken,
      readOnly: () => this.opts.readOnly,
      now: () => this.now(),
      find: (name) => this.find(name),
      holder: (p) => this.holder(p),
      agentOf: (p) => this.agentOf(p),
      notReady: (p) => this.notReady(p),
      // K1 (B4): one a renew could not start stays down until a person starts it (no retry).
      renewing: (name) => this.renewals.has(name) || this.renewals.failedStart(name),
      reviveBudget: (name, backoff) => this.reviveBudget(name, backoff),
      reviveOne: (p, cause, firstPrompt) => this.reviveOne(p, cause, firstPrompt),
      patch: (name, fields) => this.patch(name, fields),
      enqueue: (fn) => this.enqueue(fn),
      stopSession: (h, accepted) => this.stopSession(h, accepted),
      refresh: () => this.refresh(),
      dropLive: (name) => this.liveNames.delete(name),
      waitFor: (fn, ms) => this.waitFor(fn, ms),
      sleep: (ms) => this.sleep(ms),
      changed: () => this.opts.changed?.(),
      event: (...a) => this.opts.event?.(...a),
      log: (l) => this.log(l),
    });
    this.edits = new ProjectEdits({
      host: this.host,
      home: this.home,
      projects: () => this.projects,
      agents: () => this.agents,
      find: (name) => this.find(name),
      holder: (p) => this.holder(p),
      collide: (a, b) => this.collide(a, b),
      agentOf: (p) => this.agentOf(p),
      leads: () => this.leads(),
      leadLaunch: (req) => this.leadLaunch(req),
      newClaude: (provider) => this.newClaude(provider),
      inheritable: (folder) => this.inheritable(folder),
      refresh: () => this.refresh(),
      commit: (next) => this.commit(next),
      dataChange: (change, names) => this.dataChange(change, names),
      log: (l) => this.log(l),
    });
    // TERM-P1 (ADR-0018): Claude in our own PTY host, for agents whose provider is `claude-pty`.
    this.pty = new ClaudePtyAgent({
      claudePath: opts.claudePath,
      home: this.home,
      env: this.env,
      systemdRun: this.scope,
      cldBin: this.cldBin,
      hostScript: opts.ptyHostScript ?? null,
      log: (l) => this.log(l),
    });
    const claude = new ClaudeAgent({
      exclude: () => this.pty.pids(),
      claudePath: opts.claudePath,
      home: this.home,
      env: this.env,
      systemdRun: this.scope,
      cldBin: this.cldBin,
      sessionPath: this.sessionPath,
      startMs: this.t.bgMs,
      stopMs: this.t.stopMs,
      spawnFn: opts.spawnFn,
      log: (l) => this.log(l),
    });
    this.agents = new Map([claude, this.pty, ...(opts.agents ?? [])].map((a) => [a.id, a]));
  }

  /** TERM-P1: the agents in our PTY host (the chat route joins their terminals there). */
  readonly pty: ClaudePtyAgent;

  /** The agent providers, by id (the assignments' `provider`). */
  private readonly agents: Map<string, AgentProvider>;

  /** The provider that drives `p` (its assignment's), or undefined when this build has none. */
  private agentOf(p: ProjectRecord): AgentProvider | undefined {
    return this.agents.get(p.provider ?? DEFAULT_PROVIDER);
  }

  /** TERM-P3 (ADR-0018): a new Claude agent runs in our PTY host. ponytail: a build without the
   *  host script (none ships so) keeps `claude --bg`, as before P1. */
  private newClaude(provider: string = DEFAULT_PROVIDER): string {
    return provider === DEFAULT_PROVIDER && this.opts.ptyHostScript ? CLAUDE_PTY_PROVIDER : provider;
  }

  /** TERM-P3: `name` runs in our PTY host (its permission prompts come from the hook, not a screen). */
  inPty(name: string): boolean {
    return this.find(name)?.provider === CLAUDE_PTY_PROVIDER;
  }

  /** ACP-1: `name` is an ACP agent (its permissions come as ACP requests, never off a screen). */
  isAcp(name: string): boolean {
    const p = this.find(name);
    return !!p && this.agentOf(p)?.protocol === 'acp';
  }

  /** D5: this build has provider `id` and it can start here (its CLI is installed). */
  providerReady(id: string): boolean {
    const agent = this.agents.get(id);
    return !!agent && !agent.ready?.();
  }

  /** AGENT-UPDATE: provider `id`'s CLI as the engine runs it (bin null: not installed) and its own
   *  update arguments; null when this build has no such provider or it cannot update itself. */
  agentCli(id: string): { bin: string | null; update: readonly string[] } | null {
    const agent = this.agents.get(id);
    const update = agent?.capabilities.update;
    return agent?.cliPath && update?.length ? { bin: agent.cliPath(), update } : null;
  }

  /** Why `p` cannot be started now: no provider in this build, or the provider's own reason. */
  private notReady(p: ProjectRecord): string | null {
    const agent = this.agentOf(p);
    if (!agent) return `no agent provider "${p.provider ?? DEFAULT_PROVIDER}" in this build`;
    return agent.ready?.() ?? null;
  }

  /** D5: a message to `name` the messenger must refuse (nothing queued), or null. */
  refuses(
    name: string,
    m: { from: string | null; source: string; group?: unknown },
  ): { code: 'unknown_provider' | 'no_direct_chat'; error: string } | null {
    const p = this.find(name);
    if (!p) return null;
    const agent = this.agentOf(p);
    if (!agent)
      return { code: 'unknown_provider', error: unknownProviderSend(p.provider ?? DEFAULT_PROVIDER) };
    // D5 (open question 1, MVP): a person talks to a 'run' Worker through its Lead or a room.
    if (agent.capabilities.lifetime === 'run' && !m.from && !m.group)
      return { code: 'no_direct_chat', error: NO_DIRECT_CHAT };
    return null;
  }

  /** D5: the message for `name` taken by its provider itself (a run), or null (the Typist's). */
  deliver(
    name: string,
    text: string,
    o: { task?: string; group?: { roomId: string; messageId: string }; messageId?: string; now?: boolean; force?: boolean },
  ): Promise<DeliverResult> | null {
    const p = this.find(name);
    const agent = p && this.agentOf(p);
    if (!p || !agent?.deliver) return null;
    return agent.deliver(p, text, {
      ...(o.task && { task: o.task }),
      ...(o.messageId && { messageId: o.messageId }),
      ...(o.now && { now: true }),
      ...(o.force && { force: true }),
      ...(o.group && { group: { id: o.group.roomId, messageId: o.group.messageId } }),
    });
  }

  /** Every provider's live sessions now. */
  private readLive(): Live[] {
    return [...this.agents.values()].flatMap((agent) => agent.live().map((s) => ({ ...s, agent })));
  }

  /** The environment jobs start from (T-0019): the sessions' clean one. */
  jobEnv(): NodeJS.ProcessEnv {
    return { ...this.env };
  }

  /** systemd-run when `claude` runs in scopes (jobs do the same), else null. */
  get scopeRunner(): string | null {
    return this.scope;
  }

  /** The durable identity of this agty installation, or null when its file is unsafe. */
  get hostId(): string | null {
    return this.hostIdentity;
  }

  /** Load the registry, watch the providers' live sessions, revive what was on. The
   *  office's first recompute (its own load) picks the projects up. */
  start(): void {
    this.hostIdentity = loadOrCreateHost(this.home, (line) => this.log(line)).hostId;
    this.recoverSwap();
    const loaded = loadRegistry(this.file);
    this.projects = loaded.projects;
    this.broken = loaded.broken;
    if (this.broken) this.log(`${this.file}: ${this.broken}; nothing is changed until it is fixed`);
    if (loaded.orphans.length)
      this.log(
        `${this.file}: ignoring ${loaded.orphans.length} assignment(s) without a project (${loaded.orphans.join(', ')}); the next save drops them`,
      );
    // D2: an older registry becomes projects.json v2 + assignments.json (order and rollback in
    // registry.ts), read-only too: read-only limits office actions, not the engine's own
    // bookkeeping (revive, conversation ids), which must be saved. A failed migration leaves the
    // registry unwritable, and nothing revived, until the next start.
    if (!this.broken) this.broken = migrateRegistry(this.file, loaded, (line) => this.log(line));
    this.watcher.reviveCause = this.bootChanged() ? 'reboot' : 'restart';
    if (!this.broken) this.recoverRename();
    if (!this.broken) this.resumeRenewals();
    this.refresh(false);
    for (const agent of this.agents.values())
      this.unwatch.push(
        agent.onChange(() => {
          if (this.debounce) clearTimeout(this.debounce);
          this.debounce = setTimeout(() => this.refresh(), this.t.debounceMs);
        }),
      );
    this.timers.push(
      setInterval(() => {
        this.refresh();
        try {
          this.opts.tick?.();
        } catch (err) {
          // A throw here would take down the daemon that runs every Lead (no unhandled handler).
          this.log(`tick: ${err instanceof Error ? err.message : String(err)}`);
        }
      }, this.t.safetyMs),
    );
    if (this.t.watchMs > 0) this.timers.push(setInterval(() => void this.watch(), this.t.watchMs));
    this.log(
      `${this.projects.length} projects; claude runs ${this.scope ? 'in a systemd user scope' : 'in a new session (setsid)'}`,
    );
    if (!this.broken) void this.revive();
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  dispose(): void {
    this.disposed = true;
    for (const stop of this.unwatch) stop();
    if (this.debounce) clearTimeout(this.debounce);
    for (const t of this.timers) clearTimeout(t);
  }

  /** Re-read the live sessions; tell the office when what it shows changed. */
  refresh(notify = true): void {
    this.live = this.readLive();
    this.followConversations();
    this.settleFailedRenewals();
    const live = new Set(this.projects.filter((p) => this.holder(p)).map((p) => p.name));
    for (const name of this.liveNames) {
      if (live.has(name)) continue;
      const p = this.find(name);
      if (p?.wantRunning && !this.running.has(name) && !this.renewals.has(name)) {
        this.watcher.lookForAdoption(p);
        continue;
      }
      this.watcher.dropAdoption(name);
      this.opts.event?.('orch_exit', 'engine', { name, code: null });
    }
    this.liveNames = new Set([...live, ...this.watcher.adoptionNames()]);
    this.compactions.check(this.projects, (p) => this.holder(p));
    const warnings = [...this.agents.values()]
      .map((a) => a.warning?.() ?? null)
      .filter((w): w is string => w !== null);
    for (const w of warnings) if (!this.daemonWarnings.includes(w)) this.log(`warning: ${w}`);
    this.daemonWarnings = warnings;
    // Keep the office running until the bounded re-look decides whether this
    // was a death or Claude Code's own daemon moving the same session to a new pid.
    if (this.watcher.adoptionNames().length) return;
    // A turn starting or ending (the files' status) changes the office's busy (T-0043).
    const sig = JSON.stringify([
      this.state(),
      this.live.map((l) => [l.sessionId, l.status]),
      this.renewals.names(),
      this.compactions.sigPart(),
    ]);
    if (sig === this.sig) return;
    this.sig = sig;
    if (notify) this.opts.changed?.();
  }

  /**
   * A project's conversation id follows its live background session (its name
   * in its folder): /clear, /background and the like start a new id, and a
   * revive must not pick up an older branch (handoff §2-2).
   */
  private followConversations(): void {
    if (this.broken) return;
    for (const p of this.projects) {
      const mine = this.live.filter(
        (s) => this.claims(p, s) && !this.contested(p, (q) => this.claims(q, s), s.name, s.sessionId),
      );
      // D5 (6.2): the job it is bound to (the id its start printed) while that one lives, even
      // beside a newer session of the same name ('alpha (2)'); a /clear keeps the job, new id.
      const bg = mine.find((s) => !!s.id && s.id === p.backgroundId) ?? newest(mine);
      if (!bg || (bg.sessionId === p.sessionId && bg.id === p.backgroundId)) continue;
      if (bg.sessionId !== p.sessionId)
        this.log(
          `"${p.name}": conversation ${p.sessionId?.slice(0, 8) ?? '-'} -> ${bg.sessionId.slice(0, 8)}`,
        );
      try {
        this.patch(p.name, {
          sessionId: bg.sessionId,
          ...(bg.id && { backgroundId: bg.id }),
          idleRetired: false,
        });
        // PROJECT-DATA: a /clear or a resume's copy: the link 대화방 지우기 follows back.
        if (p.sessionId && bg.sessionId !== p.sessionId)
          this.opts.event?.('orch_follow', 'engine', {
            name: p.name,
            old_session_id: p.sessionId,
            session_id: bg.sessionId,
          });
      } catch (err) {
        this.log(`could not save ${this.file}: ${String(err)}`);
      }
    }
  }

  /** K1 (B4): a failed renew whose new conversation is up after all (the daemon died before the
   *  registry took its id, or the start gave up waiting for it): its own background session under
   *  another conversation than the one the renew left is that new one, so the renew is over. */
  private settleFailedRenewals(): void {
    for (const f of this.renewals.failedList()) {
      const p = this.find(f.name);
      const h = p && this.holder(p);
      if (p && h?.kind === 'background' && !h.resting && h.sessionId && h.sessionId !== f.oldSessionId)
        this.renewals.recovered(p, h.sessionId);
    }
  }

  /** Every registered project's folder (T-0020's repository panel); not a Worker's. */
  folders(): Array<{ name: string; folder: string }> {
    return this.leads().map((p) => ({ name: p.name, folder: p.folder }));
  }

  /** RQ4: a project's spec workflow switch and the agent CLIs its agents run (Lead first), or
   *  null when it is not one of the engine's projects. */
  specWorkflow(project: string): { on: boolean; clis: string[] } | null {
    const lead = this.leads().find((p) => p.name === project);
    if (!lead) return null;
    const clis = [lead, ...this.projects.filter((p) => p.role && p.projectId === lead.projectId)].map(cliOf);
    return { on: lead.specWorkflow === 'speckit', clis: [...new Set(clis)] };
  }

  /** RQ4: switch it; its agents get the layer from their next start. false: not saved. */
  setSpecWorkflow(project: string, on: boolean): boolean {
    const lead = this.leads().find((p) => p.name === project);
    if (!lead) return false;
    if ((lead.specWorkflow === 'speckit') === on) return true;
    try {
      this.commit(
        this.projects.map((x) => {
          if (x !== lead) return x;
          const next: ProjectRecord = { ...x, specWorkflow: 'speckit' };
          if (!on) delete next.specWorkflow;
          return next;
        }),
      );
      return true;
    } catch (err) {
      this.log(`spec workflow ${project}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** An agent's own folder (a Worker may work in a worktree), or undefined. */
  folderOf(name: string): string | undefined {
    return this.find(name)?.folder;
  }

  /** T-70: `name`'s record works in `folder` (a running session started there). */
  worksIn(name: string, folder: string): boolean {
    const p = this.find(name);
    return !!p && samePath(p.folder, folder, this.host);
  }

  // ── T-0019: what agty send, job and renew ask ─────────────

  /** D3: every agent's name, the Leads' (= their projects' names) first, then the Workers'.
   *  A name is an address: a DM, a room member, a queue, an inbox, a token. */
  names(): string[] {
    return this.projects.map((p) => p.name);
  }

  /** Why the registry could not be read (nothing in it may be taken as gone), or null. */
  registryProblem(): string | null {
    return this.broken;
  }

  /** The projects' names (= their Leads'). */
  projectNames(): string[] {
    return this.leads().map((p) => p.name);
  }

  /** D3: the project an agent works for (a Lead's is its own name), or null. Codex tasks,
   *  jobs and GPU reservations keep the project's name as their attribution. */
  projectOf(name: string): string | null {
    const p = this.find(name);
    if (!p) return null;
    return p.role ? (this.leads().find((l) => l.projectId === p.projectId)?.name ?? null) : p.name;
  }

  private leads(): ProjectRecord[] {
    return this.projects.filter((p) => !p.role);
  }

  /** A new Lead's model and effort where the request names none (leadDefaults.ts): the Leads'
   *  common pair, else the installed Claude Code's top model and effort. An empty one is kept. */
  private leadLaunch(req: Pick<EngineAction, 'model' | 'effort'> = {}): Partial<ProjectRecord> {
    const d = leadDefaults(this.leads(), this.agentChoices.discover().claude);
    return {
      ...(req.model === undefined && d.model && { model: d.model }),
      ...(req.effort === undefined && d.effort && { effort: d.effort }),
    };
  }

  /** The project whose folder holds `cwd` (the longest folder wins), or null. "Which project"
   *  only: which agent is calling comes from its token (S7), never from cwd. */
  projectAt(cwd: string): string | null {
    const real = (p: string) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    };
    const here = real(cwd);
    let best: ProjectRecord | null = null;
    for (const p of this.leads()) {
      const f = real(p.folder);
      if (
        (here === f || here.startsWith(f.endsWith(path.sep) ? f : f + path.sep)) &&
        (!best || f.length > real(best.folder).length)
      )
        best = p;
    }
    return best?.name ?? null;
  }

  /**
   * A project's session now (fresh from its provider): its background
   * job's id, status and transcript, 'terminal' when the conversation is open in a
   * terminal (nothing types into that), or null when it is off.
   */
  sessionOf(
    name: string,
  ): { id: string; status?: string; transcript?: string } | 'terminal' | null {
    const p = this.find(name);
    if (!p) return null;
    this.live = this.readLive();
    const h = this.holder(p);
    if (!h) return null;
    const open = this.live.some((s) => s.kind !== 'background' && s.sessionId === h.sessionId);
    if (h.kind !== 'background' || !h.id || open) return 'terminal';
    return {
      id: h.id,
      ...(h.status && { status: h.status }),
      transcript: h.agent.transcript(h),
    };
  }

  /**
   * REPLY-FULL: the message reply `id` names, as `name`'s live session has it: 'recent' (in its
   * context still), its text (sent before this session started or before its last compaction:
   * the compaction summed it up), 'missing' (not found: its records are gone), or null (no live
   * session, no start time or no compaction mark to tell by).
   */
  async replied(name: string, id: string): Promise<'recent' | 'missing' | { text: string } | null> {
    const p = this.find(name);
    if (!p) return null;
    this.live = this.readLive();
    const h = this.holder(p);
    const mark = h?.agent.compaction?.mark;
    if (!h || h.kind !== 'background' || h.startedAt === undefined || !mark) return null;
    return repliedState(h.agent.transcript(h), id, mark, h.startedAt).catch(() => null);
  }

  /** C5a: every agent as the MCP tools see it (list_agents, the scope checks). */
  roster(): RosterAgent[] {
    this.live = this.readLive();
    return this.projects.map((p) => {
      const h = this.holder(p);
      return {
        name: p.name,
        project: this.projectOf(p.name),
        role: p.role ?? 'lead',
        assignmentId: (p.role ? p.assignmentId : p.leadAssignmentId) ?? null,
        provider: cliOf(p),
        ...(p.model && { model: p.model }),
        wantRunning: p.wantRunning,
        // D5: a resting session runs nothing (B 9.3: down, and a delegation takes it up).
        live: !!h && !h.resting,
        busy: h ? h.status === 'busy' : null,
      };
    });
  }

  /** The messenger holds `name`'s messages (no typing): a renew is between its turn's end and
   *  the new conversation, or (D3b) a Lead swap holds the name (they queue, and the swap's
   *  re-addressing routes them by its cut-off). */
  renewing(name: string): boolean {
    return this.renewals.has(name) || this.swapping.has(name);
  }

  /** K1 (B2): a v1 renew's first message: the safety lines, the handoff as written, then the work
   *  basis the engine reads now (the old session, git, task worktrees, and the Lead swap
   *  briefing's lines). Never rejects: what cannot be read is left out. */
  private async renewCompose(p: ProjectRecord, r: RenewRecord, h: Live | null) {
    const now = Date.now();
    const format = r.format ?? handoffFormat(r.message);
    const oldId = r.oldSessionId ?? null;
    const project = (p.role ? this.leadOf(p)?.name : p.name) ?? p.name;
    let transcript: string | null = null;
    let base: { head: string | null; branch: string | null } = { head: null, branch: null };
    let basis = '';
    let taskIds = new Set<string>();
    let folder = p.folder;
    try {
      const agent = this.agentOf(p);
      transcript = h ? h.agent.transcript(h) : agent && oldId ? agent.transcript({ cwd: p.folder, sessionId: oldId }) : null;
      folder = h?.cwd ?? p.folder;
      const brief = this.opts.briefing?.(project) ?? { tasks: [], running: [], events: [] };
      taskIds = new Set(brief.tasks.map((t) => t.id));
      const head = (g: Awaited<ReturnType<typeof gitSummary>>) => g?.recent[0]?.hash.slice(0, 7) ?? null;
      const records = readRecords(path.join(configDir(this.home), 'worktrees.json'))
        .filter((w) => w.project === project && w.status === 'active')
        .slice(0, RENEW_WORKTREES_MAX);
      const [git, ...trees] = await Promise.all([
        gitSummary(folder).catch(() => null),
        ...records.map((w) => gitSummary(w.path).catch(() => null)),
      ]);
      base = { head: head(git), branch: git?.branch ?? null };
      const team = this.projects.filter((x) => x.projectId === p.projectId);
      basis = fitBriefing(
        {
          now,
          project,
          tasks: brief.tasks,
          nameOf: (id) => team.find((x) => (x.role ? x.assignmentId : x.leadAssignmentId) === id)?.name,
          running: brief.running,
          workers: team.filter((x) => x.role).map((x) => ({ name: x.name, role: x.role!, on: !!this.holder(x) })),
          events: eventLines(brief.events, team.map((x) => x.name), now),
        },
        (lines) =>
          [
            ...basisLines({
              oldSessionId: oldId,
              transcript,
              folder,
              git: git ? { ...base, changed: git.dirty ?? null } : null,
              worktrees: records.map((w, i) => ({ path: w.path, branch: trees[i]?.branch ?? w.branch, head: head(trees[i] ?? null) })),
            }),
            ...lines,
          ].join('\n'),
      );
    } catch (err) {
      this.log(`renew "${p.name}": work basis not read (${err instanceof Error ? err.message : String(err)})`);
    }
    const text = renewPrompt({ when: shortStamp(now), handoff: r.message, file: r.file ?? null, format, basis });
    this.git ??= createGitRunner();
    const refs = await keepCommits(handoffRefs(r.message, taskIds, p.name), this.git, folder);
    return { text, base, refs, transcript };
  }

  /** K1 (B4): `name`'s last renew could not start a new conversation; its next start does. */
  renewFailed(name: string): boolean {
    return this.renewals.failedStart(name);
  }

  /** RENEW-STUCK: a renewal of `name` is pending (the office row's `renewing`). */
  renewPending(name: string): boolean {
    return this.renewals.has(name);
  }

  /** COMPACT-COFFEE: `name` compacts its conversation now (the office row's `compacting`): its
   *  spinner was on the screen at the last look, and no compact_boundary came since. */
  compacting(name: string): boolean {
    const at = this.compactingSeen.get(name);
    const p = at === undefined ? undefined : this.find(name);
    const h = p ? this.holder(p) : null;
    return !!h && this.compactions.countFor(name, h.sessionId) === at;
  }

  /**
   * COMPACT-COFFEE: one look at the screens we keep (agents with `compacting`, working ones only),
   * while someone watches the office (its caller's timer); true when what the rows say changed.
   * `off`: nobody watches any more, forget them.
   */
  async lookForCompacting(off = false): Promise<boolean> {
    const before = JSON.stringify(this.projects.map((p) => this.compacting(p.name)));
    if (off) this.compactingSeen.clear();
    for (const p of off ? [] : this.projects) {
      const h = this.holder(p);
      let on = false;
      try {
        on = !!h && h.kind === 'background' && !h.resting && ((await h.agent.compacting?.(h)) ?? false);
      } catch {
        // a look that failed is no compaction
      }
      if (!on || !h) this.compactingSeen.delete(p.name);
      else if (!this.compactingSeen.has(p.name))
        this.compactingSeen.set(p.name, this.compactions.countFor(p.name, h.sessionId));
    }
    return JSON.stringify(this.projects.map((p) => this.compacting(p.name))) !== before;
  }

  /** A messenger message wakes only a project Claude retired for idleness.
   * The caller then types that original message into the resumed session, so
   * there is no automatic recovery turn in front of it. */
  async wake(name: string): Promise<boolean> {
    // Nothing is started that could not be saved (commit refuses a broken registry).
    if (this.broken) {
      this.log(`wake "${name}": not started (${this.file}: ${this.broken})`);
      return false;
    }
    let p = this.find(name);
    if (!p || !p.wantRunning || !this.watcher.retiredForIdleness(p) || this.running.has(name)) return false;
    this.running.add(name);
    let out: Outcome;
    try {
      out = await this.enqueue(async () => {
        this.refresh();
        p = this.find(name);
        if (!p || !p.wantRunning || this.holder(p)) return { ok: false, error: 'already live' };
        if (!this.watcher.retiredForIdleness(p)) return { ok: false, error: 'not resting' };
        return this.startProject(p, 'messenger');
      });
    } catch (err) {
      out = fail(err instanceof Error ? err.message : String(err));
    } finally {
      this.running.delete(name);
    }
    this.log(`wake "${name}": ${out.ok ? `ok bg=${out.bgId ?? '-'}` : `failed (${out.error})`}`);
    this.refresh();
    return out.ok;
  }

  /**
   * A message already filed in the inbox starts only a project the person left
   * off (or has never started). An idle retirement resumes through wake(), and
   * a crash-loop marker is cleared only by the person's own start/stop action.
   */
  async startFromInbox(name: string): Promise<boolean> {
    if (this.broken) {
      this.log(`inbox start "${name}": not started (${this.file}: ${this.broken})`);
      return false;
    }
    let p = this.find(name);
    if (
      !p ||
      p.wantRunning ||
      this.watcher.retiredForIdleness(p) ||
      this.guard.gaveUp(name) !== undefined ||
      this.running.has(name) ||
      this.renewals.has(name)
    )
      return false;
    this.running.add(name);
    let out: Outcome;
    try {
      out = await this.enqueue(async () => {
        this.refresh();
        p = this.find(name);
        if (
          !p ||
          p.wantRunning ||
          this.watcher.retiredForIdleness(p) ||
          this.guard.gaveUp(name) !== undefined ||
          this.holder(p)
        )
          return { ok: false, error: 'not ordinarily off' };
        return this.startProject(p, 'messenger');
      });
    } catch (err) {
      out = fail(err instanceof Error ? err.message : String(err));
    } finally {
      this.running.delete(name);
    }
    this.log(`inbox start "${name}": ${out.ok ? `ok bg=${out.bgId ?? '-'}` : `failed (${out.error})`}`);
    this.refresh();
    return out.ok;
  }

  /** The messenger asks this just before an attach: the session waits on something only its
   *  terminal can answer (its provider's held()). */
  async held(name: string): Promise<boolean> {
    const p = this.find(name);
    if (!p) return false;
    this.live = this.readLive();
    const h = this.holder(p);
    if (!h || h.kind !== 'background' || !h.id) return false;
    return h.agent.held(h);
  }

  /**
   * agty renew, called by the orchestrator as its turn's last
   * step. Answers at once; then, once that turn is over: the handoff into the
   * inbox, the old session stopped and gone, a new conversation under the same
   * name (stopping first: two live sessions of one name make Claude call the
   * new one "<name> (2)"), whose first message is the inbox. A failed start
   * loses nothing: the handoff waits in the inbox, the old conversation can
   * be resumed.
   */
  renew(
    name: string,
    handoff: string,
    source: string,
    file: string | null = null,
  ): { ok: true } | { ok: false; code: string; error: string } {
    return this.renewals.request(name, handoff, source, file);
  }

  /** RENAME: the pending renames by assignment id (a rename is for that agent, whatever answers
   *  to its name meanwhile): its name when asked, and the new one. */
  private readonly renames = new Map<string, { from: string; to: string }>();
  /** RENAME: the last rename's run (tests await it). */
  renameRun: Promise<void> = Promise.resolve();

  /** An agent's own assignment id (a Lead's is its project's lead assignment). */
  private static assignmentOf(p: ProjectRecord): string | undefined {
    return p.role ? p.assignmentId : p.leadAssignmentId;
  }

  private byAssignment(id: string): ProjectRecord | undefined {
    return this.projects.find((x) => Engine.assignmentOf(x) === id);
  }

  /**
   * RENAME: `agty rename`. Accepted at once (an agent renames itself mid-turn); applied once the
   * agent's turn is over, like renew: its session stopped, the registry and every store keyed by
   * the name moved (projectData, never onto a name that has data of its own), then started again
   * as `-n <to> --resume <its conversation>` (our PTY host keeps the id; `claude --bg` continues
   * it in a copy). The rename is bound to the agent's assignment: if that agent is gone or answers
   * to another name by then, it is dropped. A journal (rename-journal.json) makes a crash after
   * the registry roll forward at the next start. One orch_rename event says how it went, with the
   * stores that did not follow. ponytail: a rename still waiting for its turn lives in memory; a
   * daemon restart before the turn ends forgets it (no orch_rename line): ask again.
   */
  rename(
    name: string,
    to: string,
    source: string,
  ): { ok: true } | { ok: false; code: string; error: string } {
    const no = (code: string, error: string) => ({ ok: false as const, code, error });
    if (this.opts.readOnly) return no('read_only', koText('read_only_mode'));
    if (this.broken) return no('daemon_error', koText('registry_unreadable'));
    const p = this.find(name);
    const id = p && Engine.assignmentOf(p);
    if (!p || !id) return no('unknown_project', koText('project_unknown', { name }));
    const bad = checkName(to);
    if (bad) return no('usage', bad);
    if (to === name) return no('usage', koText('rename_same', { name }));
    if (this.find(to) || this.projectNames().includes(to) || [...this.renames.values()].some((r) => r.to === to))
      return no('name_taken', koText('name_taken'));
    if (this.renames.has(id)) return no('rename_pending', koText('rename_pending', { name }));
    if (this.running.has(name) || this.swapping.has(name)) return no('busy', koText('project_busy_quoted', { name }));
    if (this.renewals.has(name)) return no('renew_pending', koText('project_renewing', { name }));
    const taken = takenBy(this.home, to);
    if (taken.length) return no('name_taken', koText('rename_data_exists', { name: to, stores: taken.join(', ') }));
    const clash = this.sessionClash(this.renamedList(p, to), [to]);
    if (clash) return no('session_clash', clash);
    this.renames.set(id, { from: name, to });
    this.renameRun = this.renameWhenIdle(id, name, to, source).finally(() => this.renames.delete(id));
    this.log(`rename "${name}" -> "${to}": waiting for the turn to end`);
    return { ok: true };
  }

  /** The registry with `p` under `to` (a title that was only its name goes: -n follows the name). */
  private renamedList(p: ProjectRecord, to: string): ProjectRecord[] {
    const next: ProjectRecord = { ...p, name: to };
    if (next.title === p.name) delete next.title;
    return this.projects.map((x) => (x === p ? next : x));
  }

  /** The agent of assignment `id`, while it still answers to `from`. */
  private renameTarget(id: string, from: string): ProjectRecord | undefined {
    const p = this.byAssignment(id);
    return p?.name === from ? p : undefined;
  }

  private async renameWhenIdle(id: string, from: string, to: string, source: string): Promise<void> {
    const end = Date.now() + this.t.renewWaitMs;
    let oldSession: string | undefined;
    const finish = (out: Outcome & { notMoved?: string[] }) => {
      this.log(`rename "${from}" -> "${to}": ${out.ok ? 'ok' : `failed (${out.error})`}${out.notMoved?.length ? `; not moved: ${out.notMoved.join(', ')}` : ''}`);
      const now = this.byAssignment(id)?.sessionId;
      this.opts.event?.('orch_rename', source, {
        name: from,
        to,
        ok: out.ok,
        ...(out.ok && now && { session_id: now }),
        // 대화방 지우기 follows a copy back to the conversation it continued.
        ...(out.ok && now && oldSession && now !== oldSession && { old_session_id: oldSession }),
        ...(out.notMoved?.length && { not_moved: out.notMoved }),
        ...(!out.ok && { code: out.code ?? 'failed', error: out.error }),
      });
      this.refresh();
    };
    const gone = () => finish({ ...fail(koText('project_unknown', { name: from })), code: 'gone' });
    // 1. The turn ends (as renew waits for it).
    for (;;) {
      if (this.disposed) return;
      this.live = this.readLive();
      const p = this.renameTarget(id, from);
      if (!p) return gone();
      const h = this.holder(p);
      if (h && h.kind !== 'background') return finish({ ...fail(koText('rename_terminal')), code: 'terminal' });
      if (!h || turnEnded(h.status)) break;
      if (Date.now() >= end) return finish({ ...fail(koText('rename_not_idle')), code: 'not_idle' });
      await this.sleep(this.t.renewPollMs);
    }
    // 2. Stopped, moved, started again under the new name (one action at a time; both names held).
    const held = [from, to];
    held.forEach((n) => (this.running.add(n), this.swapping.add(n)));
    let out: Outcome & { notMoved?: string[] };
    try {
      out = await this.enqueue(async () => {
        oldSession = this.renameTarget(id, from)?.sessionId;
        return this.renameNow(id, from, to, source);
      });
    } catch (err) {
      out = fail(err instanceof Error ? err.message : String(err));
    } finally {
      held.forEach((n) => (this.running.delete(n), this.swapping.delete(n)));
    }
    finish(out);
  }

  private async renameNow(id: string, from: string, to: string, source: string): Promise<Outcome & { notMoved?: string[] }> {
    this.refresh();
    const p = this.renameTarget(id, from);
    if (!p) return { ...fail(koText('project_unknown', { name: from })), code: 'gone' };
    // A renew and a rename of one agent are exclusive (each refuses the other when asked).
    if (this.renewals.has(from)) return { ...fail(koText('project_renewing', { name: from })), code: 'renew_pending' };
    if (this.find(to)) return fail(koText('name_taken'));
    const taken = takenBy(this.home, to);
    if (taken.length) return fail(koText('rename_data_exists', { name: to, stores: taken.join(', ') }));
    const list = this.renamedList(p, to);
    const clash = this.sessionClash(list, [to]);
    if (clash) return fail(clash);
    const h = this.holder(p);
    const wasOn = !!h;
    if (h) {
      const r = await this.stopSession(h);
      if (!r.ok) return r;
    }
    const at = Date.now();
    try {
      writeRenameJournal(this.home, { v: 1, from, to, assignmentId: id, at });
      this.commit(list);
    } catch (err) {
      // Nothing moved: the old session comes back as it was.
      clearRenameJournal(this.home);
      if (wasOn) await this.startProject(p, source);
      return fail(koText('registry_save_failed', { why: err instanceof Error ? err.message : String(err) }));
    }
    this.tokens.drop(from); // its session's token; the start issues one for the new name
    this.forgetSession(from);
    const notMoved = this.finishRename(from, to, at, false);
    if (!wasOn) return { ok: true, notMoved };
    // `flags`: -n <to>, its options and a fresh token with --resume <its conversation>.
    const started = await this.startProject(this.find(to)!, source, false, true);
    return { ...started, notMoved };
  }

  /** After the registry: the name history, then the stores (`force`: a roll-forward, some may
   *  have moved already), then the journal goes. The stores that did not follow. */
  private finishRename(from: string, to: string, at: number, force: boolean): string[] {
    const notMoved: string[] = [];
    try {
      recordFormerName(this.home, { name: from, until: at, as: to });
    } catch (err) {
      notMoved.push('name-history.json');
      this.log(`rename "${from}": name-history.json: ${String(err)}`);
    }
    try {
      notMoved.push(...this.dataChange(() => moveProjectData(this.home, from, to, (l) => this.log(l), force), [from, to]));
    } catch (err) {
      // NameTaken: something wrote data under the new name since the check; nothing was moved.
      notMoved.push(...(err instanceof NameTaken ? err.stores : ['projectData']));
      this.log(`rename "${from}" -> "${to}": stores not moved (${String(err)})`);
    }
    clearRenameJournal(this.home);
    return notMoved;
  }

  /** start(): a rename the last daemon committed but did not finish rolls forward; one cut short
   *  before its registry write is dropped (nothing had moved). */
  private recoverRename(): void {
    if (this.opts.readOnly) return;
    const j = readRenameJournal(this.home);
    if (!j) return;
    const p = this.byAssignment(j.assignmentId);
    if (p?.name === j.to) {
      const notMoved = this.finishRename(j.from, j.to, j.at, true);
      this.log(`rename "${j.from}" -> "${j.to}": finished at start${notMoved.length ? `; not moved: ${notMoved.join(', ')}` : ''}`);
    } else {
      clearRenameJournal(this.home);
      this.log(`rename "${j.from}" -> "${j.to}": cut short before the registry; dropped`);
    }
  }

  /** projectData's change between the office's flush and reload (opts.projectData), then the
   *  engine's own copy of revive-guard.json read again. The stores that did not follow. */
  private dataChange(change: () => string[], names: string[]): string[] {
    const failed = this.opts.projectData ? this.opts.projectData(change, names) : change();
    this.guard.reload();
    return failed;
  }

  /** start(): every renewal a stopped daemon left pending goes on where it was. */
  private resumeRenewals(): void {
    this.renewals.resume();
  }

  /** Did the machine boot since the last daemon start? (The marker is rewritten.) */
  private bootChanged(): boolean {
    const file = path.join(path.dirname(this.file), 'engine.boot');
    let boot: string;
    try {
      boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
    } catch {
      boot = `t${Math.round((Date.now() - os.uptime() * 1000) / 60_000)}`;
    }
    let before: string | null = null;
    try {
      before = fs.readFileSync(file, 'utf-8').trim();
    } catch {
      /* first start */
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, `${boot}\n`, { mode: 0o600 });
    } catch {
      /* the next start guesses again */
    }
    return before !== boot;
  }

  private find(name: string): ProjectRecord | undefined {
    return this.projects.find((p) => p.name === name);
  }

  /** The live session that is this project's (see holderOf in sessionMatch.ts). */
  private holder(p: ProjectRecord): Live | null {
    return holderOf(this.matchCtx(), p);
  }

  private claims(q: ProjectRecord, s: Live): boolean {
    return claims(this.matchCtx(), q, s);
  }

  private claimsName(q: ProjectRecord, name: string | null | undefined, dir: string): boolean {
    return claimsName(this.matchCtx(), q, name, dir);
  }

  private collide(a: ProjectRecord, b: ProjectRecord): boolean {
    return collide(this.matchCtx(), a, b);
  }

  private contested(
    p: ProjectRecord,
    claimedBy: (q: ProjectRecord) => boolean,
    name: string | null | undefined,
    sessionId: string | null | undefined,
  ): boolean {
    return contested(this.matchCtx(), p, claimedBy, name, sessionId);
  }

  /** What the sessionMatch functions read, taken fresh each call (projects and live are reassigned). */
  private matchCtx(): MatchCtx {
    return {
      projects: this.projects,
      live: this.live,
      agentOf: (p) => this.agentOf(p),
      host: this.host,
      logged: this.contestedLogged,
      log: (line) => this.log(line),
    };
  }

  state(): EngineState {
    return engineState(this.stateCtx());
  }

  /** What engineState() reads, taken fresh each call (projects and the registry state are reassigned). */
  private stateCtx(): StateCtx {
    return {
      projects: this.projects,
      file: this.file,
      broken: this.broken,
      daemonWarnings: this.daemonWarnings,
      swapUnfinished: SWAP_UNFINISHED,
      agentChoices: this.agentChoices,
      holder: (p) => this.holder(p),
      projectOf: (name) => this.projectOf(name),
      gaveUp: (name) => this.guard.gaveUp(name),
      agentOf: (p) => this.agentOf(p),
      agents: () => this.agents.values(),
      unknownProvider,
      untrusted: this.untrusted,
      trusting: this.trusting,
      moveAllRun: this.moveAllRun,
    };
  }

  /** Re-read public CLI settings on explicit request; never credentials. */
  refreshAgentChoices(): EngineState {
    this.agentChoices.discover(true);
    return this.state();
  }

  /** Scan only folders under HOME, using Claude's own session index. */
  scanImport(folder: string, privileged: boolean) {
    if (!privileged) throw new Error(koText('no_permission'));
    if (this.opts.readOnly) throw new Error(koText('read_only_mode'));
    this.live = this.readLive();
    return scanProjects(folder, this.host, this.projects, this.live);
  }

  async importProjects(
    requestId: string,
    folder: string,
    rows: ProjectImportRow[],
    privileged: boolean,
  ): Promise<ProjectImportResult> {
    const result: ProjectImportResult = { type: 'projectImportResult', requestId, rows: [] };
    if (!privileged || this.opts.readOnly || this.broken) {
      const reason = !privileged
        ? koText('no_permission')
        : this.opts.readOnly
          ? koText('read_only_mode')
          : koText('registry_unreadable_short');
      result.rows = rows.map((r) => ({ folder: r.folder, name: r.name, status: 'failed', reason }));
      return result;
    }
    let candidates: ReturnType<typeof scanProjects>;
    try {
      candidates = this.scanImport(folder, privileged);
    } catch (e) {
      result.rows = rows.map((r) => ({
        folder: r.folder,
        name: r.name,
        status: 'failed',
        reason: e instanceof Error ? e.message : koText('folder_unreadable'),
      }));
      return result;
    }
    const added: string[] = [];
    // Imported Leads start with the same model and effort as one added in the form.
    const launch = this.leadLaunch();
    for (const row of rows.slice(0, 100)) {
      const candidate = candidates.find((c) => samePath(c.folder, row.folder, this.host));
      let reason: string | null = null;
      if (!candidate) reason = koText('import_not_found');
      else if (
        this.projects.some(
          (p) =>
            samePath(p.folder, candidate.folder, this.host) ||
            (!!candidate.sessionId && p.sessionId === candidate.sessionId),
        )
      ) {
        result.rows.push({
          folder: row.folder,
          name: row.name,
          status: 'skipped',
          reason: koText('import_registered'),
        });
        continue;
      } else reason = checkName(row.name) || CHECK.room(row.room);
      if (!reason && this.find(row.name)) reason = koText('name_taken');
      if (reason || !candidate) {
        result.rows.push({
          folder: row.folder,
          name: row.name,
          status: 'failed',
          reason: reason ?? koText('folder_unreadable'),
        });
        continue;
      }
      const holder = this.live.find(
        (s) => s.kind === 'background' && samePath(s.cwd, candidate.folder, this.host),
      );
      const sessionId = holder?.sessionId ?? (row.resume ? candidate.sessionId : undefined);
      // TERM-P3: in our PTY host, unless a `claude --bg` session holds that conversation now (two
      // processes on one conversation): that one keeps it, and the move takes it over later.
      const provider = holder && holder.agent.id !== CLAUDE_PTY_PROVIDER ? DEFAULT_PROVIDER : this.newClaude();
      try {
        this.commit([
          ...this.projects,
          {
            projectId: createProjectId(),
            leadAssignmentId: createAssignmentId(),
            ...seededPermission(this.home), // O4: the owner's default for new agents
            ...launch,
            name: row.name,
            folder: candidate.folder,
            room: row.room.trim(),
            wantRunning: false,
            ...(sessionId && { sessionId }),
            ...(provider !== DEFAULT_PROVIDER && { provider }),
          },
        ]);
        added.push(row.name);
        result.rows.push({ folder: row.folder, name: row.name, status: 'added' });
        this.refresh();
        if (row.start) {
          const started = await this.run(
            {
              type: 'engineAction',
              requestId: `${requestId}:${row.name}`,
              action: 'start',
              name: row.name,
            },
            privileged,
          );
          if (!started.ok)
            result.rows[result.rows.length - 1].reason =
              koText('import_start_failed', { why: started.error ?? '' });
        }
      } catch {
        result.rows.push({
          folder: row.folder,
          name: row.name,
          status: 'failed',
          reason: koText('registry_save_failed'),
        });
      }
    }
    if (added.length) {
      const id = randomUUID();
      this.recentImport = { id, names: added };
      result.batchId = id;
      this.refresh();
    }
    return result;
  }

  undoImport(requestId: string, batchId: string, privileged: boolean): ProjectImportResult {
    const result: ProjectImportResult = { type: 'projectImportResult', requestId, rows: [] };
    if (!privileged || this.opts.readOnly || this.broken || this.recentImport?.id !== batchId)
      return result;
    const names = this.recentImport.names;
    result.rows = this.leads()
      .filter((p) => names.includes(p.name))
      .map((p) => ({ folder: p.folder, name: p.name, status: 'removed' as const }));
    // A Worker added since goes with its project.
    this.commit(this.projects.filter((p) => !names.includes(this.projectOf(p.name) ?? '')));
    this.recentImport = null;
    this.refresh();
    return result;
  }

  private busyOf(h: Live, fallback: boolean | null, rowTranscript?: string | null) {
    return this.turns.busyOf(h, fallback, rowTranscript);
  }

  /**
   * The office with one entry per project (key `engine:<name>`) in its room;
   * the Claude provider's rows of the same conversation fold into it (also the
   * pid-less rows `claude agents --json` keeps after a reboot).
   */
  apply(world: World): World {
    return applyEngine(world, {
      projects: this.projects,
      holder: (p) => this.holder(p),
      claimsName: (q, name, dir) => this.claimsName(q, name, dir),
      contested: (p, claimedBy, name, sessionId) => this.contested(p, claimedBy, name, sessionId),
      compactionsFor: (name, sessionId) => this.compactions.countFor(name, sessionId),
      busyOf: (h, fallback, rowTranscript) => this.busyOf(h, fallback, rowTranscript),
      opsRoom: OPS_ROOM,
    });
  }

  /** An `engineMoveAll` from a client (privileged only, checked again here): start or stop the queue. */
  handleMoveAll(msg: Record<string, unknown>, send: WsSend, privileged: boolean): void {
    const r = msg.stop === true ? this.moveAllStop(privileged) : this.moveAll(privileged);
    send({ type: 'engineMoveAllResult', ok: r.ok, ...('error' in r && r.error && { error: r.error }) });
  }

  /** An `engineAction` from a client: run it and answer the sender. */
  handle(
    msg: Record<string, unknown>,
    send: WsSend,
    privileged: boolean,
    device = 'web',
    stepUp?: SocketStepUp,
  ): void {
    const req = parseEngineAction(msg);
    if (!req) {
      this.log('malformed engineAction dropped');
      return;
    }
    if (stepUp?.remote && this.needsStepUp(req) && !stepUp.fresh()) {
      this.log(`action ${req.action} ${JSON.stringify(req.name).slice(0, 66)} gui:${device}: step-up needed`);
      const { requestId, action, name } = req;
      send({ type: 'engineActionResult', requestId, action, name, ok: false, error: STEPUP_REQUIRED });
      return;
    }
    // A person in the office (the /ws path): their 켜기 may answer the folder trust question.
    void this.run(req, privileged, device, true).then((r) => send({ ...r }));
  }

  /**
   * S1: what a remote session may not do on a cookie alone -- a different
   * permission mode, rules file or project folder (set at add too), or a start
   * with no conversation to resume (a fresh one).
   */
  private needsStepUp(req: EngineAction): boolean {
    const p = this.find(req.name);
    if (req.action === 'start' || req.action === 'restart') return !!p && !p.sessionId;
    // D3b: the new Lead starts a fresh conversation.
    if (req.action === 'promote') return true;
    if (req.action !== 'add' && req.action !== 'edit') return false;
    const norm = (v: string) => {
      const n = normalizeProjectPath(v, this.host);
      return 'error' in n ? undefined : n.path;
    };
    if ((req.permissionMode?.trim() ?? p?.permissionMode ?? '') !== (p?.permissionMode ?? ''))
      return true;
    if (req.rulesFile !== undefined && (req.rulesFile.trim() ? norm(req.rulesFile.trim()) : '') !== (p?.rulesFile ?? ''))
      return true;
    const folder = req.action === 'edit' && p && req.folder !== undefined ? norm(req.folder) : undefined;
    return !!p && !!folder && !samePath(folder, p.folder, this.host);
  }

  /** Never rejects: refusals and failures are `ok: false` results. `person` (AUTO-TRUST): a
   *  person pressed it in the office, so a start may answer Claude's folder trust question; the
   *  CLI, MCP tools, revive and the watch never pass it. */
  async run(
    req: EngineAction,
    privileged: boolean,
    device = 'web',
    person = false,
  ): Promise<EngineActionResult> {
    const { requestId, action, name } = req;
    const what = `${action} ${JSON.stringify(name).slice(0, 66)} gui:${device}`;
    const reply = ({ detail, code: _code, ...o }: Outcome): EngineActionResult => ({
      type: 'engineActionResult',
      requestId,
      action,
      name,
      ...o,
      ...(o.error && detail && { error: `${o.error} (${detail})` }),
    });
    const refusal = this.refusal(req, privileged);
    if (refusal) {
      this.log(`action ${what}: refused (${refusal})`);
      return reply(fail(refusal));
    }
    // D3b: a promote holds its project's Lead too (nothing else starts either session meanwhile).
    const lead = action === 'promote' ? this.leadOf(this.find(name)) : undefined;
    const held = [name, ...(lead ? [lead.name] : [])];
    if (action === 'stop' && this.renewals.has(name)) this.renewals.cancel(name);
    for (const n of held) this.running.add(n);
    if (action === 'promote') held.forEach((n) => this.swapping.add(n));
    if (action === 'start' || action === 'restart' || action === 'stop' || action === 'promote')
      held.forEach((n) => this.forgive(n));
    const started = Date.now();
    let out: Outcome;
    try {
      out = await this.enqueue(() => this.exec(req, `gui:${device}`, person));
    } catch (err) {
      this.log(`action ${what}: ${err instanceof Error ? err.message : String(err)}`);
      out = fail(koText('engine_error'));
    } finally {
      for (const n of held) this.running.delete(n);
      if (action === 'promote') held.forEach((n) => this.swapping.delete(n));
    }
    this.log(
      `action ${what}: ${out.ok ? 'ok' : `failed (${out.error}${out.detail ? `: ${out.detail}` : ''})`}${out.bgId ? ` bg=${out.bgId}` : ''}${out.note ? ` (${out.note})` : ''} ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
    this.refresh();
    return reply(out);
  }

  /** A person acted on the project: the watch's crash-loop count and mark start over. */
  private forgive(name: string): void {
    this.guard.forgive(name);
  }

  private reviveBudget(name: string, backoff = true): 'go' | 'wait' | 'stop' {
    return this.guard.budget(name, backoff);
  }

  private refusal(req: EngineAction, privileged: boolean): string | null {
    if (this.opts.readOnly) return koText('read_only_mode');
    if (!privileged) return koText('no_permission');
    if (this.broken)
      return this.broken === SWAP_UNFINISHED
        ? SWAP_UNFINISHED
        : koText('registry_unreadable');
    if (req.action !== 'add' && !this.find(req.name)) return koText('project_unknown_short');
    if (this.running.has(req.name)) return koText('project_busy', { name: req.name });
    // A stop goes through: it cancels the pending renewal (S-02), never waits it out.
    if (this.renewals.has(req.name) && req.action !== 'stop') return koText('project_renewing', { name: req.name });
    if (req.action === 'promote') return this.promoteRefusal(this.find(req.name)!);
    return null;
  }

  /** D3b: a Worker's project Lead (a record with no role of the same project). */
  private leadOf(p: ProjectRecord | undefined): ProjectRecord | undefined {
    return p?.role ? this.leads().find((l) => l.projectId === p.projectId) : undefined;
  }

  /** D3b, §3.2 step 0 without the live sessions (those are looked at in the queue); `held`:
   *  also neither name in another action, renew or adoption (before run holds them). */
  private promoteRefusal(w: ProjectRecord, held = true): string | null {
    if (!w.role) return koText('already_lead', { name: w.name });
    if (this.agentOf(w)?.capabilities.lifetime === 'run') return koText('codex_not_lead');
    if (cliOf(w) !== DEFAULT_PROVIDER || !this.agentOf(w)) return koText('lead_claude_only');
    const lead = this.leadOf(w);
    if (!lead) return koText('worker_lead_missing');
    for (const n of held ? [w.name, lead.name] : []) {
      if (this.running.has(n)) return koText('project_busy', { name: n });
      if (this.renewals.has(n)) return koText('project_renewing', { name: n });
      if (this.watcher.adopting(n)) return koText('project_readopting', { name: n });
    }
    const target = promotePair(this.projects, w.name, 'worker');
    if ('error' in target) return target.error;
    return this.sessionClash(target.records, [w.name, lead.name]);
  }

  private enqueue<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private exec(req: EngineAction, source: string, person = false): Promise<Outcome> | Outcome {
    // INHERIT: the owner's choice in the add dialog or the owner's CLI, never an agent's delegation.
    if (req.inheritFrom !== undefined && startedBy(source) === 'agent') return fail(koText('inherit_owner_only'));
    if (req.action === 'add' && (req.role || req.project)) return this.addWorker(req);
    if (req.action === 'add') {
      const added = this.add(req);
      // An office add is also the person's first 켜기: it follows the ordinary start
      // queue so its trust and Bypass Permissions answers run before the new card says on.
      // The CLI and MCP keep their explicit-start behaviour.
      if (!added.ok || !person) return added;
      this.consented.add(req.name);
      return this.startProject(this.find(req.name)!, source, false, false, true).then((started) => ({
        ...started,
        ...warned([added.note, started.note].filter((note): note is string => !!note)),
      }));
    }
    const p = this.find(req.name);
    if (!p) return fail(koText('project_unknown_short'));
    // TERM-P3: the per-agent switch (and `agty move-pty`) moves a Claude agent into our PTY host;
    // the rest of the edit applies after it.
    if (req.action === 'edit' && req.provider === CLAUDE_PTY_PROVIDER && (p.provider ?? DEFAULT_PROVIDER) === DEFAULT_PROVIDER)
      return this.moveToPty(p, source).then((m) => {
        if (!m.ok) return m;
        const e = this.edit(this.find(p.name) ?? p, req);
        return e.ok ? { ...e, ...(m.bgId && { bgId: m.bgId }), ...warned([m.note, e.note].filter((n): n is string => !!n)) } : e;
      });
    if (req.action === 'edit') return this.edit(p, req);
    if (req.action === 'remove') return this.remove(p, req.purge === true);
    if (req.action === 'promote') return this.promote(p, req.oldLead ?? 'worker', source);
    if (req.action === 'stop') return this.stopProject(p);
    if (req.action === 'restart') return this.restartProject(p, source);
    return this.startProject(p, source, false, false, person);
  }

  // ── Registry actions ────────────────────────────────────────

  private add(req: EngineAction): Outcome {
    return this.edits.add(req);
  }

  /** The conversations the registered agents resume now (대화방 지우기 never deletes those). */
  registeredSessionIds(): string[] {
    return this.projects.flatMap((p) => (p.sessionId ? [p.sessionId] : []));
  }

  /** INHERIT: the add dialog's list for `folder` (normalized the way add does). */
  inheritable(folder: string): InheritableAgent[] {
    const n = normalizeProjectPath(folder, this.host);
    if ('error' in n) return [];
    try {
      return inheritable(this.home, n.path, (a, b) => samePath(a, b, this.host));
    } catch (err) {
      this.log(`inheritable ${n.path}: ${String(err)}`);
      return [];
    }
  }

  private addWorker(req: EngineAction): Outcome {
    return this.edits.addWorker(req);
  }

  private workerFolder(
    lead: ProjectRecord,
    raw: string | undefined,
    mkdir: boolean,
  ): { path?: string; warnings: string[] } | Outcome {
    return this.edits.workerFolder(lead, raw, mkdir);
  }

  private edit(p: ProjectRecord, req: EngineAction): Outcome {
    return this.edits.edit(p, req);
  }

  private sessionClash(next: ProjectRecord[], changed: string[]): string | null {
    return this.edits.sessionClash(next, changed);
  }

  /** A Worker, or a project with its Workers (D3): their background sessions stopped first.
   *  Every remove detaches what was kept under each name (projectData, to its gone name, so a
   *  new agent of that name inherits nothing; the messenger shows the old one as "(알 수 없음)");
   *  `purge` deletes it instead. The conversation files are never touched. */
  private async remove(p: ProjectRecord, purge = false): Promise<Outcome> {
    this.refresh();
    const gone = this.projects.filter(
      (x) => x === p || (!p.role && x.role && x.projectId === p.projectId),
    );
    let terminal = false;
    for (const x of gone) {
      const h = this.holder(x);
      if (h && h.kind !== 'background') terminal = true;
      if (h?.kind !== 'background') continue;
      const r = await this.stopSession(h);
      if (!r.ok) return r;
    }
    this.commit(this.projects.filter((x) => !gone.includes(x)));
    const notMoved: string[] = [];
    for (const x of gone) {
      this.tokens.drop(x.name);
      this.forgive(x.name);
      this.forgetSession(x.name);
      const id = x.role ? x.assignmentId : x.leadAssignmentId;
      if (!id) continue;
      const tomb = goneName(id);
      let transcript: string | undefined;
      try {
        const agent = this.agentOf(x);
        if (x.sessionId && agent) transcript = agent.transcript({ cwd: x.folder, sessionId: x.sessionId });
      } catch {
        /* no transcript: the contact is not listed */
      }
      try {
        recordFormerName(this.home, {
          name: x.name,
          until: Date.now(),
          as: tomb,
          gone: {
            folder: x.folder,
            ...(transcript && { transcript }),
            ...(x.sessionId && { sessionId: x.sessionId }),
            ...(purge && { purged: true as const }),
          },
        });
      } catch (err) {
        notMoved.push('name-history.json');
        this.log(`remove "${x.name}": name-history.json: ${String(err)}`);
      }
      const log = (l: string) => this.log(l);
      notMoved.push(
        ...this.dataChange(
          // A gone name is new: no check needed (force).
          () => (purge ? purgeProjectData(this.home, x.name, tomb, log) : moveProjectData(this.home, x.name, tomb, log, true)),
          [x.name],
        ),
      );
    }
    const notes = [
      koText(terminal ? 'removed_terminal_kept' : purge ? 'removed_purged' : 'removed_history_kept'),
      ...(notMoved.length ? [koText('data_not_moved', { stores: [...new Set(notMoved)].join(', ') })] : []),
    ];
    return { ok: true, note: notes.join(' · ') };
  }

  /**
   * D3b (design-d3b §3.2): Worker `w` becomes its project's Lead; names are slots, so the
   * two assignments swap names. In order: both names held (run; the messenger types into
   * neither); W's session stopped, then L's (a failed stop restarts what was stopped and
   * changes nothing, tokens included); L's term and both prompts into the journal, then both
   * tokens dropped; the journal applied (the commit, also
   * finished at the next start after a crash); per-session state of both names forgotten;
   * W started fresh as the project, L resumed as the Worker (oldLead: worker: with the Worker's
   * own -n, flags and a fresh token, so Claude continues it in a copy) or left off.
   * After the commit a failed start is an ordinary one: revive and the watch retry it.
   */
  private async promote(w: ProjectRecord, oldLead: OldLead, source: string): Promise<Outcome> {
    this.refresh();
    const lead = this.leadOf(w);
    const refusal = lead ? this.promoteRefusalLive(w, lead) : koText('worker_lead_missing');
    if (refusal || !lead) return fail(refusal ?? '');
    const pair = { lead: lead.name, worker: w.name };
    // 2. W's session, then L's, each until gone. (A failed stop restarts what was stopped
    // with its token still valid: nothing changed, MCP identity included.)
    const stopped: string[] = [];
    const undo = async (why: Outcome): Promise<Outcome> => {
      for (const n of stopped) {
        const p = this.find(n);
        if (p) await this.startProject(p, source);
      }
      return why;
    };
    for (const n of [pair.worker, pair.lead]) {
      const h = this.holder(this.find(n)!);
      if (!h) continue;
      const r = await this.stopSession(h);
      if (!r.ok) return undo({ ...r, error: koText('swap_stop_failed', { name: n, why: r.error ?? koText('stop_failed') }) });
      stopped.push(n);
    }
    // 3, 4. Built from the records as they are now (a refresh may have followed a conversation).
    const L = this.find(pair.lead)!;
    const W = this.find(pair.worker)!;
    const target = promotePair(this.projects, pair.worker, oldLead);
    if ('error' in target) return undo(fail(target.error));
    const at = Date.now();
    const transcriptOf = (p: ProjectRecord): string | null => {
      const agent = this.agentOf(p);
      return agent && p.sessionId ? agent.transcript({ cwd: p.folder, sessionId: p.sessionId }) : null;
    };
    const lFile = transcriptOf(L);
    let bytes = 0;
    try {
      bytes = lFile ? fs.statSync(lFile).size : 0;
    } catch {
      /* no transcript yet */
    }
    const term: LeadTerm | null =
      L.sessionId && lFile && L.leadAssignmentId
        ? { projectId: L.projectId, assignmentId: L.leadAssignmentId, sessionId: L.sessionId, transcript: lFile, bytes, endedAt: at }
        : null;
    const names = new Map<string, string>();
    for (const r of target.records) {
      const id = r.role ? r.assignmentId : r.leadAssignmentId;
      if (id) names.set(id, r.name);
    }
    const brief = this.opts.briefing?.(pair.lead) ?? { tasks: [], running: [], events: [] };
    const team = target.records.filter((r) => r.projectId === L.projectId);
    const when = shortStamp(at);
    const journal: SwapJournal = {
      v: 1,
      projectId: L.projectId,
      at,
      from: L.leadAssignmentId!,
      to: W.assignmentId!,
      oldLead,
      names: pair,
      ...registryTexts(target.records),
      term,
      prompts: {
        lead: leadPrompt({
          when,
          now: at,
          project: pair.lead,
          worker: pair.worker,
          oldLead,
          workerTranscript: transcriptOf(W),
          leadTranscript: lFile,
          tasks: brief.tasks,
          nameOf: (id) => names.get(id),
          running: brief.running,
          workers: team
            .filter((r) => r.role)
            .map((r) => ({
              name: r.name,
              role: r.role!,
              on: r.name === pair.worker ? oldLead === 'worker' : !!this.holder(r),
            })),
          events: eventLines(brief.events, team.map((r) => r.name), at),
        }),
        worker: oldLead === 'worker' ? roleNotice(pair.lead, pair.worker, when) : null,
      },
    };
    try {
      writeJournal(this.home, journal);
    } catch (err) {
      return undo(fail(koText('swap_journal_failed', { why: err instanceof Error ? err.message : String(err) })));
    }
    // 1, once nothing is undone any more: the old tokens identify nobody (each start reissues).
    this.tokens.drop(pair.lead);
    this.tokens.drop(pair.worker);
    // 5. The commit (synchronous: no send lands between it and the re-addressing).
    try {
      applySwap(this.home, this.file, journal, (l) => this.log(l));
    } catch (err) {
      this.log(`promote "${pair.worker}": the commit stopped (${String(err)}); the next start finishes it`);
    }
    // Stopped before the registry was written (the journal is not in its 'effects' phase): the
    // old pair still loads, but the swap is decided. Nothing starts or is written until a restart
    // rolls it forward, with both sessions still stopped.
    const left = readJournal(this.home);
    if (left !== null && (left === 'unreadable' || left.phase !== 'effects')) {
      this.broken = SWAP_UNFINISHED;
      return fail(koText('swap_not_finished'));
    }
    // 6. The committed pair, and nothing per session left over for either name.
    const loaded = loadRegistry(this.file);
    if (loaded.broken) {
      this.broken = loaded.broken;
      return fail(koText('swap_not_finished'));
    }
    this.projects = loaded.projects;
    for (const n of [pair.lead, pair.worker]) this.forgetSession(n);
    this.opts.swapped?.([pair.lead, pair.worker]);
    // 7. W fresh as the project's Lead (its inbox: the prompt first), L resumed as the Worker.
    const notes: string[] = [];
    const first = await this.startProject(this.find(pair.lead)!, source, true);
    if (!first.ok) notes.push(koText('swap_lead_start_failed', { why: first.error ?? '' }));
    if (oldLead === 'worker') {
      // Its conversation, as the Worker: a copy under a new id (its old id stays in the term).
      const second = await this.startProject(this.find(pair.worker)!, source, false, true);
      if (!second.ok) notes.push(koText('swap_worker_start_failed', { why: second.error ?? '' }));
    }
    // 8.
    this.opts.event?.('lead_swap', source, {
      project: pair.lead,
      from: { assignmentId: journal.from, name: pair.lead },
      to: { assignmentId: journal.to, name: pair.worker },
      oldLead,
      ok: first.ok,
    });
    return { ok: true, ...(first.bgId && { bgId: first.bgId }), ...warned(notes) };
  }

  /** §3.2 step 0 with the live sessions: neither open in a terminal, neither working. */
  private promoteRefusalLive(w: ProjectRecord, lead: ProjectRecord): string | null {
    const before = this.promoteRefusal(w, false);
    if (before) return before;
    for (const p of [w, lead]) {
      const h = this.holder(p);
      if (h && h.kind !== 'background')
        return koText('swap_in_terminal', { name: p.name });
      if (h && this.busyOf(h, null) === true)
        return koText('swap_busy', { name: p.name });
    }
    return null;
  }

  /** D3b: what this engine kept per session for `name` (both sessions restart after a swap). */
  private forgetSession(name: string): void {
    this.forgive(name);
    this.untrusted.delete(name);
    this.compactions.forget(name);
    this.watcher.dropAdoption(name);
    for (const k of this.contestedLogged) if (k.startsWith(`${name}\0`)) this.contestedLogged.delete(k);
  }

  /** D3b: a Lead swap the last daemon committed but did not finish: finish it before loading. */
  private recoverSwap(): void {
    // A read-only daemon writes nothing: the next ordinary start finishes it.
    if (this.opts.readOnly) return;
    const j = readJournal(this.home);
    if (j === null) return;
    if (j === 'unreadable') {
      this.log(`${path.join(configDir(this.home), 'lead-swap.json')}: unreadable; the Lead swap it records was not finished (check projects.json and assignments.json, then remove it)`);
      return;
    }
    try {
      applySwap(this.home, this.file, j, (l) => this.log(l));
      // Cut short before the registry (maybe before its tokens were dropped): the old sessions'
      // tokens identify nobody. In the 'effects' phase they were dropped and the new sessions
      // hold fresh ones: kept.
      if (j.phase !== 'effects') {
        this.tokens.drop(j.names.lead);
        this.tokens.drop(j.names.worker);
      }
      this.log(`lead swap "${j.names.worker}" -> "${j.names.lead}": finished at start`);
      // What the swap's own run does after its commit (the office: queue, MCP, proposals).
      this.opts.swapped?.([j.names.lead, j.names.worker]);
    } catch (err) {
      this.log(`lead swap "${j.names.worker}" -> "${j.names.lead}": could not finish (${String(err)})`);
    }
  }

  /** D3b: the project whose Lead's conversation is `sessionId` now, or null. */
  leadProjectOfSession(sessionId: string): string | null {
    return this.leads().find((p) => p.sessionId === sessionId)?.projectId ?? null;
  }

  private commit(next: ProjectRecord[]): void {
    // A list it could not read whole is never written back (wake and the like reach here too).
    if (this.broken) throw new Error(`${this.file}: ${this.broken}; not written`);
    const linked = linkWorkers(next); // a Worker follows its project's folder and room
    saveRegistry(this.file, linked, (line) => this.log(line)); // throws before memory changes
    this.projects = linked;
  }

  private patch(name: string, fields: Partial<ProjectRecord>): void {
    this.commit(this.projects.map((x) => (x.name === name ? { ...x, ...fields } : x)));
  }

  // ── Session actions ─────────────────────────────────────────

  /** `newConversation`: not the project's old conversation (renew). `flags` (D3b's promote):
   *  resume under the record's own name, flags and a fresh token, never a bare wake. `trust`
   *  (AUTO-TRUST): a person's 켜기, which may answer the folder trust question once. */
  private async startProject(
    p: ProjectRecord,
    source = 'engine',
    newConversation = false,
    flags = false,
    trust = false,
  ): Promise<Outcome> {
    this.refresh();
    const agent = this.agentOf(p);
    if (!agent) {
      const id = p.provider ?? DEFAULT_PROVIDER;
      this.log(`"${p.name}": no agent provider "${id}" in this build; not started`);
      return fail(unknownProvider(id));
    }
    const notReady = agent.ready?.();
    if (notReady) return fail(notReady);
    const h = this.holder(p);
    if (h?.kind === 'background')
      return { ok: true, bgId: h.id ?? undefined, note: koText('already_on') };
    if (h) return { ok: true, note: koText('already_in_terminal') };
    if (agent.capabilities.lifetime === 'run') return this.startResting(p, source);
    const other = this.live.find(
      (s) => s.kind === 'background' && s.agent === agent && agent.nameMatches(s.name, sessionName(p)),
    );
    if (other)
      return {
        ok: false,
        bgId: other.id ?? undefined,
        error: koText('session_elsewhere'),
      };
    p = this.followWorktree(p);
    const folder = checkFolder(p.folder, this.host);
    if (folder.error) return fail(folder.error);
    const rules = p.rulesFile ? checkRulesFile(p.rulesFile) : null;
    if (rules) return fail(rules);
    // K1 (B4): after a renew whose start failed, the next start is the new conversation it was
    // meant to be (the handoff waits in the inbox as its first message), never the old one.
    const afterRenew = !newConversation && this.renewals.failedStart(p.name);
    if (afterRenew) newConversation = true;
    let resume = newConversation ? undefined : p.sessionId;
    let note: string | undefined;
    if (resume && !fs.existsSync(agent.transcript({ cwd: p.folder, sessionId: resume }))) {
      resume = undefined;
      note = koText('started_fresh');
    }
    const before = new Set(this.live.map((s) => s.sessionId));
    // D3b: a conversation started under another name is continued only as a copy of its own.
    const copy = flags || p.resumeAsCopy === true;
    const startOnce = () => agent.start(p, { resume, token: () => this.tokens.issue(p.name), flags: copy });
    let r = await startOnce();
    // AUTO-TRUST: only for a project the person added here or saw marked (needsTrust), one try;
    // never for a cloned one (DEVROOM-PROJECT: the person answers, or `agty trust`).
    if (
      !r.ok &&
      r.needsTrust &&
      trust &&
      !this.cloned(p) &&
      (agent.protocol === 'claude' || agent.protocol === 'pty') &&
      (this.untrusted.has(p.name) || this.consented.has(p.name))
    ) {
      this.consented.delete(p.name);
      if ((await this.trustStep(p)).outcome === 'trusted') {
        this.log(`"${p.name}": folder trust answered; starting again`);
        r = await startOnce();
        if (r.ok) note = note ? `${note} · ${koText('trust_answered')}` : koText('trust_answered');
      }
    }
    // BYPASS-ACCEPT: only Claude's bypassPermissions start may have produced this result. Its
    // one-time warning is answered by Claude's own interactive dialog, then this same start gets
    // one retry. An unrecognised dialog leaves `r` intact, so the original failure reaches the UI.
    if (!r.ok && r.needsBypassAccept && p.permissionMode === 'bypassPermissions' && agent.protocol === 'claude') {
      const original = r;
      const bypass = await this.bypassStep(p);
      if (bypass.outcome === 'accepted') {
        this.log(`"${p.name}": Bypass Permissions warning answered; starting again`);
        r = await startOnce();
        if (r.ok) {
          const text = koText(bypass.trusted ? 'bypass_trust_answered' : 'bypass_answered');
          note = note ? `${note} · ${text}` : text;
        }
      } else {
        r = original;
      }
    }
    if (!r.ok) {
      // A folder the CLI does not trust yet: only a person answers that question.
      if (r.needsTrust) this.untrusted.add(p.name);
      return fail(r.error, r.detail);
    }
    this.untrusted.delete(p.name);
    const printed = r.id;
    const s = await this.waitFor(() => {
      const fresh = this.live.filter(
        (x) => x.kind === 'background' && x.agent === agent && !before.has(x.sessionId),
      );
      return (
        fresh.find((x) => printed !== null && x.id === printed) ??
        newest(
          fresh.filter(
            (x) => agent.nameMatches(x.name, sessionName(p)) && samePath(x.cwd, p.folder, this.host),
          ),
        )
      );
    }, this.t.appearMs);
    if (!s) return fail(koText('session_not_found'));
    if (resume && s.sessionId !== resume) note = r.note ?? koText('started_as_copy');
    this.patch(p.name, {
      sessionId: s.sessionId,
      ...(s.id && { backgroundId: s.id }),
      wantRunning: true,
      idleRetired: false,
      // D3b: a conversation of its own now (a copy or a fresh one): ordinary starts again.
      ...(p.resumeAsCopy && (!resume || s.sessionId !== resume) && { resumeAsCopy: undefined }),
    });
    this.opts.event?.('orch_start', source, {
      name: p.name,
      session_id: s.sessionId,
      resumed: resume !== undefined,
      remote_control: p.remoteControl === true,
      by: startedBy(source),
      ...(r.playbook && { role: p.role ?? 'lead', playbook: r.playbook }), // C7a
      ...(newConversation && { new_conversation: true }),
      ...(source === 'revive' && { revives_24h: this.guard.count(p.name) }),
    });
    if (afterRenew) this.renewals.recovered(p, s.sessionId);
    this.opts.started?.(p.name);
    return { ok: true, bgId: s.id ?? printed ?? undefined, ...(note && { note }) };
  }

  /** DEVROOM-PROJECT: `p`'s project was added from a fresh clone (a Worker: its Lead's flag). */
  private cloned(p: ProjectRecord): boolean {
    return !!(p.role ? this.leads().find((l) => l.projectId === p.projectId)?.cloned : p.cloned);
  }

  /** AUTO-TRUST: Claude's folder trust question for `p`'s folder, answered in our own PTY
   *  (trust.ts) with the same command and environment as its `claude --bg`. Claude never keeps
   *  the answer for the home folder, so that one is not tried. */
  private async trustStep(p: ProjectRecord): Promise<TrustResult> {
    if (samePath(p.folder, this.home, this.host)) {
      this.log(`"${p.name}": trust: the home folder (Claude keeps no answer for it); not tried`);
      return { outcome: 'homeDir', steps: [] };
    }
    this.trusting.add(p.name);
    this.refresh();
    try {
      const { file, args } = claudeCommand(this.opts.claudePath, TRUST_ARGS, this.scope);
      return await trustFolder({
        file,
        args,
        cwd: p.folder,
        env: this.env,
        log: (l) => this.log(`"${p.name}": ${l}`),
        timing: this.opts.trustTiming,
      });
    } finally {
      this.trusting.delete(p.name);
      this.refresh();
    }
  }

  /** BYPASS-ACCEPT: Claude's own one-time warning, in our PTY with the engine environment.
   *  `startProject` reaches here only after a bypassPermissions start was refused for that warning. */
  private async bypassStep(p: ProjectRecord): Promise<BypassResult> {
    const { file, args } = claudeCommand(this.opts.claudePath, BYPASS_ARGS, this.scope);
    return acceptBypass({
      file,
      args,
      cwd: p.folder,
      env: this.env,
      log: (l) => this.log(`"${p.name}": ${l}`),
      answerTrust: !this.cloned(p),
      timing: this.opts.bypassTiming,
    });
  }

  /**
   * AUTO-TRUST, `agty trust [--start] <project or folder>`: the owner's command (control.ts refuses
   * an agent's token). A folder must be a registered project's (its Lead first); then, with
   * `start`, the project starts as with 켜기.
   */
  async trustProject(
    target: { name?: string; folder?: string },
    start: boolean,
  ): Promise<
    | { ok: false; code: string; error: string }
    | { ok: true; name: string; folder: string; worker: boolean; trust: TrustResult; start?: Outcome }
  > {
    const no = (code: string, error: string) => ({ ok: false as const, code, error });
    if (this.opts.readOnly) return no('refused', koText('read_only_mode'));
    if (this.broken) return no('refused', koText('registry_unreadable'));
    const p = target.name
      ? this.find(target.name)
      : this.projects
          .filter((x) => !!target.folder && samePath(x.folder, target.folder, this.host))
          .sort((a, b) => Number(!!a.role) - Number(!!b.role))[0];
    if (!p) return no('unknown_project', koText('project_unknown_short'));
    const protocol = this.agentOf(p)?.protocol;
    if (protocol !== 'claude' && protocol !== 'pty') return no('refused', koText('trust_claude_only'));
    if (this.running.has(p.name)) return no('refused', koText('project_busy', { name: p.name }));
    this.running.add(p.name);
    try {
      return await this.enqueue(async () => {
        const trust = await this.trustStep(p);
        const fine = trust.outcome === 'trusted' || trust.outcome === 'alreadyTrusted';
        if (fine) this.untrusted.delete(p.name);
        const ok = { ok: true as const, name: p.name, folder: p.folder, worker: !!p.role, trust };
        if (!start || !fine) return ok;
        this.forgive(p.name);
        return { ...ok, start: await this.startProject(this.find(p.name) ?? p, 'gui:cli') };
      });
    } finally {
      this.running.delete(p.name);
      this.refresh();
    }
  }

  /**
   * W2: a Worker given a Task's worktree starts in it (here, at a start: a running session is
   * never moved). The folder goes through the same rule as `worker edit --folder` (inside the
   * project or its repository's .worktrees/); anything that does not fit is logged and left.
   */
  private followWorktree(p: ProjectRecord): ProjectRecord {
    const want = p.role ? this.opts.assignedFolder?.(p) : null;
    if (!want || samePath(want, p.folder, this.host)) return p;
    const lead = this.leads().find((l) => l.projectId === p.projectId);
    const own = lead && this.workerFolder(lead, want, false);
    if (!lead || !own || 'ok' in own) {
      this.log(`"${p.name}": not moved to ${want} (${own && 'ok' in own ? own.error : 'no project'})`);
      return p;
    }
    const next: ProjectRecord = { ...p, folder: own.path ?? lead.folder };
    if (own.path) next.workFolder = own.path;
    else delete next.workFolder;
    const list = this.projects.map((x) => (x.name === p.name ? next : x));
    const clash = this.sessionClash(list, [p.name]);
    if (clash) {
      this.log(`"${p.name}": not moved to ${want} (${clash})`);
      return p;
    }
    this.commit(list);
    this.log(`"${p.name}": starts in ${next.folder} (W2: its Task's worktree)`);
    return next;
  }

  /** D5: a 'run' provider's agent is on with no process: each message it gets starts a run. */
  private startResting(p: ProjectRecord, source: string): Outcome {
    const folder = checkFolder(p.folder, this.host);
    if (folder.error) return fail(folder.error);
    this.patch(p.name, { wantRunning: true, idleRetired: false });
    this.opts.event?.('orch_start', source, {
      name: p.name,
      session_id: null,
      resumed: false,
      remote_control: false,
    });
    this.opts.started?.(p.name);
    return { ok: true };
  }

  private async stopProject(p: ProjectRecord): Promise<Outcome> {
    this.refresh();
    const h = this.holder(p);
    if (h && h.kind !== 'background') return fail(koText('terminal_cannot_stop'));
    const off = () => {
      if (p.wantRunning || p.idleRetired) this.patch(p.name, { wantRunning: false, idleRetired: false });
    };
    if (h) {
      const r = await this.stopSession(h, off);
      if (!r.ok) return r;
    }
    off();
    return h ? { ok: true } : { ok: true, note: koText('already_off') };
  }

  private async restartProject(p: ProjectRecord, source: string): Promise<Outcome> {
    this.refresh();
    const h = this.holder(p);
    if (h && h.kind !== 'background')
      return fail(koText('terminal_cannot_restart'));
    if (h) {
      const r = await this.stopSession(h);
      if (!r.ok) return r;
    }
    return this.startProject(this.find(p.name) ?? p, source);
  }

  /**
   * TERM-P3 (ADR-0018): move a Claude agent from `claude --bg` into our PTY host, same conversation.
   * Off: only its provider changes (its next start is in the host). On: refused unless its turn has
   * ended and nothing holds it; then the background session is stopped (`claude stop`), the agent
   * starts in the host with `--resume <the same id>` (P0 a), and it counts as moved only once a
   * session of the host with that id is found idle. Anything short of that puts the record back as
   * it was and starts the old session again (the same restart as 다시 켜기), and says why.
   * Messages wait meanwhile (renewing(): the move holds the name as a Lead swap does).
   * ponytail: a message the Typist typed just before the idle check can be cut by the stop; it is
   * in the transcript, so the resumed conversation has it but not the reply it was getting.
   */
  private async moveToPty(p: ProjectRecord, source: string): Promise<Outcome> {
    const pty = this.agents.get(CLAUDE_PTY_PROVIDER);
    if (!pty) return fail(koText('pty_host_missing'));
    this.refresh();
    const h = this.holder(p);
    const moved: ProjectRecord = { ...p, provider: CLAUDE_PTY_PROVIDER };
    const clash = this.sessionClash(this.projects.map((x) => (x.name === p.name ? moved : x)), [p.name]);
    if (clash) return fail(clash);
    if (!h) {
      this.patch(p.name, { provider: CLAUDE_PTY_PROVIDER });
      this.log(`move "${p.name}": off; it starts in the PTY host from now on`);
      return { ok: true, note: koText('pty_moved_off') };
    }
    const notReady = pty.ready?.();
    if (notReady) return fail(notReady);
    if (h.kind !== 'background' || !h.id) return fail(koText('terminal_cannot_stop'));
    if (!turnEnded(h.status) || (await h.agent.held(h))) return { ...fail(koText('pty_move_busy')), code: MOVE_BUSY };
    const id = h.sessionId;
    if (!fs.existsSync(pty.transcript({ cwd: p.folder, sessionId: id })))
      return fail(koText('pty_move_no_transcript'));
    this.swapping.add(p.name);
    try {
      this.log(`move "${p.name}": stopping its background session ${h.id} (conversation ${id.slice(0, 8)})`);
      const stopped = await this.stopSession(h);
      if (!stopped.ok)
        return { ...fail(koText('pty_move_failed', { why: stopped.error ?? '' }), stopped.detail), code: MOVE_ROLLED_BACK };
      this.patch(p.name, { provider: CLAUDE_PTY_PROVIDER, sessionId: id });
      const started = await this.startProject(this.find(p.name)!, source);
      const found =
        started.ok &&
        (await this.waitFor(
          () => this.live.find((s) => s.agent === pty && s.sessionId === id && turnEnded(s.status)) ?? null,
          this.t.moveIdleMs,
        ));
      if (found) {
        this.log(`move "${p.name}": in the PTY host, conversation ${id.slice(0, 8)} idle`);
        return { ok: true, bgId: found.id ?? undefined, note: koText('pty_moved') };
      }
      const why = started.ok ? koText('pty_move_not_idle', { id: id.slice(0, 8) }) : (started.error ?? '');
      this.log(`move "${p.name}": failed (${why}); putting it back on claude --bg`);
      // Never two processes on one conversation: the old session comes back only once the host has
      // no terminal of this agent left (one not up yet included); else it stays the host's.
      const left = this.holder(this.find(p.name)!);
      const closed = (!left || (await this.stopSession(left)).ok) && ((await pty.closeAll?.(p)) ?? true);
      if (!closed) {
        this.log(`move "${p.name}": its PTY host terminal did not close; left in the host`);
        return {
          ...fail(koText('pty_move_back_failed', { why, back: koText('session_not_stopped') }), started.detail),
          code: MOVE_ROLLED_BACK,
        };
      }
      this.commit(this.projects.map((x) => (x.name === p.name ? p : x)));
      const back = await this.startProject(p, source);
      return {
        ...fail(koText(back.ok ? 'pty_move_failed' : 'pty_move_back_failed', { why, back: back.error ?? '' }), started.detail),
        code: MOVE_ROLLED_BACK,
      };
    } finally {
      this.swapping.delete(p.name);
    }
  }

  // ── TERM-P3: every agent to the new terminal, one at a time ──

  /** The queue's state while it runs (null: none). ponytail: in memory, so a daemon restart ends it;
   *  pressing again skips the agents already moved. */
  private moveAllRun: { total: number; done: number; stop: boolean } | null = null;

  /**
   * The owner's one click (`agty move-pty --all`): move every Claude agent of the old mode into the
   * host, off agents first (their provider flips), then Workers, Leads without Workers, Leads with
   * Workers (the orchestrators). One at a time; a running agent waits for its turn to end up to
   * moveAllWaitMs, then it is skipped. Each result is one feed line (`pty_move`), then a summary.
   */
  moveAll(privileged: boolean): { ok: true; total: number } | { ok: false; error: string } {
    if (this.opts.readOnly) return { ok: false, error: koText('read_only_mode') };
    if (!privileged) return { ok: false, error: koText('no_permission') };
    if (this.broken) return { ok: false, error: koText('registry_unreadable') };
    if (this.moveAllRun) return { ok: false, error: koText('pty_move_all_running') };
    this.refresh();
    const rank = (p: ProjectRecord): number =>
      !this.holder(p) ? 0 : p.role ? 1 : this.projects.some((w) => w.role && w.projectId === p.projectId) ? 3 : 2;
    const names = this.projects
      .filter((p) => (p.provider ?? DEFAULT_PROVIDER) === DEFAULT_PROVIDER)
      .map((p, i) => ({ name: p.name, rank: rank(p), i }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .map((x) => x.name);
    if (names.length === 0) return { ok: false, error: koText('pty_move_all_nothing') };
    this.moveAllRun = { total: names.length, done: 0, stop: false };
    this.log(`move-all: ${names.length} agent(s): ${names.join(', ')}`);
    void this.runMoveAll(names);
    this.refresh();
    return { ok: true, total: names.length };
  }

  /** The owner stops the queue: the agent being moved finishes, the rest are left. */
  moveAllStop(privileged: boolean): { ok: boolean; error?: string } {
    if (!privileged) return { ok: false, error: koText('no_permission') };
    if (!this.moveAllRun) return { ok: false, error: koText('pty_move_all_idle') };
    this.moveAllRun.stop = true;
    this.log('move-all: stop requested');
    return { ok: true };
  }

  private async runMoveAll(names: string[]): Promise<void> {
    const run = this.moveAllRun!;
    const count = { moved: 0, skipped: 0, rolled_back: 0 };
    try {
      for (const name of names) {
        if (run.stop || this.disposed) break;
        const r = await this.moveOne(name, run);
        if (!r) break; // stopped while waiting for this agent's turn to end
        count[r.result]++;
        this.log(`move-all "${name}": ${r.result}${r.why ? ` (${r.why})` : ''}`);
        this.opts.event?.('pty_move', 'engine', { name, result: r.result, ...(r.why && { why: r.why }) });
        run.done++;
        this.refresh();
      }
    } finally {
      this.moveAllRun = null;
      if (!this.disposed) {
        this.opts.event?.('pty_move_all', 'engine', {
          total: names.length,
          moved: count.moved,
          skipped: count.skipped,
          rolledBack: count.rolled_back,
          ...(run.done < names.length && { stopped: true }),
        });
        this.refresh();
      }
    }
  }

  /** One agent's turn in the queue; null when the owner stopped it while it waited. */
  private async moveOne(
    name: string,
    run: { stop: boolean },
  ): Promise<{ result: 'moved' | 'skipped' | 'rolled_back'; why?: string } | null> {
    const end = Date.now() + this.t.moveAllWaitMs;
    for (;;) {
      if (run.stop || this.disposed) return null;
      const p = this.find(name);
      if (!p) return { result: 'skipped', why: koText('project_unknown_short') };
      if ((p.provider ?? DEFAULT_PROVIDER) !== DEFAULT_PROVIDER)
        return { result: 'skipped', why: koText('pty_move_all_already') };
      if (!(this.running.has(name) || this.renewals.has(name) || this.watcher.adopting(name))) {
        this.running.add(name);
        let out: Outcome;
        try {
          out = await this.enqueue(() => this.moveToPty(this.find(name) ?? p, 'move-all'));
        } catch (err) {
          out = fail(err instanceof Error ? err.message : String(err));
        } finally {
          this.running.delete(name);
        }
        if (out.ok) return { result: 'moved' };
        if (out.code !== MOVE_BUSY)
          return { result: out.code === MOVE_ROLLED_BACK ? 'rolled_back' : 'skipped', why: out.error };
      }
      if (Date.now() >= end)
        return { result: 'skipped', why: koText('pty_move_all_timeout', { min: Math.round(this.t.moveAllWaitMs / 60_000) }) };
      await this.sleep(this.t.moveAllPollMs);
    }
  }

  /** Its provider's stop (Claude: `claude stop <exact id>`), then wait until its pid has left. */
  private async stopSession(h: Live, accepted?: () => void): Promise<Outcome> {
    const r = await h.agent.stop(h);
    if (!r.ok) return fail(r.error, r.detail);
    accepted?.(); // the stop was taken: it stands even if the pid is slow to leave (S-03)
    const gone = await this.waitFor(
      () => (this.live.some((s) => s.agent === h.agent && s.pid === h.pid) ? null : true),
      this.t.goneMs,
    );
    return gone ? { ok: true } : fail(koText('session_not_stopped'));
  }

  /** At daemon start: every wantRunning project that is not live (EngineWatch.revive). */
  revive(): Promise<void> {
    return this.watcher.revive();
  }

  private watch(): Promise<void> {
    return this.watcher.watch();
  }

  /** The watch's last look at Claude's daemon (engine.test reads it; a private one would be unused). */
  get daemonWasUp(): boolean {
    return this.watcher.daemonWasUp;
  }

  /** One revive through the action queue, with its log line; normally the first message says why. */
  private async reviveOne(
    p: ProjectRecord,
    cause: 'reboot' | 'restart' | 'died',
    firstPrompt = true,
  ): Promise<Outcome> {
    const name = p.name;
    this.running.add(name);
    let out: Outcome;
    try {
      // The first message tells the session why it is back (the 자동 복구 line).
      if (firstPrompt) this.opts.writeInbox?.(name, reviveText(cause, shortStamp()), [REVIVE_TAG, REVIVE_TAG_OLD]);
      out = await this.enqueue(() => this.startProject(this.find(name) ?? p, 'revive'));
    } catch (err) {
      out = fail(err instanceof Error ? err.message : String(err));
    } finally {
      this.running.delete(name);
    }
    this.log(
      `revive "${name}": ${out.ok ? `ok bg=${out.bgId ?? '-'}` : `failed (${out.error})`}${out.note ? ` (${out.note})` : ''}`,
    );
    this.refresh();
    return out;
  }

  private async waitFor<T>(fn: () => T | null, ms: number): Promise<T | null> {
    const end = Date.now() + ms;
    for (;;) {
      this.live = this.readLive();
      const v = fn();
      if (v !== null || Date.now() >= end || this.disposed) return v;
      await this.sleep(this.t.pollMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      // Kept only while pending (dispose clears it): every poll used to stay in the list for good.
      const t = setTimeout(() => {
        const i = this.timers.indexOf(t);
        if (i >= 0) this.timers.splice(i, 1);
        resolve();
      }, ms);
      this.timers.push(t);
    });
  }

  private log(line: string): void {
    (this.opts.log ?? console.log)(`[agty engine] ${line}`);
  }
}
