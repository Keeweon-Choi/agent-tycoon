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

import { leadDefaults } from '../../../../core/src/cld/leadDefaults.js';
import type { PathHost } from '../../../../core/src/cld/projectPath.js';
import { normalizeProjectPath } from '../../../../core/src/cld/projectPath.js';
import { koText } from '../../../../core/src/cld/serverText.js';
import type {
  BoardTask,
  EngineAction,
  EngineActionKind,
  EngineActionResult,
  EngineProject,
  EngineState,
  OfficeRoom,
  ProjectImportResult,
  ProjectImportRow,
} from '../../../../core/src/messages.js';
import { RENEW_FILL_PCT } from '../../constants.js';
import { WINDOWS_LOGIN_ENV } from '../chat.js';
import { detectHostInfo } from '../folders.js';
import type { SocketStepUp, WsSend } from '../hooks.js';
import { seededPermission } from '../newAgentPermission.js';
import { findOnPath, turnEnded } from '../providers/claudeProvider.js';
import type { AgentEntry, World } from '../providers/types.js';
import { ENTRY_DEFAULTS } from '../providers/types.js';
import { STEPUP_REQUIRED } from '../shell/gate.js';
import type { SpawnFn } from '../spawnJson.js';
import type { AgentChoicesReader } from './agentCapabilities.js';
import { ClaudeAgent, claudeCommand } from './agents/claude/claude.js';
import type { AgentProvider, LiveSession } from './agents/types.js';
import { AgentTokens } from './agentTokens.js';
import { CODEX_EFFORTS, isCodexEffort } from './codex.js';
import { configDir, shortStamp } from './events.js';
import { loadOrCreateHost } from './host.js';
import { scanProjects } from './importProjects.js';
import type { LeadTerm, OldLead, SwapJournal } from './leadSwap.js';
import {
  applySwap,
  eventLines,
  leadPrompt,
  promotePair,
  readJournal,
  roleNotice,
  writeJournal,
} from './leadSwap.js';
import type { RosterAgent } from './mcpTools.js';
import { MESSENGER_TIMING, tail, turnOver, writeAtomic } from './messenger.js';
import type { ProjectRecord, WorkerRole } from './registry.js';
import {
  CHECK,
  checkFolder,
  checkName,
  checkRulesFile,
  createAssignmentId,
  createProjectId,
  DEFAULT_PROVIDER,
  linkWorkers,
  loadRegistry,
  migrateRegistry,
  registryPath,
  registryTexts,
  roomOf,
  samePath,
  saveRegistry,
  sessionName,
  WORKER_ROLES,
} from './registry.js';
import { appendMissing } from './sessionPath.js';
import type { TrustResult } from './trust.js';
import { TRUST_ARGS, TRUST_TIMING, trustFolder } from './trust.js';

/** A live session and the provider that listed it. */
type Live = LiveSession & { agent: AgentProvider };

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
  /** T-0091: the Nth dead-session check inside this window is not revived but left down, marked. */
  reviveWindowMs: 10 * 60_000,
  reviveLimit: 3,
  /** TOKEN-GUARD: at most this many revives of one project in 24 h (each is a resumed turn)... */
  reviveDayLimit: 6,
  /** ...and the k-th of them waits this * 2^(k-1) after the one before. */
  reviveBackoffMs: 60_000,
};
const DAY_MS = 86_400_000;

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

/** compactionNudge's upper bound (0 = off). */
export const NUDGE_MAX = 99;
/** D3b: why the engine refuses every change after a promote that could not write the registry (a restart finishes the swap). */
export const SWAP_UNFINISHED =
  koText('swap_unfinished');

/** First message after revive (the 자동 복구 line): why the session was started again. */
export function reviveText(cause: 'reboot' | 'restart' | 'died', when: string): string {
  const why =
    cause === 'reboot'
      ? '컴퓨터가 다시 켜져서 엔진이 이 대화를 다시 띄웠다. 돌던 cld-gui job 작업과 서브에이전트는 꺼졌다.'
      : cause === 'died'
        ? '같은 부팅에서 세션이 꺼져 다시 띄웠다. cld-gui job 작업은 살아 있을 수 있다("$CLD_BIN" jobs 로 확인).'
        : 'cld-gui가 다시 뜰 때 이 세션이 꺼져 있어서 엔진이 다시 띄웠다. cld-gui job 작업은 살아 있을 수 있다("$CLD_BIN" jobs 로 확인).';
  return `[cld-gui 자동 복구 · ${when}] ${why} 꺼지기 전에 하던 일을 확인하고 이어서 해 달라. 하던 일이 없었으면 그대로 기다린다.`;
}

/** The compaction nudge (an opt-in per project). */
export const nudgeText = (n: number, fillPct: number): string =>
  `[cld-gui] 이 대화는 컴팩션을 ${n}번 거친 뒤 컨텍스트가 다시 ${fillPct}% 찼다. 하던 일을 안전한 지점까지 마치고, 지금 상태·돌고 있는 작업(pid·로그)·다음 할 일을 인수인계 파일로 쓴 뒤, 마지막으로 "$CLD_BIN" renew <그 파일> 을 실행하고 턴을 끝내라. 엔진이 같은 이름의 새 대화를 띄우고 인수인계를 첫 메시지로 넘긴다.`;

/** The new conversation's first message after renew. */
export function renewText(handoff: string, file: string | null, when: string): string {
  const head = `[cld-gui renew · ${when}] 컨텍스트가 포화돼 새 대화로 이어 간다.`;
  if (!handoff.trim()) return `${head} 하던 일을 이어서 해 달라.`;
  return `${head} 아래 인수인계${file ? `(${file})` : ''}를 먼저 읽고 하던 일을 이어서 해 달라.\n\n${handoff.trim()}`;
}

/** RENEW-STUCK: an accepted renewal, on disk until it is over, so a daemon restart resumes it.
 *  `queued`: the handoff is already in the inbox (a resume does not write it twice). */
interface RenewRecord {
  name: string;
  message: string;
  source: string;
  requestedAt: number;
  queued?: boolean;
}
const renewDir = (home: string): string => path.join(configDir(home), 'renewals');
/** TOKEN-GUARD: the engine's own revives and give-ups per project, kept across daemon restarts. */
const reviveGuardFile = (home: string): string => path.join(configDir(home), 'revive-guard.json');
const renewFile = (home: string, name: string): string =>
  path.join(renewDir(home), `${encodeURIComponent(name)}.json`);

const ACTIONS: EngineActionKind[] = ['add', 'edit', 'remove', 'start', 'stop', 'restart', 'promote'];
const TEXT_FIELDS = ['room', 'rulesFile', 'model', 'permissionMode', 'effort', 'title'] as const;
const LAUNCH_FIELDS = [
  'rulesFile',
  'model',
  'permissionMode',
  'effort',
  'title',
  'remoteControl',
] as const;
const REQUEST_ID_MAX = 128;
/** D5: what only a Claude session takes; a Codex Worker refuses them (nothing saved quietly). */
const CLAUDE_ONLY = ['permissionMode', 'rulesFile', 'remoteControl', 'alwaysOn', 'title', 'compactionNudge'] as const;
const WORKER_ROOM = koText('worker_room');
const WORKER_FOLDER =
  koText('worker_folder');

function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The git repository holding `folder`: its nearest folder with a .git, or null. */
function repoRoot(folder: string): string | null {
  for (let d = realPath(folder); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

/** Where a Worker's own folder may be: inside its project's folder, or in the .worktrees/
 *  folder of the repository holding it (a project folder may be a subfolder of its repo). */
function workerRoots(projectFolder: string): string[] {
  const repo = repoRoot(projectFolder);
  return [realPath(projectFolder), ...(repo ? [path.join(repo, '.worktrees')] : [])];
}

/** Kept from the daemon's environment: the user's, never a session's. */
const ENV_KEEP = ['HOME', 'PATH', 'LANG', 'USER', 'SHELL', 'TERM', 'XDG_RUNTIME_DIR'];
/** Not session state either, but nothing starts without them there. */
const ENV_KEEP_OS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ['TMPDIR', 'LOGNAME'],
  win32: WINDOWS_LOGIN_ENV,
};

/** This checkout's cld/bin (the `cld-gui` CLI, T-0019): from dist/ or from server/src/cld/engine/. */
export const CLD_BIN_DIR: string | null =
  [path.resolve(__dirname, '..'), path.resolve(__dirname, '../../../..')]
    .map((root) => path.join(root, 'cld', 'bin'))
    .find((dir) => fs.existsSync(path.join(dir, 'cld-gui'))) ?? null;

export const cldBinPath = (dir: string, platform: NodeJS.Platform = process.platform): string =>
  path.join(dir, platform === 'win32' ? 'cld-gui.cmd' : 'cld-gui');

/**
 * The environment of everything the engine starts. With `binDir`, agents find
 * the cld-gui CLI whatever the user's shell config: CLD_BIN is its absolute
 * path and its folder comes first on PATH (T-0019). The CLI is a Node script
 * (`#!/usr/bin/env node`), so the daemon's own Node folder goes LAST (ENV-1):
 * a machine whose only Node is the one we ship still runs it, and a user's
 * own Node, when there is one, keeps coming first.
 */
export function cleanEnv(
  base: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform = process.platform,
  binDir: string | null = CLD_BIN_DIR,
  nodeDir: string = path.dirname(process.execPath),
): NodeJS.ProcessEnv {
  const keep = new Set(
    [...ENV_KEEP, ...(ENV_KEEP_OS[platform] ?? [])].map((key) =>
      platform === 'win32' ? key.toUpperCase() : key,
    ),
  );
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    const key = platform === 'win32' ? k.toUpperCase() : k;
    if (v !== undefined && (keep.has(key) || key.startsWith('LC_'))) out[k] = v;
  }
  out.HOME = home;
  if (binDir) {
    out.CLD_BIN = cldBinPath(binDir, platform);
    const key = Object.keys(out).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const sep = platform === 'win32' ? ';' : ':';
    out[key] = appendMissing(out[key] ? `${binDir}${sep}${out[key]}` : binDir, nodeDir, sep);
  }
  return out;
}

/** systemd-run when a user manager runs (Linux), else null. */
export function findSystemdRun(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== 'linux' || !env.XDG_RUNTIME_DIR) return null;
  if (!fs.existsSync(path.join(env.XDG_RUNTIME_DIR, 'systemd', 'private'))) return null;
  return findOnPath('systemd-run', env.PATH);
}

/** An agent's assignment id: a Worker's own, a Lead's lead assignment. */
const assignmentOf = (p: ProjectRecord): string | undefined => (p.role ? p.assignmentId : p.leadAssignmentId);

const newest = (xs: Live[]): Live | null =>
  [...xs].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0] ?? null;

export function parseEngineAction(msg: Record<string, unknown>): EngineAction | null {
  const { requestId, action, name } = msg;
  if (typeof requestId !== 'string' || !requestId || requestId.length > REQUEST_ID_MAX) return null;
  if (typeof action !== 'string' || !(ACTIONS as string[]).includes(action)) return null;
  if (typeof name !== 'string' || name.length > 64) return null;
  const out: EngineAction = {
    type: 'engineAction',
    requestId,
    action: action as EngineActionKind,
    name,
  };
  // D3: a Worker of a project (add).
  const { role, project } = msg;
  if (role !== undefined) {
    if (!(WORKER_ROLES as unknown[]).includes(role)) return null;
    out.role = role as WorkerRole;
  }
  if (project !== undefined) {
    if (typeof project !== 'string' || project.length > 64) return null;
    out.project = project;
  }
  for (const k of ['folder', ...TEXT_FIELDS] as const) {
    const v = msg[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length > 4096) return null;
    out[k] = v;
  }
  for (const k of ['remoteControl', 'alwaysOn', 'mkdir'] as const) {
    const v = msg[k];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') return null;
    out[k] = v;
  }
  // D5: a new Worker's provider.
  const { provider } = msg;
  if (provider !== undefined) {
    if (typeof provider !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(provider)) return null;
    out.provider = provider;
  }
  // D3b: what the old Lead becomes on promote.
  const { oldLead } = msg;
  if (oldLead !== undefined) {
    if (oldLead !== 'worker' && oldLead !== 'stop') return null;
    out.oldLead = oldLead;
  }
  // T-0019: compactions before the renew nudge; 0 turns it off.
  const nudge = msg.compactionNudge;
  if (nudge !== undefined) {
    if (!Number.isInteger(nudge) || (nudge as number) < 0 || (nudge as number) > NUDGE_MAX)
      return null;
    out.compactionNudge = nudge as number;
  }
  return out;
}

interface Outcome {
  ok: boolean;
  bgId?: string;
  note?: string;
  error?: string;
  /** Claude's own words, for the client only (never logged). */
  detail?: string;
  folderMissing?: boolean;
  /** T-0019: a machine-readable reason (renew). */
  code?: string;
}
const fail = (error: string, detail?: string): Outcome => ({ ok: false, error, detail });
/** What the user should know although it worked (a slow folder, T-0032). */
const warned = (notes: string[]): Pick<Outcome, 'note'> =>
  notes.length ? { note: notes.join(' · ') } : {};

/** The identities Claude preserves when its daemon respawns a background worker. */
interface Adoption {
  sessionId?: string;
  backgroundId?: string;
}

export interface EngineOptions {
  claudePath: string;
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
  /** cld/bin with the cld-gui CLI (T-0019): CLD_BIN for sessions; null leaves it out. */
  binDir?: string | null;
  /** The PATH sessions and jobs should get (sessionPath.ts), built once by the caller; null = the service's own. */
  sessionPath?: string | null;
  /** T-0019: an event for ~/.config/agent-tycoon/events.jsonl (HIF shape). */
  event?: (type: string, source: string, fields: Record<string, unknown>) => void;
  /** T-0019: a session was started (start, restart, revive, renew): deliver its inbox. */
  started?: (name: string) => void;
  /** W2: the folder a Claude Worker should start in now (the worktree given to it), or null. */
  assignedFolder?: (p: ProjectRecord) => string | null;
  /** T-0019: a message into a project's inbox (revive's notice, renew's handoff). */
  writeInbox?: (name: string, text: string) => boolean;
  /** T-0019: a project's conversation refilled after its compaction nudge count. */
  nudge?: (name: string, count: number, fillPct: number) => void;
  /** The clock of the revive window (T-0091); tests move it. */
  now?: () => number;
  /** D4: agent providers beside Claude's (agents/types.ts), by their id (tests; D5 adds Codex). */
  agents?: AgentProvider[];
  /** D3b: what a new Lead's first prompt lists: the project's Tasks, its running jobs and
   *  Codex tasks ("<title> <id>"), and the events.jsonl records to summarize. */
  briefing?: (project: string) => {
    tasks: BoardTask[];
    running: string[];
    events: Array<Record<string, unknown>>;
  };
  /** D5 (F4): with each safety refresh (30 s): what the daemon retries on that beat. */
  tick?: () => void;
  /** D3b: a Lead swap committed: forget in-memory state kept for these names (the messenger). */
  swapped?: (names: string[]) => void;
  /** AUTO-TRUST: the trust step's waits (tests shorten them). */
  trustTiming?: Partial<typeof TRUST_TIMING>;
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
  /** T-0019: cld-gui's CLI for sessions (CLD_BIN), or null. */
  readonly cldBin: string | null;
  /** S7: each started session's CLD_AGENT_TOKEN, mapped back to its project. */
  readonly tokens: AgentTokens;
  /** The PATH every session and job gets, or null when the service's own stands. */
  private sessionPath: string | null = null;
  /** Projects in a renew, from the caller's turn end until the new conversation. */
  private readonly renewals = new Set<string>();
  /** TOKEN-GUARD (S-04): when each always-on project was last resumed after an idle retirement. */
  private readonly idleResumedAt = new Map<string, number>();
  /** TOKEN-GUARD (S-02): pending renewals a person stopped: they end without a new conversation. */
  private readonly renewCancel = new Set<string>();
  /** D3b: the two names a promote holds, until it is done. */
  private readonly swapping = new Set<string>();
  /** Projects live at the last refresh (orch_exit when one goes). */
  private liveNames = new Set<string>();
  /** contested() conflicts already logged (agent + session). */
  private readonly contestedLogged = new Set<string>();
  /** T-0126: a vanished worker may be Claude's own daemon takeover, not a dead conversation. */
  private readonly pendingAdoptions = new Map<string, Adoption>();
  /** apply(): per transcript, its size and mtime when last read, and whether the main turn was over. */
  private readonly turnSeen = new Map<string, { sig: string; over: boolean; at: number }>();
  /** Compactions and the one renew nudge seen per project's conversation. */
  private readonly compactions = new Map<
    string,
    {
      sessionId: string;
      offset: number;
      count: number;
      carry: string;
      nudged: boolean;
      /** Already refilled when first seen (a daemon restart): it may have been
       *  nudged before, so only the next compaction's fallback reminds it. */
      fullAtFirstLook: boolean;
    }
  >();
  /** Why revive finds sessions off: the machine booted again, or only cld-gui did. */
  private reviveCause: 'reboot' | 'restart' = 'reboot';
  /** T-0091: when the engine last revived each project on its own (24 h; revive-guard.json). */
  private readonly attempts = new Map<string, number[]>();
  /** T-0091: projects the engine gave up on (crash loop), with the last error (revive-guard.json). */
  private readonly gaveUp = new Map<string, string>();
  /** revive() or a watch pass is running: the watch does not start another. */
  private watching = false;
  // ponytail: one flag for the one provider with a daemon (Claude); per provider when D5 adds another.
  private daemonWasUp = false;
  private hostIdentity: string | null = null;
  /** The last start error of the watch's revives, for the mark when it gives up. */
  private readonly lastError = new Map<string, string>();
  /** D5 (6.3): agents revive and the watch skipped (no provider, or it is not ready), logged once. */
  private readonly skipLogged = new Set<string>();

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
    this.loadReviveGuard();
    const claude = new ClaudeAgent({
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
    this.agents = new Map([claude, ...(opts.agents ?? [])].map((a) => [a.id, a]));
  }

  /** The agent providers, by id (the assignments' `provider`). */
  private readonly agents: Map<string, AgentProvider>;

  /** The provider that drives `p` (its assignment's), or undefined when this build has none. */
  private agentOf(p: ProjectRecord): AgentProvider | undefined {
    return this.agents.get(p.provider ?? DEFAULT_PROVIDER);
  }

  /** D5: this build has provider `id` and it can start here (its CLI is installed). */
  providerReady(id: string): boolean {
    const agent = this.agents.get(id);
    return !!agent && !agent.ready?.();
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
    o: { task?: string; group?: { roomId: string; messageId: string }; messageId?: string },
  ): Promise<'typed' | 'notReady' | 'failed'> | null {
    const p = this.find(name);
    const agent = p && this.agentOf(p);
    if (!p || !agent?.deliver) return null;
    return agent.deliver(p, text, {
      ...(o.task && { task: o.task }),
      ...(o.messageId && { messageId: o.messageId }),
      ...(o.group && { group: { id: o.group.roomId, messageId: o.group.messageId } }),
    });
  }

  /** revive and the watch leave an agent that cannot start alone: no inbox notice, no count. */
  private skipped(p: ProjectRecord): boolean {
    const why = this.notReady(p);
    if (!why) {
      this.skipLogged.delete(p.name);
      return false;
    }
    if (!this.skipLogged.has(p.name)) {
      this.skipLogged.add(p.name);
      this.log(`"${p.name}": ${why}; not revived`);
    }
    return true;
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

  /** The durable identity of this cld-gui installation, or null when its file is unsafe. */
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
    this.reviveCause = this.bootChanged() ? 'reboot' : 'restart';
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
    const live = new Set(this.projects.filter((p) => this.holder(p)).map((p) => p.name));
    for (const name of this.liveNames) {
      if (live.has(name)) continue;
      const p = this.find(name);
      if (p?.wantRunning && !this.running.has(name) && !this.renewals.has(name)) {
        this.lookForAdoption(p);
        continue;
      }
      this.pendingAdoptions.delete(name);
      this.opts.event?.('orch_exit', 'engine', { name, code: null });
    }
    this.liveNames = new Set([...live, ...this.pendingAdoptions.keys()]);
    this.checkCompactions();
    const warnings = [...this.agents.values()]
      .map((a) => a.warning?.() ?? null)
      .filter((w): w is string => w !== null);
    for (const w of warnings) if (!this.daemonWarnings.includes(w)) this.log(`warning: ${w}`);
    this.daemonWarnings = warnings;
    // Keep the office running until the bounded re-look decides whether this
    // was a death or Claude Code's own daemon moving the same session to a new pid.
    if (this.pendingAdoptions.size) return;
    // A turn starting or ending (the files' status) changes the office's busy (T-0043).
    const sig = JSON.stringify([
      this.state(),
      this.live.map((l) => [l.sessionId, l.status]),
      [...this.renewals],
      [...this.compactions].map(([name, c]) => [name, c.count]),
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
      } catch (err) {
        this.log(`could not save ${this.file}: ${String(err)}`);
      }
    }
  }

  /** Every registered project's folder (T-0020's repository panel); not a Worker's. */
  folders(): Array<{ name: string; folder: string }> {
    return this.leads().map((p) => ({ name: p.name, folder: p.folder }));
  }

  /** An agent's own folder (a Worker may work in a worktree), or undefined. */
  folderOf(name: string): string | undefined {
    return this.find(name)?.folder;
  }

  // ── T-0019: what cld-gui send, job and renew ask ─────────────

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
        provider: p.provider ?? DEFAULT_PROVIDER,
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

  /** RENEW-STUCK: a renewal of `name` is pending (the office row's `renewing`). */
  renewPending(name: string): boolean {
    return this.renewals.has(name);
  }

  /**
   * A messenger message wakes only a project Claude retired for idleness. The
   * caller then types that original message into the freshly resumed session,
   * so there is no automatic recovery turn in front of it.
   */
  async wake(name: string): Promise<boolean> {
    // Nothing is started that could not be saved (commit refuses a broken registry).
    if (this.broken) {
      this.log(`wake "${name}": not started (${this.file}: ${this.broken})`);
      return false;
    }
    let p = this.find(name);
    if (!p || !p.wantRunning || !this.retiredForIdleness(p) || this.running.has(name)) return false;
    this.running.add(name);
    let out: Outcome;
    try {
      out = await this.enqueue(async () => {
        this.refresh();
        p = this.find(name);
        if (!p || !p.wantRunning || this.holder(p)) return { ok: false, error: 'already live' };
        if (!this.retiredForIdleness(p)) return { ok: false, error: 'not resting' };
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
   * cld-gui renew, called by the orchestrator as its turn's last
   * step. Answers at once; then, once that turn is over: the handoff into the
   * inbox, the old session stopped and gone, a new conversation under the same
   * name (stopping first: two live sessions of one name make Claude call the
   * new one "<name> (2)"), whose first message is the inbox. A failed start
   * loses nothing: the handoff waits in the inbox, the old conversation can
   * be resumed.
   */
  renew(
    name: string,
    message: string,
    source: string,
  ): { ok: true } | { ok: false; code: string; error: string } {
    const p = this.find(name);
    if (!p) return { ok: false, code: 'unknown_project', error: koText('project_unknown', { name }) };
    if (this.broken)
      return {
        ok: false,
        code: 'daemon_error',
        error: koText('registry_unreadable'),
      };
    if (this.renewals.has(name))
      return {
        ok: false,
        code: 'renew_pending',
        error: koText('renew_pending', { name }),
      };
    if (this.running.has(name))
      return { ok: false, code: 'busy', error: koText('project_busy_quoted', { name }) };
    const r: RenewRecord = { name, message, source, requestedAt: Date.now() };
    this.saveRenewal(r);
    this.launchRenewal(p, r);
    this.refresh(); // the office row's `renewing`
    return { ok: true };
  }

  private launchRenewal(p: ProjectRecord, r: RenewRecord): void {
    this.renewals.add(p.name);
    void this.renewRun(p, r).finally(() => {
      this.renewals.delete(p.name);
      this.renewCancel.delete(p.name); // a run that threw must not cancel the next renewal
    });
  }

  /** Write a pending renewal's record; a failed write leaves it in memory only (logged). */
  private saveRenewal(r: RenewRecord): void {
    try {
      writeAtomic(renewFile(this.home, r.name), JSON.stringify(r));
    } catch (err) {
      this.log(`renew "${r.name}": not saved, a restart would lose it (${String(err)})`);
    }
  }

  /** start(): every renewal a stopped daemon left pending goes on where it was. */
  private resumeRenewals(): void {
    let files: string[];
    try {
      files = fs.readdirSync(renewDir(this.home)).filter((f) => f.endsWith('.json'));
    } catch {
      return; // none
    }
    for (const f of files) {
      const file = path.join(renewDir(this.home), f);
      let r: RenewRecord;
      try {
        r = JSON.parse(fs.readFileSync(file, 'utf-8')) as RenewRecord;
        if (typeof r.name !== 'string' || typeof r.message !== 'string') throw new Error('bad record');
      } catch (err) {
        this.log(`${file}: unreadable, not resumed (${String(err)})`);
        continue;
      }
      const p = this.find(r.name);
      if (!p) {
        this.log(`${file}: no project "${r.name}", not resumed (its handoff stays in the file)`);
        continue;
      }
      this.log(`renew "${r.name}": resumed after a restart (asked ${shortStamp(r.requestedAt)})`);
      this.launchRenewal(p, r);
    }
  }

  private async renewRun(p: ProjectRecord, r: RenewRecord): Promise<void> {
    const { message, source } = r;
    const oldId = p.sessionId ?? null;
    const file = renewFile(this.home, p.name);
    let queued = r.queued === true;
    const finish = (ok: boolean, sessionId: string | null, code?: string, error?: string) => {
      // Over: the record goes. A handoff that never reached the inbox is kept beside it.
      try {
        if (queued) fs.rmSync(file, { force: true });
        else {
          fs.renameSync(file, `${file}.failed`);
          this.log(`renew "${p.name}": its handoff is kept in ${file}.failed`);
        }
      } catch (err) {
        this.log(`renew "${p.name}": ${file}: ${String(err)}`);
      }
      this.renewals.delete(p.name);
      this.renewCancel.delete(p.name);
      this.log(`renew "${p.name}": ${ok ? `ok ${sessionId?.slice(0, 8)}` : `failed (${error})`}`);
      this.opts.event?.('orch_renew', source, {
        name: p.name,
        old_session_id: oldId,
        session_id: sessionId,
        ok,
        ...(code && { code, error }),
      });
      this.refresh();
    };
    // 1. The caller's turn ends (counted from the request, across a restart). `shell` is an
    // ended turn whose run_in_background shell lives on: stopping the session ends it anyway.
    const end = r.requestedAt + this.t.renewWaitMs;
    let h: Live | null;
    const cancelled = 'cancelled';
    const why = '사용자가 멈춰 새 대화로 넘기지 않았어요';
    for (;;) {
      if (this.disposed) return;
      if (this.renewCancel.has(p.name)) return finish(false, null, cancelled, why);
      this.live = this.readLive();
      h = this.holder(p);
      if (h && h.kind !== 'background')
        return finish(false, null, 'terminal', '터미널에서 열린 대화는 여기서 넘길 수 없어요');
      if (!h || turnEnded(h.status)) {
        this.log(`renew "${p.name}": turn over (${h ? `status ${h.status}` : 'no live session'})`);
        break;
      }
      if (Date.now() >= end)
        return finish(false, null, 'not_idle', '턴이 끝나지 않아 새 대화로 넘기지 않았어요');
      await this.sleep(this.t.renewPollMs);
    }
    // 2. The handoff waits in the inbox for the new conversation.
    if (!queued) {
      if (!(this.opts.writeInbox?.(p.name, message) ?? false))
        return finish(false, null, 'queue_failed', '인수인계를 inbox에 쓰지 못했어요');
      queued = true;
      this.saveRenewal({ ...r, queued });
    }
    // 3, 4. Stop the old one until it is gone, then a new conversation (one action at a time).
    this.running.add(p.name);
    let out: Outcome;
    try {
      out = await this.enqueue(async (): Promise<Outcome> => {
        if (this.renewCancel.has(p.name)) return { ...fail(why), code: cancelled };
        this.refresh();
        const live = this.holder(p);
        if (live) {
          const r = await this.stopSession(live);
          if (!r.ok) return { ...r, code: 'stop_failed' };
        }
        const r = await this.startProject(this.find(p.name) ?? p, source, true);
        return r.ok ? r : { ...r, code: 'start_failed' };
      });
    } catch (err) {
      out = { ...fail(err instanceof Error ? err.message : String(err)), code: 'start_failed' };
    } finally {
      this.running.delete(p.name);
    }
    const now = this.find(p.name)?.sessionId ?? null;
    if (out.ok) finish(true, now);
    else finish(false, null, out.code, out.error);
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

  /**
   * Compactions of the projects with a nudge (opt-in): Claude writes a
   * compact_boundary record into the transcript each time (the count of
   * same). After the configured count, renew waits for the post-compaction
   * context to refill. Read only a changed tail for opted-in projects; a
   * conversation first seen is only counted, so a restart never nudges again.
   */
  private checkCompactions(): void {
    for (const p of this.projects) {
      if (!p.compactionNudge) continue;
      const h = this.holder(p);
      if (h?.kind !== 'background' || !h.agent.compaction) continue;
      const { mark, fillPct: fillOf } = h.agent.compaction;
      const file = h.agent.transcript(h);
      let size: number;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue;
      }
      let c = this.compactions.get(p.name);
      const first = !c || c.sessionId !== h.sessionId;
      if (!c || first || size < c.offset)
        this.compactions.set(
          p.name,
          (c = {
            sessionId: h.sessionId,
            offset: 0,
            count: 0,
            carry: '',
            nudged: false,
            fullAtFirstLook: false,
          }),
        );
      if (size === c.offset) continue;
      let found = 0;
      try {
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(1024 * 1024);
          for (let at = c.offset; at < size;) {
            const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - at), at);
            if (n <= 0) break;
            const text = c.carry + buf.toString('latin1', 0, n);
            found += text.split(mark).length - 1;
            c.carry = text.slice(-(mark.length - 1));
            at += n;
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        continue;
      }
      c.offset = size;
      c.count += found;
      if (found && !first)
        this.opts.event?.('compacted', 'engine', { name: p.name, count: c.count });
      if (c.nudged || c.count < p.compactionNudge) continue;
      // The tail is read only here: an opted-in conversation past M, not yet
      // nudged, whose transcript grew.
      const fillPct = fillOf(file) ?? 0; // unknown: never "full"
      const full = fillPct >= RENEW_FILL_PCT;
      if (first) {
        c.fullAtFirstLook = full;
        continue;
      }
      // A later boundary proves that a refill passed between checks. Do not let
      // a fourth compaction silently replace the renew the user asked for.
      const fallback = found > 0 && c.count > p.compactionNudge;
      if (full && !c.fullAtFirstLook) {
        c.nudged = true;
        this.opts.nudge?.(p.name, c.count, fillPct);
      } else if (fallback) {
        c.nudged = true;
        this.opts.nudge?.(p.name, c.count, RENEW_FILL_PCT);
      }
    }
  }

  private find(name: string): ProjectRecord | undefined {
    return this.projects.find((p) => p.name === name);
  }

  /** The live session that is this project's (of its provider): its conversation (any
   *  kind), or a background session with its name in its folder. Background first. */
  private holder(p: ProjectRecord): Live | null {
    const agent = this.agentOf(p);
    const assignment = assignmentOf(p);
    const mine = this.live.filter(
      (s) =>
        s.agent === agent &&
        ((s.assignmentId !== undefined && s.assignmentId === assignment) ||
          (p.sessionId !== undefined && s.sessionId === p.sessionId) ||
          (this.claims(p, s) && !this.contested(p, (q) => this.claims(q, s), s.name, s.sessionId))),
    );
    const found = mine.find((s) => s.kind === 'background') ?? mine[0] ?? null;
    if (found || !agent || agent.capabilities.lifetime !== 'run' || !p.wantRunning || agent.ready?.())
      return found;
    // D5: an on assignment of a 'run' provider with no run is resting (never in this.live, so
    // followConversations and the rest never see it).
    return {
      id: `rest:${assignment ?? p.name}`,
      pid: 0,
      cwd: p.folder,
      kind: 'background',
      sessionId: '',
      name: p.name,
      status: 'idle',
      resting: true,
      agent,
      ...(assignment && { assignmentId: assignment }),
    };
  }

  /** A background session of `q`'s provider with `q`'s session name in `q`'s folder. */
  private claims(q: ProjectRecord, s: Live): boolean {
    return s.kind === 'background' && s.agent === this.agentOf(q) && this.claimsName(q, s.name, s.cwd);
  }

  /** A session named as `q`'s (its provider's rule: Claude's `<name> (N)`) in `q`'s folder. */
  private claimsName(q: ProjectRecord, name: string | null | undefined, dir: string): boolean {
    const agent = this.agentOf(q);
    return !!agent && agent.nameMatches(name, sessionName(q)) && samePath(dir, q.folder, this.host);
  }

  /** D3: two agents of one provider in one folder whose session names match either way: a
   *  live session of one could be taken for the other's (neither then takes it). */
  private collide(a: ProjectRecord, b: ProjectRecord): boolean {
    const agent = this.agentOf(a);
    return (
      !!agent &&
      agent === this.agentOf(b) &&
      samePath(a.folder, b.folder, this.host) &&
      (agent.nameMatches(sessionName(a), sessionName(b)) ||
        agent.nameMatches(sessionName(b), sessionName(a)))
    );
  }

  /**
   * Another agent in the same folder claims this session by name too (a store carried
   * over from D2, or edited by hand): it is never guessed to be `p`'s (only its own
   * conversation id makes it so). Logged once per agent and session.
   */
  private contested(
    p: ProjectRecord,
    claimedBy: (q: ProjectRecord) => boolean,
    name: string | null | undefined,
    sessionId: string | null | undefined,
  ): boolean {
    const others = this.projects.filter((q) => q !== p && claimedBy(q));
    if (!others.length) return false;
    const key = `${p.name}\0${sessionId ?? name}`;
    if (!this.contestedLogged.has(key)) {
      this.contestedLogged.add(key);
      this.log(
        `"${p.name}": live session "${name}" (${sessionId?.slice(0, 8) ?? '-'}) also matches ${others.map((q) => `"${q.name}"`).join(', ')} in the same folder; not followed (give them different names or titles)`,
      );
    }
    return true;
  }

  state(): EngineState {
    const warnings = [
      this.broken &&
        (this.broken === SWAP_UNFINISHED
          ? SWAP_UNFINISHED
          : koText('registry_broken', { file: this.file, why: this.broken })),
      ...this.daemonWarnings,
    ].filter((w): w is string => !!w);
    const choices = this.agentChoices.discover();
    return {
      type: 'engineState',
      projects: this.projects.map((p): EngineProject => {
        const h = this.holder(p);
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
        const project = role ? this.projectOf(name) : null;
        const sessionId = h?.sessionId || p.sessionId;
        const gave = !h && wantRunning ? this.gaveUp.get(name) : undefined;
        const agent = this.agentOf(p);
        const cannot = !agent
          ? unknownProvider(provider ?? DEFAULT_PROVIDER)
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
          ...(!h && this.untrusted.has(name) && { needsTrust: true }),
          ...(this.trusting.has(name) && { trusting: true }),
          ...(cannot
            ? { downNote: cannot }
            : !h && wantRunning && idleRetired
              ? { downNote: koText('down_idle') }
              : gave !== undefined && { downNote: koText('down_gave_up', { why: gave }) }),
        };
      }),
      ...(Object.keys(choices).length > 0 && { agentChoices: choices }),
      ...(warnings.length > 0 && { warnings }),
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

  /**
   * Is the project's session working? Its file's status, as the messenger reads
   * it (the typing indicator and 보냄(대기 중) agree); else the provider row's.
   * `busy` also holds while only a background task runs (a sleep loop, a
   * sub-agent): a main turn that ended by its transcript (the messenger's
   * turnOver) is rest, not "thinking".
   */
  private busyOf(h: Live, fallback: boolean | null, rowTranscript?: string | null) {
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
    let seen = this.turnSeen.get(file);
    // An unchanged file settles a finished turn for good; a running one is read
    // again soon (a text-only reply ends its turn only once it is quiet).
    if (!seen || seen.sig !== sig || (!seen.over && now - seen.at >= MESSENGER_TIMING.quietMs)) {
      seen = { sig, over: turnOver(tail(file), now, MESSENGER_TIMING.quietMs), at: now };
      this.turnSeen.set(file, seen);
    }
    return !seen.over;
  }

  /**
   * The office with one entry per project (key `engine:<name>`) in its room;
   * the Claude provider's rows of the same conversation fold into it (also the
   * pid-less rows `claude agents --json` keeps after a reboot).
   */
  apply(world: World): World {
    const absorbed = new Set<AgentEntry>();
    const entries = this.projects.map((p): AgentEntry => {
      const h = this.holder(p);
      const ids = new Set([p.sessionId, h?.sessionId].filter(Boolean));
      const rows = world.agents.filter(
        (a) =>
          (a.sessionId !== null && a.sessionId !== undefined && ids.has(a.sessionId)) ||
          (a.bg !== null &&
            this.claimsName(p, a.name, a.dir) &&
            !this.contested(p, (q) => this.claimsName(q, a.name, a.dir), a.name, a.sessionId)),
      );
      rows.forEach((a) => absorbed.add(a));
      const row = h ? (rows.find((a) => a.sessionId === h.sessionId) ?? rows[0]) : undefined;
      const c = this.compactions.get(p.name);
      return {
        ...ENTRY_DEFAULTS,
        // The count the board's 컴팩션 N회 shows: the stat's 압축 N/M must agree (10-22 18:26).
        compactions: h && c?.sessionId === h.sessionId ? c.count : 0,
        key: `engine:${p.name}`,
        name: p.name,
        dir: p.folder,
        title: p.title ?? null,
        tab: roomOf(p),
        order: 0,
        state: h ? 'running' : 'off',
        // The session file's status, as the messenger reads it to queue (T-0043:
        // the typing indicator and 보냄(대기 중) agree); else the provider row's.
        busy: !h ? null : this.busyOf(h, row?.busy ?? null, row?.transcript),
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
        rooms.push({ name: e.tab, kind: e.tab === OPS_ROOM ? 'ops' : 'orch', order: 0 });
    return { agents, rooms: rooms.map((r, i) => ({ ...r, order: i + 1 })) };
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
    const reply = ({ detail, ...o }: Outcome): EngineActionResult => ({
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
    if (action === 'stop' && this.renewals.has(name)) this.renewCancel.add(name);
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
    const had = this.attempts.delete(name) || this.gaveUp.has(name);
    this.gaveUp.delete(name);
    this.lastError.delete(name);
    if (had) this.saveReviveGuard();
  }

  private loadReviveGuard(): void {
    let o: Record<string, { attempts?: unknown; gaveUp?: unknown }>;
    try {
      o = JSON.parse(fs.readFileSync(reviveGuardFile(this.home), 'utf-8')) as typeof o;
    } catch {
      return; // none yet (or unreadable: the counts start over, as before TOKEN-GUARD)
    }
    for (const [name, g] of Object.entries(o ?? {})) {
      if (Array.isArray(g?.attempts))
        this.attempts.set(name, g.attempts.filter((t): t is number => typeof t === 'number'));
      if (typeof g?.gaveUp === 'string') this.gaveUp.set(name, g.gaveUp);
    }
  }

  // ponytail: keyed by name, so a rename starts its count over; key by assignmentId if that matters.
  private saveReviveGuard(): void {
    const o: Record<string, { attempts: number[]; gaveUp?: string }> = {};
    for (const name of new Set([...this.attempts.keys(), ...this.gaveUp.keys()]))
      o[name] = {
        attempts: this.attempts.get(name) ?? [],
        ...(this.gaveUp.has(name) && { gaveUp: this.gaveUp.get(name) }),
      };
    try {
      writeAtomic(reviveGuardFile(this.home), JSON.stringify(o));
    } catch (err) {
      this.log(`${reviveGuardFile(this.home)}: ${String(err)}; revive counts kept in memory only`);
    }
  }

  /**
   * TOKEN-GUARD (TG-03): may the engine revive `name` on its own now? Every revive is a resumed
   * conversation and its 자동 복구 turn, so they are bounded: the reviveLimit-th inside
   * reviveWindowMs, or one past reviveDayLimit in 24 h, leaves it down (marked, one log line,
   * one orch_giveup), and each watch revive waits reviveBackoffMs * 2^(k-1) after the one before
   * (a daemon start's revive is the recovery a restart or reboot is for: counted, not delayed).
   * Counts and the give-up survive a daemon restart; a person's start or stop clears them.
   */
  private reviveBudget(name: string, backoff = true): 'go' | 'wait' | 'stop' {
    if (this.gaveUp.has(name)) return 'stop';
    const now = this.now();
    const day = (this.attempts.get(name) ?? []).filter((t) => now - t < DAY_MS);
    const burst = day.filter((t) => now - t < this.t.reviveWindowMs).length + 1 >= this.t.reviveLimit;
    if (burst || day.length >= this.t.reviveDayLimit) {
      this.attempts.set(name, day);
      const error =
        this.lastError.get(name) ??
        (burst ? koText('stopped_n_times', { count: this.t.reviveLimit }) : koText('stopped_n_per_day', { count: day.length + 1 }));
      this.gaveUp.set(name, error);
      this.saveReviveGuard();
      this.log(
        burst
          ? `watch "${name}": died ${this.t.reviveLimit} times within ${Math.round(this.t.reviveWindowMs / 60_000)} min; left down (${error})`
          : `watch "${name}": revived ${day.length} times in 24 h; left down (${error})`,
      );
      this.opts.event?.('orch_giveup', 'engine', {
        name,
        error,
        reason: burst ? 'crash_loop' : 'day_cap',
      });
      this.opts.changed?.();
      return 'stop';
    }
    const last = day.at(-1);
    if (backoff && last !== undefined && now - last < this.t.reviveBackoffMs * 2 ** (day.length - 1))
      return 'wait';
    this.attempts.set(name, [...day, now]);
    this.saveReviveGuard();
    return 'go';
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
    if ((w.provider ?? DEFAULT_PROVIDER) !== DEFAULT_PROVIDER || !this.agentOf(w))
      return koText('lead_claude_only');
    const lead = this.leadOf(w);
    if (!lead) return koText('worker_lead_missing');
    for (const n of held ? [w.name, lead.name] : []) {
      if (this.running.has(n)) return koText('project_busy', { name: n });
      if (this.renewals.has(n)) return koText('project_renewing', { name: n });
      if (this.pendingAdoptions.has(n)) return koText('project_readopting', { name: n });
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
    if (req.action === 'add' && (req.role || req.project)) return this.addWorker(req);
    if (req.action === 'add') {
      const out = this.add(req);
      if (out.ok && person) this.consented.add(req.name);
      return out;
    }
    const p = this.find(req.name);
    if (!p) return fail(koText('project_unknown_short'));
    if (req.action === 'edit') return this.edit(p, req);
    if (req.action === 'remove') return this.remove(p);
    if (req.action === 'promote') return this.promote(p, req.oldLead ?? 'worker', source);
    if (req.action === 'stop') return this.stopProject(p);
    if (req.action === 'restart') return this.restartProject(p, source);
    return this.startProject(p, source, false, false, person);
  }

  // ── Registry actions ────────────────────────────────────────

  /** add/edit's optional fields: validated values to set, and keys to clear. */
  private fields(
    req: EngineAction,
  ): { set: Partial<ProjectRecord>; clear: Array<keyof ProjectRecord> } | { error: string } {
    const set: Partial<ProjectRecord> = {};
    const clear: Array<keyof ProjectRecord> = [];
    for (const key of TEXT_FIELDS) {
      const raw = req[key];
      if (raw === undefined) continue;
      if (raw.trim() === '') {
        clear.push(key);
        continue;
      }
      let value = raw.trim();
      if (key === 'rulesFile') {
        const n = normalizeProjectPath(value, this.host);
        if ('error' in n) return { error: koText('rules_path_absolute') };
        value = n.path;
      }
      const error = CHECK[key](value);
      if (error) return { error };
      set[key] = value;
    }
    if (req.remoteControl === true) set.remoteControl = true;
    if (req.remoteControl === false) clear.push('remoteControl');
    if (req.alwaysOn === true) set.alwaysOn = true;
    if (req.alwaysOn === false) clear.push('alwaysOn');
    if (req.compactionNudge) set.compactionNudge = req.compactionNudge;
    else if (req.compactionNudge === 0) clear.push('compactionNudge');
    return { set, clear };
  }

  private add(req: EngineAction): Outcome {
    const bad = checkName(req.name);
    if (bad) return fail(bad);
    // D5: a Lead is a Claude session (a Codex Lead is the app-server one, after the MVP).
    if (req.provider !== undefined && req.provider !== DEFAULT_PROVIDER)
      return fail(koText('lead_claude_only'));
    if (this.find(req.name)) return fail(koText('name_taken'));
    const n = normalizeProjectPath(req.folder ?? '', this.host);
    if ('error' in n) return fail(n.error);
    const fields = this.fields(req);
    if ('error' in fields) return fail(fields.error);
    const f = checkFolder(n.path, this.host, req.mkdir === true);
    if (f.missing) return { ok: false, error: koText('folder_missing'), folderMissing: true };
    if (!f.path) return fail(f.error ?? koText('folder_missing'));
    const next = [
      ...this.projects,
      {
        projectId: createProjectId(),
        leadAssignmentId: createAssignmentId(),
        name: req.name,
        folder: f.path,
        // O4: the owner's default for new agents, unless the request names a mode (even an empty one).
        ...(req.permissionMode === undefined && seededPermission(this.home)),
        ...this.leadLaunch(req),
        ...fields.set,
        wantRunning: false,
      },
    ];
    const clash = this.sessionClash(next, [req.name]);
    if (clash) return fail(clash);
    this.commit(next);
    return { ok: true, ...warned(n.warnings) };
  }

  /**
   * D3: a Worker of a project, under its own name (unique among every project
   * and agent), stopped. Its folder is the project's unless given: a worktree,
   * inside the project's repository.
   */
  private addWorker(req: EngineAction): Outcome {
    const bad = checkName(req.name);
    if (bad) return fail(bad);
    if (this.find(req.name)) return fail(koText('name_taken'));
    if (!req.role || !WORKER_ROLES.includes(req.role))
      return fail(koText('worker_role'));
    const lead = req.project !== undefined ? this.find(req.project) : undefined;
    if (!lead || lead.role) return fail(koText('project_unknown_short'));
    if (req.room !== undefined) return fail(WORKER_ROOM);
    const provider = req.provider ?? DEFAULT_PROVIDER;
    const agent = this.agents.get(provider);
    if (!agent) return fail(koText('agent_unknown', { provider }));
    const why = this.providerFields(agent, req) ?? agent.ready?.();
    if (why) return fail(why);
    const fields = this.fields(req);
    if ('error' in fields) return fail(fields.error);
    const own = this.workerFolder(lead, req.folder, req.mkdir === true);
    if ('ok' in own) return own;
    const next = [
      ...this.projects,
      {
        projectId: lead.projectId,
        assignmentId: createAssignmentId(),
        role: req.role,
        name: req.name,
        folder: own.path ?? lead.folder,
        ...(own.path && { workFolder: own.path }),
        ...(provider === DEFAULT_PROVIDER && req.permissionMode === undefined && seededPermission(this.home)),
        ...fields.set,
        ...(provider !== DEFAULT_PROVIDER && { provider }),
        wantRunning: false,
      },
    ];
    const clash = this.sessionClash(next, [req.name]);
    if (clash) return fail(clash);
    this.commit(next);
    return { ok: true, ...warned(own.warnings) };
  }

  /** D5: why `req` does not fit a 'run' provider's agent (Claude-only options, Codex's effort
   *  words), or null. */
  private providerFields(agent: AgentProvider, req: EngineAction): string | null {
    if (agent.capabilities.lifetime !== 'run') return null;
    const claudeOnly = CLAUDE_ONLY.filter((k) => req[k] !== undefined && req[k] !== '' && req[k] !== false && req[k] !== 0);
    if (claudeOnly.length) return koText('codex_no_setting', { names: claudeOnly.join(', ') });
    if (req.effort?.trim() && !isCodexEffort(req.effort.trim()))
      return koText('codex_effort', { values: CODEX_EFFORTS.join(' ') });
    return null;
  }

  /** A Worker's own folder: none (the project's), or an existing (or, with `mkdir`, new)
   *  folder inside the project's folder or its repository's .worktrees/ (a worktree). */
  private workerFolder(
    lead: ProjectRecord,
    raw: string | undefined,
    mkdir: boolean,
  ): { path?: string; warnings: string[] } | Outcome {
    if (raw === undefined || raw.trim() === '') return { warnings: [] };
    const n = normalizeProjectPath(raw.trim(), this.host);
    if ('error' in n) return fail(n.error);
    if (samePath(n.path, lead.folder, this.host)) return { warnings: n.warnings };
    const roots = workerRoots(lead.folder);
    const inside = (dir: string) => {
      const d = realPath(dir);
      return roots.some((r) => d === r || d.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
    };
    // Checked before and after it may be created: never a folder made outside the repository.
    if (!inside(n.path)) return fail(WORKER_FOLDER);
    const c = checkFolder(n.path, this.host, mkdir);
    if (c.missing) return { ok: false, error: koText('folder_missing'), folderMissing: true };
    if (!c.path) return fail(c.error ?? koText('folder_missing'));
    if (!inside(c.path)) return fail(WORKER_FOLDER);
    return { path: c.path, warnings: n.warnings };
  }

  private edit(p: ProjectRecord, req: EngineAction): Outcome {
    if (p.role && req.room !== undefined) return fail(WORKER_ROOM);
    // ADR-0016 decision 2: an agent's provider is fixed when it is made.
    if (req.provider !== undefined && req.provider !== (p.provider ?? DEFAULT_PROVIDER))
      return fail(koText('agent_kind_fixed'));
    const agent = this.agentOf(p);
    const notFit = agent && this.providerFields(agent, req);
    if (notFit) return fail(notFit);
    if (req.role !== undefined || req.project !== undefined)
      return fail(koText('role_project_fixed'));
    const fields = this.fields(req);
    if ('error' in fields) return fail(fields.error);
    let folder = p.folder;
    let workFolder = p.workFolder;
    let warnings: string[] = [];
    if (req.folder !== undefined) {
      const lead = p.role ? this.leads().find((l) => l.projectId === p.projectId) : undefined;
      let want: string;
      if (lead) {
        const own = this.workerFolder(lead, req.folder, req.mkdir === true);
        if ('ok' in own) return own;
        want = own.path ?? lead.folder;
        workFolder = own.path;
        warnings = own.warnings;
      } else {
        const n = normalizeProjectPath(req.folder, this.host);
        if ('error' in n) return fail(n.error);
        want = n.path;
        warnings = n.warnings;
      }
      if (!samePath(want, p.folder, this.host)) {
        this.refresh();
        // A Worker without a folder of its own moves with its project.
        const moving = this.projects.filter(
          (x) => x === p || (!p.role && x.role && x.projectId === p.projectId && !x.workFolder),
        );
        if (moving.some((x) => this.holder(x)))
          return fail(koText('folder_change_running'));
        if (!lead) {
          const c = checkFolder(want, this.host, req.mkdir === true);
          if (c.missing) return { ok: false, error: koText('folder_missing'), folderMissing: true };
          if (!c.path) return fail(c.error ?? koText('folder_missing'));
          want = c.path;
        }
        folder = want;
      } else warnings = [];
    }
    const next: ProjectRecord = { ...p, folder, ...fields.set };
    if (workFolder) next.workFolder = workFolder;
    else delete next.workFolder;
    for (const k of fields.clear) delete next[k];
    const list = this.projects.map((x) => (x.name === p.name ? next : x));
    // Only a change of session name or folder is checked: an existing clash still saves other edits.
    const moves = !samePath(next.folder, p.folder, this.host);
    if (moves || sessionName(next) !== sessionName(p)) {
      // A Lead's move takes its Workers without a folder of their own along.
      const moved = list.filter(
        (x) =>
          x === next ||
          (moves && !p.role && x.role && x.projectId === p.projectId && !x.workFolder),
      );
      const clash = this.sessionClash(
        list,
        moved.map((x) => x.name),
      );
      if (clash) return fail(clash);
    }
    this.commit(list);
    const launchChanged = LAUNCH_FIELDS.some((k) => next[k] !== p[k]);
    return launchChanged && p.sessionId
      ? { ok: true, ...warned([koText('launch_options_next'), ...warnings]) }
      : { ok: true, ...warned(warnings) };
  }

  /** Why `next` cannot be saved: one of `changed` would share a session name with another
   *  agent in its folder (collide), or null. */
  private sessionClash(next: ProjectRecord[], changed: string[]): string | null {
    const linked = linkWorkers(next);
    for (const a of linked.filter((x) => changed.includes(x.name)))
      for (const b of linked)
        if (b.name !== a.name && this.collide(a, b))
          return koText('session_name_clash', { other: b.name, a: sessionName(a), b: sessionName(b) });
    return null;
  }

  /** A Worker, or a project with its Workers (D3): their background sessions stopped first. */
  private async remove(p: ProjectRecord): Promise<Outcome> {
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
    for (const x of gone) {
      this.tokens.drop(x.name);
      this.forgive(x.name);
    }
    return {
      ok: true,
      note: terminal
        ? koText('removed_terminal_kept')
        : koText('removed_history_kept'),
    };
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
    this.compactions.delete(name);
    this.pendingAdoptions.delete(name);
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
    // AUTO-TRUST: only for a project the person added here or saw marked (needsTrust), one try.
    if (
      !r.ok &&
      r.needsTrust &&
      trust &&
      agent.protocol === 'claude' &&
      (this.untrusted.has(p.name) || this.consented.has(p.name))
    ) {
      this.consented.delete(p.name);
      if ((await this.trustStep(p)).outcome === 'trusted') {
        this.log(`"${p.name}": folder trust answered; starting again`);
        r = await startOnce();
        if (r.ok) note = note ? `${note} · ${koText('trust_answered')}` : koText('trust_answered');
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
    if (resume && s.sessionId !== resume) note = koText('started_as_copy');
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
      ...(source === 'revive' && { revives_24h: this.attempts.get(p.name)?.length ?? 0 }),
    });
    this.opts.started?.(p.name);
    return { ok: true, bgId: s.id ?? printed ?? undefined, ...(note && { note }) };
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
    if (this.agentOf(p)?.protocol !== 'claude') return no('refused', koText('trust_claude_only'));
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

  /**
   * At daemon start: every project with wantRunning that is not live, one at
   * a time, 2 s apart, one log line each (the engine's revive).
   */
  async revive(): Promise<void> {
    this.watching = true;
    try {
      const retired = this.idleLooks();
      for (const name of this.projects.filter((p) => p.wantRunning).map((p) => p.name)) {
        const p = this.find(name);
        if (this.disposed) return;
        // A pending renewal (resumed by start()) starts its own new conversation.
        if (!p?.wantRunning || this.running.has(name) || this.renewals.has(name)) continue;
        if (this.skipped(p)) continue;
        this.refresh();
        if (this.holder(p)) {
          this.log(`revive "${name}": already live`);
          continue;
        }
        if (this.retiredForIdleness(p, retired)) {
          await this.idleRetired(p);
          continue;
        }
        // TOKEN-GUARD: a restart's revive counts too; one left down stays down.
        if (this.reviveBudget(name, false) !== 'go') continue;
        const out = await this.reviveOne(p, this.reviveCause);
        if (out.ok) this.lastError.delete(name);
        else this.lastError.set(name, out.error ?? '');
        await this.sleep(this.t.reviveGapMs);
      }
    } finally {
      this.watching = false;
    }
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
      if (firstPrompt) this.opts.writeInbox?.(name, reviveText(cause, shortStamp()));
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

  /** A persisted marker also survives a log rotation before the daemon restarts. */
  private retiredForIdleness(p: ProjectRecord, retired = this.idleLooks()): boolean {
    return p.idleRetired || retired(p);
  }

  /** One look per provider at what its daemon retired for idleness (Claude's daemon log),
   *  shared by one revive or watch pass. */
  private idleLooks(): (p: ProjectRecord) => boolean {
    const looks = new Map<AgentProvider, (ids: Array<string | undefined>) => boolean>();
    return (p) => {
      const agent = this.agentOf(p);
      if (!agent?.idleRetired) return false;
      let look = looks.get(agent);
      if (!look) looks.set(agent, (look = agent.idleRetired()));
      return look([p.backgroundId, p.sessionId]);
    };
  }

  /** Leave ordinary projects resting; always-on projects resume without a prompt or model turn. */
  private async idleRetired(p: ProjectRecord): Promise<void> {
    if (!p.idleRetired) {
      this.patch(p.name, { idleRetired: true });
      this.log(`watch "${p.name}": Claude retired its idle session; left resting`);
      this.opts.changed?.();
    }
    if (!p.alwaysOn || this.gaveUp.has(p.name)) return;
    // TOKEN-GUARD (S-04): Claude retires a session after hours of idleness. A "retirement" within
    // minutes of our resume is an old daemon-log line over a crash: that goes through the budget.
    const now = this.now();
    const last = this.idleResumedAt.get(p.name);
    if (last !== undefined && now - last < this.t.reviveWindowMs && this.reviveBudget(p.name) !== 'go')
      return;
    this.idleResumedAt.set(p.name, now);
    const out = await this.reviveOne(this.find(p.name) ?? p, 'died', false);
    if (!out.ok) this.lastError.set(p.name, out.error ?? '');
  }

  /** Start one bounded re-look for the same conversation; it never runs Claude or writes a prompt. */
  private lookForAdoption(p: ProjectRecord): void {
    if (this.pendingAdoptions.has(p.name)) return;
    const adoption: Adoption = {
      ...(p.sessionId && { sessionId: p.sessionId }),
      ...(p.backgroundId && { backgroundId: p.backgroundId }),
    };
    if (!adoption.sessionId && !adoption.backgroundId) return;
    this.pendingAdoptions.set(p.name, adoption);
    void this.waitFor(() => this.adoptionHolder(adoption), this.t.adoptMs).then((session) => {
      if (this.disposed || this.pendingAdoptions.get(p.name) !== adoption) return;
      this.pendingAdoptions.delete(p.name);
      const current = this.find(p.name);
      if (session && current?.wantRunning && !this.running.has(p.name)) {
        try {
          this.patch(p.name, {
            sessionId: session.sessionId,
            ...(session.id && { backgroundId: session.id }),
            idleRetired: false,
          });
        } catch (err) {
          this.log(`could not save ${this.file}: ${String(err)}`);
        }
        this.log(`watch "${p.name}": adopted Claude daemon respawn pid=${session.pid}`);
        this.opts.event?.('orch_start', 'engine', {
          name: p.name,
          session_id: session.sessionId,
          resumed: true,
          remote_control: current.remoteControl === true,
        });
      } else {
        this.liveNames.delete(p.name);
        this.opts.event?.('orch_exit', 'engine', { name: p.name, code: null });
      }
      this.refresh();
    });
  }

  /** A replacement must be a live background worker for the tracked conversation or job. */
  private adoptionHolder(adoption: Adoption): Live | null {
    return (
      this.live.find(
        (s) =>
          s.kind === 'background' &&
          ((adoption.sessionId !== undefined && s.sessionId === adoption.sessionId) ||
            (adoption.backgroundId !== undefined && s.id === adoption.backgroundId)),
      ) ?? null
    );
  }

  /**
   * T-0091: every watchMs, a wantRunning project whose session died while the
   * daemon runs is revived. The look is the sessions directory refresh() reads
   * anyway (a live session file and its pid): nothing is spawned unless a
   * session is found dead, and startProject then re-reads before it acts. A
   * project the user turned off (no wantRunning), one with an action or renew
   * in flight, or one waiting on a trust answer is left alone. The Nth dead
   * check inside the window is not revived: the project stays down, marked
   * (state().downNote), with one log line and one notice event.
   */
  private async watch(): Promise<void> {
    if (this.watching || this.disposed || this.broken || this.opts.readOnly) return;
    this.watching = true;
    try {
      this.refresh();
      for (const agent of this.agents.values()) {
        if (!agent.daemonUp) continue;
        const daemon = agent.daemonUp();
        if (this.daemonWasUp && daemon === false)
          this.log(`${agent.id} daemon is gone; its background sessions are revived below`);
        this.daemonWasUp = daemon === true;
      }
      const retired = this.idleLooks();
      for (const name of this.projects.filter((p) => p.wantRunning).map((p) => p.name)) {
        const p = this.find(name);
        if (this.disposed) return;
        if (!p?.wantRunning) continue;
        if (this.pendingAdoptions.has(name)) continue;
        if (this.holder(p)) {
          // Live again (a person started it elsewhere): the mark goes.
          if (this.gaveUp.delete(name)) this.saveReviveGuard();
          continue;
        }
        // D5 (F5): one left down while its CLI was missing comes back as revive would have.
        const waited = this.skipLogged.has(name);
        if (this.skipped(p)) continue;
        if (this.retiredForIdleness(p, retired)) {
          await this.idleRetired(p);
          continue;
        }
        if (
          this.running.has(name) ||
          this.renewals.has(name) ||
          this.untrusted.has(name) ||
          this.gaveUp.has(name)
        )
          continue;
        // A live file read mid-write or of a newer shape: this one may be alive. Next pass.
        if (this.agentOf(p)?.liveUnsure()) continue;
        if (this.reviveBudget(name) !== 'go') continue;
        const out = await this.reviveOne(p, waited ? this.reviveCause : 'died');
        if (out.ok) this.lastError.delete(name);
        else this.lastError.set(name, out.error ?? '');
        await this.sleep(this.t.reviveGapMs);
      }
    } finally {
      this.watching = false;
    }
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
      const t = setTimeout(resolve, ms);
      this.timers.push(t);
    });
  }

  private log(line: string): void {
    (this.opts.log ?? console.log)(`[cld engine] ${line}`);
  }
}
