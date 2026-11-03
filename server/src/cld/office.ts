/**
 * The cld-gui office: merges the providers into one World, keeps one
 * character per entry, generates the office layout, and sends the contract
 * messages (officeState, codexTasks, officeJobs, hwSample, usageState, gpuBoard,
 * officeEvent, statusOutput) -- broadcast on change and as snapshots to each new client.
 *
 * Providers: Claude Code (~/.claude/sessions, needs nothing else) and the
 * built-in engine's projects on top of it. A feature whose data nobody
 * supplies is simply absent (no message is sent for it).
 *
 * Footprint (T-0013): with no /ws viewer (a hidden page is none, T-0025)
 * nothing is spawned or sampled (only the presets folder stays). The first
 * viewer reloads the sessions; while anyone views, the Claude sessions are
 * re-read on a ~/.claude/sessions/ change (1 s debounce) and every 30 s, and HW
 * is sampled every 2 s. `claude agents --json` is only ClaudeSessions' fallback.
 */
import { type ChildProcess, spawn, type SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { isGoneName } from '../../../core/src/cld/goneAgent.js';
import { OWNER_LOOK_KEY } from '../../../core/src/cld/looks.js';
import { doingTaskTitle } from '../../../core/src/cld/notices.js';
import { type Coded, CodedError, koText, refused, refusedOf } from '../../../core/src/cld/serverText.js';
import type {
  BuildingState,
  CodexTask,
  CodexTasks as CodexTasksMsg,
  FolderList,
  HostInfo,
  HwSample,
  ListFolders,
  OfficeJob,
  OfficeSnapshot,
} from '../../../core/src/messages.js';
import { pickDiversePalette } from '../../../core/src/paletteUtils.js';
import type { AgentRuntime } from '../agentRuntime.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { setAdapterSettingDefaults } from '../configPersistence.js';
import {
  CODEX_USAGE_PROBE_COOLDOWN_MS,
  CODEX_USAGE_PROBE_KILL_GRACE_MS,
  CODEX_USAGE_PROBE_TIMEOUT_MS,
} from '../constants.js';
import { PALETTE_COUNT } from '../constants.js';
import { findClaude } from './agentCli.js';
import type { StandaloneAuth } from './auth.js';
import { BackgroundStore } from './background.js';
import { BuildingStore, loadBuilding, placeNewRooms } from './building.js';
import { CharacterPartStore, registerPartRoutes } from './characterParts.js';
import { CharacterPresets, registerCharacterRoutes } from './characterPresets.js';
import type { CharacterSpec } from './characters.js';
import { CharacterBinder } from './characters.js';
import { configDirectory } from './configPath.js';
import { ensureOwnerToken, ownerTokenMatches } from './controlIdentity.js';
import type { Lead } from './conversations.js';
import { Conversations } from './conversations.js';
import type { Footprints } from './decor.js';
import { DecorStore } from './decor.js';
import { deviceLabel, deviceSource } from './device.js';
import { Devroom } from './devroom.js';
import type { AgentChoicesReader } from './engine/agentCapabilities.js';
import { AgentChoicesCache } from './engine/agentCapabilities.js';
import { handleAgentRules, rulesDirFor } from './engine/agentRules.js';
import { CodexAgent } from './engine/agents/codex/codex.js';
import type { CodexRecord } from './engine/codex.js';
import { codexJson, CodexTasks, readCodex } from './engine/codex.js';
import type { Reply } from './engine/control.js';
import { answerControl, controlPath, listenControl, refuse } from './engine/control.js';
import { answerDecision, answerMode, approvalsPath, ApprovalStore } from './engine/delegation.js';
import type { EngineMode } from './engine/engine.js';
import { Engine, engineOn, nudgeText, renewText } from './engine/engine.js';
import {
  appendEvent,
  EngineEvents,
  eventsPath,
  isoLocal,
  rotateEvents,
  shortStamp,
} from './engine/events.js';
import { EventsTail } from './engine/eventsTail.js';
import { RepoError } from './engine/git/gitRun.js';
import { RepoManager } from './engine/git/repoManager.js';
import type { ProjectFolder } from './engine/git/repoRead.js';
import type { ReviewSendDeps } from './engine/git/reviewNotes.js';
import { deliverToWorker, sendReview } from './engine/git/reviewNotes.js';
import {
  defaultLocks,
  gpuDir,
  GpuQueue,
  unleasedFromProcesses,
  writeCollectorGpuHw,
} from './engine/gpu.js';
import { GpuBoardFold } from './engine/gpuBoard.js';
import { GroupMessages } from './engine/groupMessages.js';
import { GroupStore } from './engine/groups.js';
import { Jobs } from './engine/jobs.js';
import { leadTermBefore, readLeadHistory } from './engine/leadSwap.js';
import { LOG_PRUNE_INTERVAL_MS } from './engine/logPolicy.js';
import { pruneLogs } from './engine/logPrune.js';
import { McpTools } from './engine/mcpTools.js';
import type { MESSENGER_TIMING, Typist } from './engine/messenger.js';
import { Messenger } from './engine/messenger.js';
import { loadRegistry, registryPath } from './engine/registry.js';
import { CLD_BIN_DIR, cleanEnv } from './engine/sessionEnv.js';
import { buildSessionPath } from './engine/sessionPath.js';
import { answerTask, startForTask, tasksPath, TaskStore } from './engine/tasks.js';
import { answerWorktree, worktreeForTask } from './engine/taskWorktree.js';
import { TurnLedger } from './engine/turnLedger.js';
import { EzRulesFile, ezRulesPath } from './ezRules.js';
import { detectHostInfo, listFolders, parseListFolders } from './folders.js';
import type { SocketStepUp, WsSend } from './hooks.js';
import { cldHooks } from './hooks.js';
import { DiskUsageSource } from './hw/diskUsage.js';
import { hasHwReadings, HwSource, readTopProcesses, withoutDetail } from './hw/hwSource.js';
import { codexLabel, WHITEBOARD_TYPE } from './layout.js';
import { LevelStore, OWNER_COUNTED, ownerActionOf } from './levels.js';
import { MemoStore } from './memos.js';
import { handleNewAgentPermission, newAgentPermissionMessage } from './newAgentPermission.js';
import { OfficeChat } from './office/chat.js';
import { engineRoutes } from './office/engineRoutes.js';
import { type FloorPlan, OfficeFloors } from './office/floors.js';
import { OfficePermissions } from './office/permissions.js';
import { OfficeRooms } from './office/rooms.js';
import { WorkerRuns } from './office/workerRuns.js';
import { registerOwnerProfileRoutes } from './ownerProfile.js';
import { builtInPacksDir, PackStore } from './packs.js';
import { PinStore } from './pins.js';
import { aliasOf, deleteGoneConversation, type FormerName, readNameHistory } from './projectData.js';
import { parseProjectRepo, ProjectRepos } from './projectRepo.js';
import type { ClaudeSession } from './providers/claudeProvider.js';
import {
  ClaudeAgentsSource,
  ClaudeSessions,
  entriesFromSessions,
  findOnPath,
  transcriptPath,
} from './providers/claudeProvider.js';
import type { AgentEntry, World } from './providers/types.js';
import { PushService, PushStore } from './push.js';
import { registerPushImageRoute } from './pushImage.js';
import { RosterStore } from './roster.js';
import { STEPUP_REQUIRED } from './shell/gate.js';
import { SlashCatalogue } from './slashCommands.js';
import { staffFacts } from './staffStatus.js';
import {
  realStartPolicyDeps,
  registerStartPolicyRoutes,
  StartPolicyControl,
  testStartPolicyDeps,
} from './startPolicy.js';
import { engineJobsOutput, localStatusReport } from './statusReport.js';
import { TempStaff } from './tempStaff.js';
import { TrackingFeed } from './tracking/feed.js';
import { leadHistoryHop } from './transcriptHistory.js';
import { senderAlias } from './transcriptView.js';
import { managedInstall, registerUpdateRoutes, UpdateNotice } from './updateNotice.js';
import { claudeUsageUrl, type EarlyUsageReset, readMacKeychain, UsageSource } from './usage.js';
import { WorktreeWho } from './worktreeWho.js';
import { WorkViews } from './workView.js';

export const CLAUDE_POLL_MS = 30_000;
export const SESSIONS_DEBOUNCE_MS = 1_000;
export const HW_MS = 2_000;
const JOB_PROGRESS_MS = 10_000;
const REPORT_MS = 10_000;
/** While anyone watches, the messenger's transcript tails (T-0043) look for appended lines this often. */
export const CHAT_VIEW_POLL_MS = 1_500;
const CODEX_GRACE_MS = 5_000;
/** COMPACT-COFFEE: while anyone watches, the working PTY agents' screens are looked at this often
 *  for Claude Code's Compacting spinner (the visible screen only, ~2 ms each). */
const COMPACT_LOOK_MS = 2_000;
/** While anyone views: dead wrappers' tickets are swept this often (their end events fold the board). */
const GPU_SWEEP_MS = 30_000;
/** dist/cld-worker.js (T-0021): beside dist/cli.js, or the checkout's dist/ from the sources. */
export const CLD_WORKER: string | null =
  [
    path.join(__dirname, 'cld-worker.js'),
    path.resolve(__dirname, '../../../dist/cld-worker.js'),
  ].find((f) => fs.existsSync(f)) ?? null;
/** TERM-P1: dist/cld-ptyhost.js, our PTY host for `claude-pty` agents (as CLD_WORKER). */
export const CLD_PTYHOST: string | null =
  [
    path.join(__dirname, 'cld-ptyhost.js'),
    path.resolve(__dirname, '../../../dist/cld-ptyhost.js'),
  ].find((f) => fs.existsSync(f)) ?? null;
/** How often the temps per room are counted while anyone views (T-0041). */
const ROOM_SAMPLE_MS = 30_000;
const oneLineError = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 200);
};
const CODEX_USAGE_PROBE_ERROR = {
  denied: refused('usage_denied'),
  cooldown: refused('usage_cooldown'),
  missing: refused('usage_no_codex'),
  timeout: refused('usage_timeout'),
};
type ClaudeData = ReturnType<typeof entriesFromSessions>;

export interface OfficeOptions {
  runtime: AgentRuntime;
  store: AgentStateStore;
  readOnly: boolean;
  /** --allow-chat: background sessions get a 대화 terminal (officeState.chat). */
  chat?: boolean;
  /** Tests: the engine's PTY host script (default dist's); null keeps new agents on `claude --bg`,
   *  the path the Typist and PERM-PROMPT office tests were written for. */
  ptyHostScript?: string | null;
  /** A `claude attach` runs (~150 MB): no `claude agents --json` beside it. */
  attaching?: () => boolean;
  /** `list(spawn)`: spawn is true while someone views. */
  claude: Pick<ClaudeSessions, 'list'> | null;
  hw?: Pick<HwSource, 'sample'>;
  /** --lhm-port: LibreHardwareMonitor's web server (Windows, WSL; T-0030). */
  lhmPort?: number | null;
  /** --nvidia-smi: the binary to query the GPU with, or null (never queried). */
  nvidiaSmi?: string | null;
  defaultLayout?: Record<string, unknown> | null;
  catalog?: () => Footprints;
  /** Home dir for Claude's projects/ and the engine's files (tests). */
  home?: string;
  /** The `claude` the built-in engine (T-0018) runs; no engine without it. */
  engineClaude?: string;
  /** T-0110: reads the installed CLIs' choices for the orchestrator form (startOffice gives the real one). */
  agentChoices?: AgentChoicesReader;
  /** The PATH engine sessions and jobs get (engine/sessionPath.ts), built once at start. */
  sessionPath?: string | null;
  /** T-0019: types cld-gui sends into background sessions (the chat's attach manager). */
  typist?: Typist;
  /** T-0039: push.json (the standalone CLI's ~/.config/agent-tycoon); none: no Web Push. */
  pushFile?: string;
  /** T-0063: the first --allowed-host, the VAPID subject's https origin. */
  pushHost?: string;
  /** T-0021: dist/cld-worker.js (tests); default CLD_WORKER. */
  worker?: string | null;
  /** The on-demand usage probe is injectable so tests never run Codex. */
  codexUsageSpawnFn?: typeof spawn;
  codexUsageNow?: () => number;
  /** Short test-only timings; production uses the constants above. */
  codexUsageProbeTimeoutMs?: number;
  codexUsageProbeKillGraceMs?: number;
  /** Test-only: the messenger's timings (K1's notice window among them). */
  messengerTiming?: Partial<typeof MESSENGER_TIMING>;
}

export class Office {
  private claudeData: ClaudeData | null = null;
  private readonly usage: UsageSource;
  private lastCodexUsageProbe = 0;
  private codexUsageProbeChild: ChildProcess | null = null;
  private codexUsageProbeKillTimer: ReturnType<typeof setTimeout> | null = null;
  readonly engine: Engine | null;
  /** T-0019: the engine's events, messages, jobs and local socket. */
  private readonly engineEvents: EngineEvents | null;
  readonly messenger: Messenger | null;
  /** Persistent rooms and their append-only posts (engine projects only). */
  readonly groupStore: GroupStore | null;
  readonly groupMessages: GroupMessages | null;
  private readonly slash: SlashCatalogue;
  /** The messenger's chat routes: sends, holds, slash commands, chat and work views. */
  private readonly chat: OfficeChat;
  /** The messenger's group-room routes, room list and timelines. */
  private readonly rooms: OfficeRooms;
  readonly jobs: Jobs | null;
  /** T-0021: Codex tasks the engine runs, and the GPU reservation queue. */
  readonly codex: CodexTasks | null;
  /** D5: the Codex provider (Codex Workers' runs on `codex`). */
  private readonly codexAgent: CodexAgent | null;
  /** Filled after the HTTP listener selects its port; control status reports it
   * so the install manager never confuses a source daemon for this install. */
  private daemonPort: number | null = null;
  readonly gpuQueue: GpuQueue | null;
  /** T-0046 + T-0021: the GPU board, folded from the engine's gpu_* events. */
  private readonly gpuFold: GpuBoardFold | null;
  private control: net.Server | null = null;
  /** C6: delegate_task's approval store and the tools (set when the control socket starts). */
  private readonly approvals: ApprovalStore;
  private mcp: McpTools | null = null;
  private world: World;
  private readonly binder: CharacterBinder;
  private readonly codexBinder: CharacterBinder;
  /** T-0017: preset sheets and the look chosen per character name. */
  readonly characters: CharacterPresets;
  readonly parts: CharacterPartStore;
  /** T-0020: repositories and task worktrees of the projects (jobs and Codex use `repos.worktrees`). */
  readonly repos: RepoManager;
  /** P4: the dev room's viewers, stats and settings. */
  readonly devroom: Devroom;
  /** DEVROOM-PROJECT: 프로젝트 추가's check, git init and clone. */
  private readonly projectRepos: ProjectRepos;
  /** P3a: the released-version notice; null for a source install (nothing to update from here). */
  private readonly updates: UpdateNotice | null;
  /** R3: the start policy and its facts, in 설정. */
  private readonly startPolicy: StartPolicyControl;
  private readonly hw: Pick<HwSource, 'sample'>;
  /** A cached, on-demand disk walk for hardware-page viewers. */
  private readonly diskUsage: DiskUsageSource;
  /** A sample still running (LHM via curl.exe, nvidia-smi): the next tick waits for it. */
  private sampling = false;
  private readonly ezRules: EzRulesFile;
  /** T-0032: how this host writes folders, detected once. */
  readonly host: HostInfo;
  private readonly viewers = new Set<WsSend>();
  /** Viewers whose page is hidden (T-0025): connected, but nobody is looking. */
  private readonly hidden = new Set<WsSend>();
  /** When each viewer's page last said it is showing (U-49): a page repeats it while it shows. */
  private readonly lookedAt = new Map<WsSend, number>();
  private readonly views = new Map<
    string,
    { sends: Set<WsSend>; timer: ReturnType<typeof setInterval> }
  >();
  /** The office messenger (T-0043, the chat view of T-0014): transcript tails and open conversations. */
  private readonly conversations: Conversations;
  /** C3: what the messenger typed, which turn is whose (read by the DM view, contacts and push). */
  private readonly turnLedger = new TurnLedger();
  /** The read-only work view of a temp (T-0056): readers open only while someone looks. */
  private readonly work: WorkViews;
  /** Latest message per type (JSON), for change detection and snapshots. */
  private readonly latest = new Map<string, string>();
  /** While viewing: the HW tick and the claude safety poll. */
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private readonly hwViewers = new Set<WsSend>();
  private hwFastTimer: ReturnType<typeof setInterval> | null = null;
  private gpuHwTimer: ReturnType<typeof setInterval> | null = null;
  private gpuHwSampling = false;
  private sessionsWatcher: fs.FSWatcher | null = null;
  private claudeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Loads in flight: recompute() waits until every provider answered. */
  private loading = 0;
  /** T-0027: the floors, which rooms and characters are on which. */
  readonly building: BuildingStore;
  readonly decor: DecorStore;
  /** T-0065: the whiteboards' memos. */
  readonly memos: MemoStore;
  /** U-15: Lv, XP and 환생 per character. */
  private readonly levels: LevelStore;
  /** Events before the start's history read are history: they earn nothing. */
  private levelsLive = false;
  /** TEMP-PLATES: the per-project staff rosters and the temporary work bound to them. */
  private readonly roster: RosterStore;
  private readonly temps: TempStaff;
  /** DEVROOM-NAMES: who did a Codex run's worktree (its Worker or temp employee). */
  private readonly worktreeWho: WorktreeWho;
  /** TEMP-PLATES: looks picked for employees hired this run, until characters.json has them. */
  private readonly hireLooks = new Map<string, { palette: number; hueShift: number }>();
  /** U-30: the pinned conversations. */
  readonly pins: PinStore;
  /** PROJECT-DATA: name-history.json as last read (the messenger's aliases and gone contacts). */
  private nameHistory: FormerName[] = [];
  /** BACKGROUND: the isometric office's surroundings. */
  readonly background: BackgroundStore;
  /** 작업 현황 (DEV-BOARD): the reported tasks; everyone gets them as they change. */
  readonly tasks: TaskStore;
  /** U-48 phase 1: the agents' own work lists as tracked items, read only while someone views. */
  private readonly tracking: TrackingFeed;
  /** The project folders `tracking` last resolved a cwd against (JSON); a change forgets the cwd answers. */
  private trackingFolders = '';
  private readonly cwdProjects = new Map<string, string | null>();
  /** D6: the removed assignees the task board last went out with (JSON). */
  private sentRemoved = '[]';
  private lastBuildingError = '';
  private lastClaudeError = '';
  private started = false;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  /** T-0039: Web Push to devices that are not looking. */
  readonly push: PushService | null;
  /** PERM-PROMPT: engine sessions held by a permission dialog, and what each card shows. */
  private readonly permission: OfficePermissions;
  /** The floors, layout and seats (T-0027). */
  private readonly floors: OfficeFloors;
  /** Worker runs and Task worktrees: assignments, the worktree an agent starts in, the end of a run told to its Lead. */
  private readonly workerRuns: WorkerRuns;

  constructor(private readonly opts: OfficeOptions) {
    const home = opts.home ?? os.homedir();
    this.workerRuns = new WorkerRuns({
      opts,
      tasks: () => this.tasks,
      repos: () => this.repos,
      engine: () => this.engine,
      codex: () => this.codex,
      jobs: () => this.jobs,
      messenger: () => this.messenger,
      groupMessages: () => this.groupMessages,
    });
    this.slash = new SlashCatalogue({ home });
    this.host = detectHostInfo(opts.home ?? os.homedir());
    this.binder = new CharacterBinder(opts.runtime, opts.store);
    this.codexBinder = new CharacterBinder(opts.runtime, opts.store, CODEX_GRACE_MS);
    this.characters = new CharacterPresets({
      configDir: configDirectory(opts.home ?? os.homedir()),
      publish: (msg) => this.publish(msg),
      // Keys are names: an engine project's or a Claude session's; a temp employee's `emp:<id>`;
      // the owner's own character (OWNER-AVATAR).
      knownKey: (key) =>
        key === OWNER_LOOK_KEY ||
        this.world.agents.some((a) => a.name === key) ||
        (key.startsWith('emp:') && this.roster.allEmployees().some((e) => `emp:${e.id}` === key)),
    });
    const cldConfig = configDirectory(opts.home ?? os.homedir());
    this.parts = new CharacterPartStore(
      path.join(cldConfig, 'parts'),
      (msg) => this.publish(msg),
      new PackStore({ builtInDir: builtInPacksDir(), userDir: path.join(cldConfig, 'packs') }),
    );
    this.updates = this.makeUpdateNotice(opts);
    this.startPolicy = this.makeStartPolicy();
    const reviewDeps: ReviewSendDeps = {
      send: (r) =>
        this.messenger
          ? this.messenger.send(r)
          : Promise.resolve({ ok: false as const, ...refused('not_engine_project') }),
      names: () => this.engine?.names() ?? [],
      nameOf: (id) => this.workerRuns.nameOfAssignment(id),
      leadOf: (name) => this.engine?.projectOf(name) ?? undefined,
      task: (id) => this.tasks.get(id),
      setStatus: (id, status, by) => {
        const r = this.tasks.update(id, { status }, by);
        if (!r.ok) console.warn(`[cld] review ${id}: status not moved (${String(r.error)})`);
      },
      leadLine: (lead, task, text) => this.groupMessages?.system({ kind: 'review', task, from: lead, text }),
    };
    this.repos = new RepoManager({
      projects: () => this.projectFolders(),
      readOnly: opts.readOnly,
      configDir: configDirectory(opts.home ?? os.homedir()),
      looking: (send) => !this.hidden.has(send),
      // W2: the 작업실's "worktree 만들기" (the owner's: createdBy user).
      taskWorktree: (req, privileged, source) =>
        worktreeForTask(
          this.workerRuns.taskWorktreeDeps(),
          {
            taskId: req.taskId ?? '',
            assignee: req.assignee || null,
            ...(req.base && { base: req.base }),
            by: source,
            createdBy: 'user',
          },
          privileged,
          source,
        ),
      nameOf: (id) => this.workerRuns.nameOfAssignment(id),
      whoDid: (project, wtPath) => this.worktreeWho.of(project, wtPath),
      // Step ④ of the review loop: the boss's queue to the agent, the Task back to doing, a Lead line.
      reviewSend: (input) => sendReview(reviewDeps, input),
      // P4 에이전트에게 맡기기: the same delivery; a Task in review or done goes back to doing.
      conflictHandoff: (input) =>
        deliverToWorker(
          reviewDeps,
          input,
          koText('conflict_handoff_header', {
            task: input.taskId ?? input.worktree,
            worktree: input.worktree,
            path: input.path,
            base: input.base,
            files: input.files.join(', '),
          }),
          (to) => koText('sys_conflict_handoff', { worker: to, base: input.base, task: input.taskId ?? input.worktree }),
          ['review', 'done'],
        ),
      agentBusy: (name) => this.engine?.roster().find((a) => a.name === name)?.busy === true,
      autoCleanup: () => this.devroom.autoCleanupAfterMerge,
    });
    this.projectRepos = new ProjectRepos({
      host: this.host,
      readOnly: !!opts.readOnly,
      log: (line) => console.log(`[cld] projectRepo: ${line}`),
    });
    this.devroom = new Devroom({
      file: path.join(configDirectory(opts.home ?? os.homedir()), 'devroom.json'),
      repos: this.repos,
      readOnly: opts.readOnly,
      terminals: async () => {
        const host = this.engine?.pty.host;
        if (!host?.connected) return 0;
        const r = await host.request('list');
        return Array.isArray(r.terminals) ? r.terminals.length : 0;
      },
      hostPid: () => (this.engine?.pty.host.connected ? this.engine.pty.host.pid : undefined),
      previewOpen: (msg) => {
        this.opts.store.broadcast({ ...msg });
        // The phone that asked is looking at its page, so the push skips it (one per project per minute).
        this.push?.notify('question', null, msg.project, koText('preview_ask', { task: msg.task }), 'orchestrator', false, Date.now(), {
          target: { open: 'preview', project: msg.project, task: msg.task, ...(msg.url && { url: msg.url }) },
        });
      },
    });
    this.hw =
      opts.hw ??
      new HwSource({
        home: opts.home,
        lhmPort: opts.lhmPort,
        nvidiaSmi: opts.nvidiaSmi,
      });
    this.diskUsage = new DiskUsageSource({ home: opts.home });
    this.ezRules = new EzRulesFile(ezRulesPath(opts.home));
    this.building = new BuildingStore(
      path.join(configDirectory(opts.home ?? os.homedir()), 'building.json'),
    );
    this.decor = new DecorStore(path.join(configDirectory(home), 'decor.json'));
    this.memos = new MemoStore(path.join(configDirectory(home), 'memos.json'));
    // Nobody watching: the counters and their file only. A viewer's wake() reloads the
    // office, whose snapshot then carries the current levels (no snapshot built for nobody).
    this.levels = new LevelStore(path.join(configDirectory(home), 'levels.json'), () => {
      if (this.watching() > 0) this.publish<OfficeSnapshot>(this.officeState());
      this.publish(this.temps.message());
    });
    this.roster = new RosterStore(path.join(configDirectory(home), 'roster.json'));
    this.worktreeWho = new WorktreeWho({ dir: () => this.codex?.dir ?? null, roster: this.roster });
    this.levels.beforeWrite = () => this.roster.flushIfDirty();
    this.temps = new TempStaff({
      roster: this.roster,
      levels: this.levels,
      projectOf: (leadId) => this.rosterProjectOf(leadId),
      live: () => this.levelsLive,
      changed: () => {
        this.pinLooks();
        this.publish(this.temps.message());
      },
    });
    opts.store.on('broadcast', (m) => this.temps.observe(m));
    opts.store.on('agentRemoved', (id) => this.temps.leadGone(id));
    opts.runtime.subagentWatch.onContext = (leadId, toolId, tokens, max) =>
      this.temps.context(leadId, toolId, tokens, max);
    opts.store.on('broadcast', (m) => {
      if (!this.levelsLive || (m.type !== 'agentStatus' && m.type !== 'agentToolStart')) return;
      const id = m.id;
      const key = typeof id === 'number' ? this.binder.keyOf(id) : undefined;
      if (key) this.levels.observe(id as number, key, m);
    });
    opts.store.on('agentRemoved', (id) => this.levels.forget(id));
    this.pins = new PinStore(path.join(configDirectory(home), 'pins.json'));
    this.background = new BackgroundStore(path.join(configDirectory(home), 'background.json'));
    this.tasks = new TaskStore(
      tasksPath(home),
      () => {
        this.opts.store.broadcast({ ...this.tasks.message() });
        this.workerRuns.mergeDoneTasks();
      },
      undefined,
      {
        readOnly: opts.readOnly,
        live: () => {
          const map = this.workerRuns.assignments();
          return map && new Set(map.values());
        },
        // D3b: a Task's assignee shows under the name its assignment answers to now.
        nameOf: (id) => this.workerRuns.nameOfAssignment(id),
      },
    );
    this.workerRuns.seedDoneTasks();
    this.tracking = new TrackingFeed({
      home,
      watching: () => this.watching(),
      broadcast: (msg) => this.opts.store.broadcast({ ...msg }),
      projectOf: (a) => this.trackedProjectOf(a),
      codexDir: (id) => (this.codex ? (readCodex(this.codex.dir, id)?.dir ?? null) : null),
      projects: () => this.engine?.folders() ?? [],
      taskIds: () => new Set(this.tasks.list().map((t) => t.id)),
    });
    this.approvals = new ApprovalStore(approvalsPath(home), () => this.publishApprovals());
    this.usage = new UsageSource(
      {
        home,
        codexHome: process.env.CODEX_HOME ?? path.join(home, '.codex'),
        claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
        // ponytail: with a custom CLAUDE_CONFIG_DIR Claude Code names its Keychain item differently: the file only.
        keychain: process.platform === 'darwin' && !process.env.CLAUDE_CONFIG_DIR ? readMacKeychain : null,
        usageUrl: claudeUsageUrl(),
      },
      () => this.publishUsage(),
      (reset) => this.usageResetEarly(reset),
    );
    const engineOnHere = !!(opts.engineClaude && opts.claude);
    // D5: made before the engine (its provider), it reads the CodexTasks made after it.
    this.codexAgent = engineOnHere
      ? new CodexAgent({
          codex: () => this.codex,
          path: () => this.jobs?.env().PATH,
          project: (name) => {
            const project = this.engine?.projectOf(name);
            const folder = project ? this.engine?.folders().find((f) => f.name === project)?.folder : undefined;
            return project && folder ? { name: project, folder } : null;
          },
          attach: (task, run, by) => {
            const r = this.tasks.attach(task, run, by);
            if (!r.ok) console.warn(`[cld] codex ${run.ref}: not attached to ${task} (${String(r.error)})`);
          },
          taskTitle: (task) => this.tasks.get(task)?.title,
          // W2: the Task's recorded worktree, when it is this Worker's or nobody's.
          taskWorktree: (project, task, assignmentId) => this.workerRuns.codexTaskWorktree(project, task, assignmentId),
          mayUse: (project, dir, assignmentId) => this.workerRuns.codexMayUse(project, dir, assignmentId),
          stopJob: (job) => {
            const r = this.jobs?.stop(job, 'manager');
            return r?.ok ? { ok: true } : { ok: false, error: r && !r.ok ? r.error : undefined };
          },
          log: (line) => console.log(`[cld engine] ${line}`),
        })
      : null;
    this.engineEvents = engineOnHere
      ? new EngineEvents(eventsPath(home), (e) =>
          this.opts.store.broadcast({ type: 'officeEvent', ...e }),
        )
      : null;
    this.engine = engineOnHere
      ? new Engine({
          claudePath: opts.engineClaude!,
          ptyHostScript: opts.ptyHostScript !== undefined ? opts.ptyHostScript : CLD_PTYHOST,
          agentChoices: opts.agentChoices,
          sessionPath: opts.sessionPath,
          readOnly: opts.readOnly,
          home: opts.home,
          host: this.host,
          ...(this.codexAgent && { agents: [this.codexAgent] }),
          changed: () => this.recompute(),
          // D5 (F4): a Worker run's report that did not reach its Lead is tried again.
          tick: () => this.reportWorkerRuns(),
          event: (type, source, fields) => this.engineEvents?.append(type, source, fields),
          started: (name) => this.messenger?.deliverInbox(name),
          // W2: a Claude Worker given a Task's worktree starts there next time.
          assignedFolder: (p) => this.assignedFolder(p),
          writeInbox: (name, text) => this.messenger?.writeInbox(name, text) ?? false,
          nudge: (name, count, fillPct) =>
            void this.messenger?.send({
              to: name,
              text: nudgeText(count, fillPct),
              ifIdle: false,
              from: null,
              source: 'engine',
              kind: 'nudge', // S-05: dropped if a renewal comes first
            }),
          // D3b: the new Lead's first prompt (Tasks, running work, recent events).
          briefing: (project) => ({
            tasks: this.tasks.list({ project }),
            running: [
              ...(this.jobs?.officeJobs() ?? [])
                .filter((j) => !j.ended && j.project === project)
                .map((j) => `${j.label ?? 'job'} ${j.id}`),
              ...(this.codex?.tasks() ?? [])
                .filter((c) => !c.ended && c.project === project)
                .map((c) => `${c.title ?? 'Codex'} ${c.id}`),
            ],
            events: new EventsTail(eventsPath(home), () => undefined).primeLast(2_000),
          }),
          projectData: (change, names) => this.projectDataChange(change, names),
          swapped: ([lead, worker]) => {
            this.messenger?.resync([lead, worker]);
            this.mcp?.forget([lead, worker]);
            this.workerRuns.leadProposals(lead, worker);
            this.opts.store.broadcast({ ...this.tasks.message() });
          },
        })
      : null;
    // RENAME: a peer header's name as it is called now; a removed agent's as "(알 수 없음)".
    this.nameHistory = readNameHistory(home);
    senderAlias.of = this.engine
      ? (name, at) => {
          const a = aliasOf(this.nameHistory, name, at);
          return a === undefined ? undefined : isGoneName(a) ? koText('gone_agent') : a;
        }
      : undefined;
    // D3b: a Lead contact's history scrolls back into the old Leads' terms (lead-history.json).
    leadHistoryHop.hop = this.engine
      ? (file, start) =>
          leadTermBefore(readLeadHistory(home), file, start, (sid) =>
            this.engine?.leadProjectOfSession(sid) ?? null,
          )
      : undefined;
    this.groupStore = this.engine
      ? new GroupStore(
          home,
          () => this.engine?.names() ?? [],
          undefined,
          () => this.engine?.projectNames() ?? [], // 전체 = the projects (their Leads)
        )
      : null;
    this.messenger =
      this.engine && this.engineEvents
        ? new Messenger({
            home,
            engine: this.engine,
            typist: opts.typist ?? { type: () => Promise.resolve('failed' as const) },
            events: this.engineEvents,
            ledger: this.turnLedger,
            noticeLive: (item) =>
              !!item.group && !!this.groupStore?.find(item.group.roomId)?.members.includes(item.to),
            onDelivery: (item, delivered) => {
              this.groupMessages?.observe(item, delivered);
              // PERM-PROMPT: a message held for its session's terminal is a trigger to look.
              const id = delivered === 'held' ? this.agentIdOfName(item.to) : null;
              if (id !== null) this.permission.waits?.suspect(id);
            },
            ...(opts.messengerTiming && { timing: opts.messengerTiming }),
          })
        : null;
    this.groupMessages =
      this.groupStore && this.messenger
        ? new GroupMessages({
            home,
            store: this.groupStore,
            messenger: this.messenger,
            changed: (roomId) => this.rooms.publishGroups(roomId),
          })
        : null;
    this.jobs =
      this.engine && this.engineEvents
        ? new Jobs({
            home,
            events: this.engineEvents,
            env: () => this.engine!.jobEnv(),
            systemdRun: this.engine.scopeRunner,
            changed: () => {
              this.workerRuns.observeExecutions();
              this.publishJobs();
            },
            worker: opts.worker === undefined ? CLD_WORKER : opts.worker,
          })
        : null;
    this.codex =
      this.engine && this.jobs
        ? new CodexTasks({
            home,
            rulesDir: rulesDirFor(CLD_BIN_DIR),
            jobs: this.jobs,
            // W2 fix 5: through the gate every repository write has (read-only, one write at a time).
            worktree: async (project, task, meta) => {
              const r = await this.repos.write(project.name, true, 'engine', 'worktreeNew', async () => ({
                ok: true,
                made: await this.repos.worktrees.create(project, task, meta),
              }));
              if (!r.ok || !('made' in r)) throw new RepoError(r.error ?? '작업 공간을 만들지 못했어요');
              return r.made;
            },
            folderOf: (name) => this.engine!.folders().find((f) => f.name === name)?.folder ?? null,
            changed: () => {
              this.codexAgent?.changed();
              this.workerRuns.observeExecutions();
              this.reportWorkerRuns();
              this.recompute();
            },
          })
        : null;
    this.gpuQueue = this.engineEvents
      ? new GpuQueue({
          dir: gpuDir(home),
          locks: defaultLocks(),
          event: (type, fields) => this.engineEvents?.append(type, 'engine', fields),
        })
      : null;
    this.gpuFold = this.engineEvents ? new GpuBoardFold() : null;
    if (this.engineEvents)
      this.engineEvents.onRecord = (e) => {
        if (this.levelsLive) this.levels.observeEvent(e);
        if (!this.gpuFold?.apply(e) || !this.started) return;
        this.publishGpu();
        // A lease turns a job's GPU 대기 into 실행 중 now, not at the next jobs refresh.
        if (e.type === 'gpu_lease') this.publishJobs();
      };
    this.world = { rooms: [], agents: [] };
    this.conversations = new Conversations(
      () => this.leads(),
      (contacts) => this.publish({ type: 'messengerContacts', contacts }),
      undefined,
      this.turnLedger,
      (execution) => this.noticeEmployee(execution),
    );
    // A turn can end within one poll: the contacts say which room it is in the moment it starts.
    this.turnLedger.onChange = () => this.conversations.republish();
    this.rooms = new OfficeRooms({
      opts,
      groupStore: this.groupStore,
      groupMessages: this.groupMessages,
      conversations: this.conversations,
      turnLedger: this.turnLedger,
      entryOf: (id) => this.entryOf(id),
      leads: () => this.leads(),
      noticeEmployee: (execution) => this.noticeEmployee(execution),
      publish: (m) => this.publish(m),
    });
    this.work = new WorkViews((t) => this.chat.workReader(t));
    this.chat = new OfficeChat({
      opts,
      engine: this.engine,
      messenger: this.messenger,
      slash: this.slash,
      conversations: this.conversations,
      work: this.work,
      entryOf: (id) => this.entryOf(id),
      leads: () => this.leads(),
      readScreen: (id) => this.permission.readScreen(id),
      publish: (m) => this.publish(m),
      officeState: () => this.officeState(),
    });
    this.push = opts.pushFile
      ? new PushService({
          store: new PushStore(opts.pushFile, opts.pushHost),
          agents: opts.store,
          lookedAt: (send) =>
            this.viewers.has(send) && !this.hidden.has(send)
              ? (this.lookedAt.get(send) ?? null)
              : null,
          describe: (id) => {
            const agent = opts.store.get(id);
            const entry = this.entryOf(id);
            const name = entry?.name ?? agent?.agentName;
            if (!name) return null;
            return {
              name,
              who:
                agent?.leadAgentId !== undefined
                  ? 'teammate'
                  : // K1: an engine Worker's turn ends are its Lead's news, not the owner's.
                    this.engine && ![name, null].includes(this.engine.projectOf(name))
                    ? 'worker'
                    : 'orchestrator',
              remote: entry?.remoteControl?.on === true,
              lead: !!entry && this.opts.chat === true, // its conversation, in the messenger
              background: !!entry?.bg?.id,
              task: doingTaskTitle(this.tasks.list(), name),
            };
          },
          agentIdOf: (name) => this.agentIdOfName(name),
          // C3: only a lead with a conversation has room turns (the room posts go to those).
          turn: (id) => this.rooms.turnOf(id),
        })
      : null;
    this.permission = new OfficePermissions({
      claudePath: this.engine ? opts.engineClaude! : null,
      store: opts.store,
      conversations: this.conversations,
      typist: opts.typist,
      chat: opts.chat,
      entryOf: (id) => this.entryOf(id),
      agentIdOfName: (name) => this.agentIdOfName(name),
      agents: () => this.world.agents,
      idOf: (key) => this.binder.idOf(key),
      employeeOf: (key) => this.roster.employeeOf(key),
      inPty: (name) => this.engine?.inPty(name),
    });
    this.floors = new OfficeFloors({
      opts,
      building: this.building,
      decor: this.decor,
      world: () => this.world,
      hasCodex: () => !!this.codex,
      keyOf: (id) => this.binder.keyOf(id),
      codexKeyOf: (id) => this.codexBinder.keyOf(id),
      codexTasks: () => this.codexTasks(),
      codexRoom: (project) => this.codexRoom(project),
    });
  }

  /** The character of a project or session name, or null. */
  private agentIdOfName(name: string): number | null {
    const entry = this.world.agents.find((a) => a.name === name);
    return entry ? this.binder.idOf(entry.key) : null;
  }

  /**
   * TERM-P3 (ADR-0018): a PTY agent's PermissionRequest hook (control `permission-hook`); the card
   * logic is OfficePermissions.ask.
   */
  askPermission(name: string, ask: { tool: string; input: Record<string, unknown> }): Promise<'allow' | 'deny' | null> {
    return this.permission.ask(name, ask);
  }

  /** The managed install this daemon runs from, with the folder holding its cld/; null for a source install. */
  private installedCopy() {
    // dist/ in an installed bundle, server/src/cld/ in a checkout: the folder holding cld/release/version.json.
    const repoRoot = [path.resolve(__dirname, '..'), path.resolve(__dirname, '../../..')].find((dir) =>
      fs.existsSync(path.join(dir, 'cld', 'release', 'version.json')),
    );
    const managed = repoRoot ? managedInstall(repoRoot) : null;
    return repoRoot && managed ? { repoRoot, managed } : null;
  }

  private makeStartPolicy(): StartPolicyControl {
    // Browser runners' fake install (cld/test/run-r3.ts); unset in every install.
    const test = process.env.CLD_GUI_TEST_START_POLICY;
    if (test) return new StartPolicyControl(testStartPolicyDeps(test));
    const copy = this.installedCopy();
    return new StartPolicyControl(
      realStartPolicyDeps(
        copy && {
          root: copy.managed.root,
          managerPath: path.join(copy.repoRoot, 'cld', 'install', 'manager.mjs'),
          version: copy.managed.version,
        },
      ),
    );
  }

  private makeUpdateNotice(opts: OfficeOptions): UpdateNotice | null {
    const copy = this.installedCopy();
    if (!copy) return null;
    const { repoRoot, managed } = copy;
    return new UpdateNotice({
      configDir: configDirectory(opts.home ?? os.homedir()),
      root: managed.root,
      version: managed.version,
      serviceKind: managed.serviceKind,
      managerPath: path.join(repoRoot, 'cld', 'install', 'manager.mjs'),
      readOnly: !!opts.readOnly,
      facts: () => ({
        sessions: this.engine?.roster().filter((a) => a.live).length ?? 0,
        jobs: this.jobs?.list().filter((r) => !r.ended).length ?? 0,
        worktrees: this.repos.worktrees.all().filter((r) => r.status === 'active').length,
        merging: this.repos.writing,
      }),
    });
  }

  async start(): Promise<void> {
    this.characters.start();
    this.parts.start();
    cldHooks.projectFolders = () => this.projectFolders();
    cldHooks.registerRoutes = (app, auth, stepUpFresh, actorOf, kindOf) => {
      registerCharacterRoutes(app, auth, this.characters);
      registerPartRoutes(app, auth, this.parts);
      registerOwnerProfileRoutes(
        app,
        auth,
        path.join(configDirectory(this.opts.home ?? os.homedir()), 'profile'),
      );
      if (this.updates) registerUpdateRoutes(app, auth, this.updates, !!this.opts.readOnly, stepUpFresh, kindOf, actorOf);
      if (this.push) registerPushImageRoute(app, this.push.images);
      registerStartPolicyRoutes(app, auth, this.startPolicy, !!this.opts.readOnly, stepUpFresh, kindOf, actorOf);
    };
    this.started = true;
    // Before load(): its one recompute already folds Claude's rows into the
    // engine's projects (no character under a Claude key, then another).
    if (this.engineEvents) rotateEvents(this.engineEvents.file); // before the feed is primed
    this.engineEvents?.load();
    this.engineEvents?.follow();
    this.levelsLive = true;
    this.publishGpu(); // T-0046: the board as primed (the engine's events)
    // TOKEN-GUARD (S-01): one engine per HOME. A second one would type every queued message
    // again (a second paid turn), run a second revive loop and overwrite the registry.
    const control = controlPath(this.opts.home ?? os.homedir());
    // Read-only too: it limits office actions, not the engine (revive, messenger) it still runs.
    if (this.engine && (await controlAnswers(control)))
      throw new Error(
        `another cld-gui daemon already runs the engine for this HOME (${control} answers); not starting a second one`,
      );
    this.engine?.start();
    this.messenger?.start();
    this.jobs?.start();
    this.codex?.start();
    this.workerRuns.attachWorkerRuns();
    this.workerRuns.observeExecutions(); // runs that ended while the daemon was down
    this.reportWorkerRuns(); // and their Leads not told yet
    if (this.jobs) {
      // U-42: once now, then daily; an error is logged and skipped, never the daemon's.
      this.pruneLogsNow();
      this.pruneTimer = setInterval(() => this.pruneLogsNow(), LOG_PRUNE_INTERVAL_MS);
      this.pruneTimer.unref();
    }
    if (this.gpuQueue) this.gpuHwTimer = setInterval(() => void this.tickGpuHw(), 2_000);
    await this.startControl();
    await this.load();
    this.floors.migrateLayoutJson();
    this.publishJobs();
    // Room names are the point of this office: on unless the user said
    // otherwise. Character names stay upstream's default, off (T-0036): the
    // office names its orchestrators anyway and the rest on hover.
    setAdapterSettingDefaults({ showAreas: true });
    Object.assign(cldHooks, {
      // One line per connection and action is ours; Fastify's per-request lines are noise.
      logLevel: 'warn',
      layoutFor: () => this.layoutFor(),
      saveLayout: (layout: Record<string, unknown>, send: WsSend) => this.saveLayout(layout, send),
      seatFor: (id: number) => this.seatFor(id),
      areaMappings: () => this.areaMappings(),
      onClientOpened: (send: WsSend, device?: string) => {
        this.push?.opened(send, device);
        this.onClientOpened(send);
      },
      pushDevices: this.push ? () => this.push!.subscribedDevices() : undefined,
      useAuth: this.push ? (auth: StandaloneAuth) => this.push?.useAuth(auth) : undefined,
      onClientReady: (send: WsSend) => this.onClientReady(send),
      onClientMessage: (
        msg: Record<string, unknown>,
        send: WsSend,
        privileged: boolean,
        userAgent?: string,
        stepUp?: SocketStepUp,
      ) => this.onClientMessage(msg, send, privileged, userAgent, stepUp),
      onClientClosed: (send: WsSend) => this.onClientClosed(send),
    });
    console.log(
      `[cld] office: ${this.world.agents.length} characters in ${this.world.rooms.length} rooms; providers: ${[
        this.opts.claude && 'claude',
        this.engine && 'engine',
      ]
        .filter(Boolean)
        .join(' + ')}`,
    );
  }

  /** Old finished job/Codex logs out, events.jsonl rotated (logPolicy.ts). Never throws. */
  private pruneLogsNow(): void {
    try {
      pruneLogs({ home: this.opts.home ?? os.homedir() });
      this.engineEvents?.rotate();
      this.groupMessages?.maintain();
    } catch (err) {
      console.warn(`[cld engine] log prune: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  dispose(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    this.levels.dispose(); // the last write, while viewers are still counted
    this.roster.flushIfDirty();
    this.started = false;
    this.push?.dispose();
    this.permission.dispose();
    this.viewers.clear();
    this.hidden.clear();
    this.lookedAt.clear();
    this.sleep();
    this.stopCodexUsageProbe();
    if (this.gpuHwTimer) clearInterval(this.gpuHwTimer);
    this.gpuHwTimer = null;
    this.control?.close();
    this.control = null;
    this.messenger?.dispose();
    this.slash.dispose();
    this.jobs?.dispose();
    this.codex?.dispose();
    this.engineEvents?.dispose();
    this.engine?.dispose();
    for (const v of this.views.values()) clearInterval(v.timer);
    this.views.clear();
    this.usage.stop();
    this.binder.dispose();
    this.codexBinder.dispose();
    this.characters.dispose();
    this.repos.dispose();
    this.devroom.dispose();
    for (const k of Object.keys(cldHooks)) delete (cldHooks as Record<string, unknown>)[k];
  }

  // ── Data ────────────────────────────────────────────────────

  /** The sessions, then one recompute (also after a long idle gap). */
  private async load(): Promise<void> {
    this.loading++;
    try {
      if (this.opts.claude) await this.refreshClaude();
    } finally {
      this.loading--;
    }
    this.recompute();
  }

  /** ~/.claude/sessions/ changed (what its fs.watch calls): one re-read 1 s
   *  after the first change of a burst, only while someone is viewing. */
  sessionsChanged(): void {
    if (this.claudeTimer || !this.watching()) return;
    this.claudeTimer = setTimeout(() => {
      this.claudeTimer = null;
      void this.refreshClaude();
    }, SESSIONS_DEBOUNCE_MS);
  }

  async refreshClaude(): Promise<void> {
    try {
      const spawn = this.watching() > 0 && !this.opts.attaching?.();
      const sessions: ClaudeSession[] = await this.opts.claude!.list(spawn);
      const home = this.opts.home;
      this.claudeData = entriesFromSessions(
        sessions,
        home ? (c, s) => transcriptPath(c, s, home) : undefined,
      );
      this.lastClaudeError = '';
      this.recompute();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== this.lastClaudeError) console.warn(`[cld] ${msg}`);
      this.lastClaudeError = msg;
    }
  }

  recompute(): void {
    if (!this.started || this.loading) return;
    this.world = { rooms: this.claudeData?.rooms ?? [], agents: this.claudeData?.agents ?? [] };
    if (this.engine) {
      this.world = this.engine.apply(this.world);
      this.publish(this.engine.state());
    }
    this.binder.reconcile(
      this.world.agents.map((a) => ({
        key: a.key,
        label: a.name,
        transcript: a.transcript,
        look: this.characters.paletteOf(a.name),
      })),
    );
    this.pinLooks();
    const codex = this.codexTasks();
    if (codex) {
      // D5: a Codex Worker's run is its own character's work, not a contractor's.
      const specs: CharacterSpec[] = codex
        .filter((t) => (t.state === 'running' || t.state === 'limit') && !t.agent)
        .map((t) => ({ key: `codex:${t.id}`, label: codexLabel(t.project), transcript: null }));
      this.codexBinder.reconcile(specs);
      this.temps.codex(codex);
      this.publish<CodexTasksMsg>({
        type: 'codexTasks',
        tasks: codex.map((t) => ({
          ...t,
          agentId: this.codexBinder.idOf(`codex:${t.id}`),
        })),
      });
    }
    this.publish<OfficeSnapshot>(this.officeState());
    this.tracking.refresh(this.world.agents, codex ?? []);
    // D6: an agent removed shows as (삭제됨) on its tasks.
    const removed = JSON.stringify(this.tasks.removedAssignees());
    if (removed !== this.sentRemoved) {
      this.sentRemoved = removed;
      this.opts.store.broadcast({ ...this.tasks.message() });
    }
    // 프로젝트마다 층 (T-0027): a new room gets its floor before anyone sees it.
    if (this.building.data.perProject) {
      const { error, changed } = this.building.apply((b) => placeNewRooms(b, this.floors.roomLabels()));
      if (error && error !== this.lastBuildingError) console.warn(`[cld] building: ${error}`);
      this.lastBuildingError = error ?? '';
      if (changed) this.floors.publishBuilding();
    }
    // After a restart the first clients get their floors before the world loads.
    // A client got its floors before the world loaded (a restart): re-send the list, who
    // sits in which room and the office itself when it changed (ELEVATOR: it was left out, so a
    // room drawn only once its characters came back stayed missing there, and they sat at
    // whatever desk was free, on another floor).
    if (this.floors.sentFloors && JSON.stringify(this.floors.floorRows()) !== this.floors.sentFloors) {
      this.floors.publishBuilding();
      this.opts.store.broadcast(this.floors.mappingsMessage());
    }
  }

  /** CH-1: every character name keeps the look it has now (characterPresets.pin). */
  private pinLooks(): void {
    const live = this.world.agents.flatMap((a) => {
      const id = this.binder.idOf(a.key);
      const agent = id === null ? undefined : this.opts.store.get(id);
      if (agent?.palette === undefined) return [];
      const provider = a.provider === 'engine' ? this.workerRuns.providerOfName(a.name) : 'claude';
      return [{ name: a.name, palette: agent.palette, hueShift: agent.hueShift ?? 0, provider }];
    });
    // TEMP-PLATES: every employee's look, keyed by its id (a new hire gets the least-used palette).
    const employee = this.roster.allEmployees();
    const employees = employee.map((e) => `emp:${e.id}`);
    const counts = new Array<number>(PALETTE_COUNT).fill(0);
    const known = employees.map((key) => this.characters.paletteOf(key) ?? this.hireLooks.get(key));
    for (const look of known) if (look && look.palette < PALETTE_COUNT) counts[look.palette]++;
    employees.forEach((key, i) => {
      let look = known[i];
      if (!look) {
        look = pickDiversePalette(PALETTE_COUNT, counts);
        counts[look.palette]++;
        this.hireLooks.set(key, look);
      }
      // CH-3: a new hire's first look is the mascot of the work it was hired for
      const provider = employee[i].execution?.split(':')[0] ?? null;
      live.push({ name: key, palette: look.palette, hueShift: look.hueShift, provider });
    });
    this.characters.pin(live, () =>
      loadRegistry(registryPath(this.opts.home ?? os.homedir())).projects.map((p) => p.name),
    );
  }

  /** MSG-ALIGN: the employee a run was bound to, ever (the roster keeps every run's), for a chat item. */
  private noticeEmployee(execution: string): { employeeId: string; nameId: string } | undefined {
    const e = this.roster.employeeOf(execution);
    return e && { employeeId: e.id, nameId: e.nameId };
  }

  /** TEMP-PLATES: the roster project of a lead character (a teammate's: its lead's), or null. */
  private rosterProjectOf(leadId: number): string | null {
    let id = leadId;
    for (let hops = 0; hops < 3; hops++) {
      const key = this.binder.keyOf(id);
      const row = key ? this.world.agents.find((a) => a.key === key) : undefined;
      if (row) return this.trackedProjectOf(row) ?? row.name;
      const lead = this.opts.store.get(id)?.leadAgentId;
      if (lead === undefined) return null;
      id = lead;
    }
    return null;
  }

  /** U-48: an engine agent's project, else the project folder holding the session's cwd (§10: outside sessions count there); null = not tracked. */
  private trackedProjectOf(a: Pick<AgentEntry, 'key' | 'name' | 'dir'>): string | null {
    if (!this.engine) return null;
    if (a.key.startsWith('engine:')) return this.engine.projectOf(a.name);
    const folders = JSON.stringify(this.engine.folders());
    if (folders !== this.trackingFolders) {
      this.trackingFolders = folders;
      this.cwdProjects.clear();
    }
    if (!this.cwdProjects.has(a.dir)) this.cwdProjects.set(a.dir, this.engine.projectAt(a.dir));
    return this.cwdProjects.get(a.dir) ?? null;
  }

  officeState(): OfficeSnapshot {
    const w = this.world;
    return {
      type: 'officeSnapshot',
      readOnly: this.opts.readOnly,
      ...(this.opts.chat && { chat: true }),
      tabs: w.rooms,
      orchestrators: w.agents.map(({ key, transcript: _t, ...o }) => ({
        ...o,
        agentId: this.binder.idOf(key),
        provider: key.startsWith('engine:') ? ('engine' as const) : ('claude' as const),
        level: this.levels.view(key),
        ...(key.startsWith('engine:') && this.engine?.renewPending(o.name) && { renewing: true }),
        ...(key.startsWith('engine:') && this.engine?.compacting(o.name) && { compacting: true }),
        ...(key.startsWith('engine:') && this.chat.heldEdits(o.name)),
      })),
      owner: this.levels.ownerView(),
    };
  }

  // ── Worker runs and Task worktrees (office/workerRuns.ts) ───

  holdsWorktree(a: { role: string; assignmentId: string | null; provider: string; live: boolean; wantRunning: boolean }, taskId: string): boolean {
    return this.workerRuns.holdsWorktree(a, taskId);
  }

  codexMayUse(project: { name: string; folder: string }, dir: string, assignmentId: string): boolean {
    return this.workerRuns.codexMayUse(project, dir, assignmentId);
  }

  codexTaskWorktree(
    project: { name: string; folder: string },
    task: string,
    assignmentId: string,
  ): { path: string; branch: string } | null {
    return this.workerRuns.codexTaskWorktree(project, task, assignmentId);
  }

  assignedFolder(p: { name: string; assignmentId?: string; workFolder?: string }): string | null {
    return this.workerRuns.assignedFolder(p);
  }

  private reportWorkerRuns(): void {
    this.workerRuns.reportWorkerRuns();
  }

  private systemLine(type: string, f: Record<string, unknown>): void {
    this.workerRuns.systemLine(type, f);
  }

  tellWorkerRun(r: CodexRecord, mark: string, file: string): Promise<void> {
    return this.workerRuns.tellWorkerRun(r, mark, file);
  }

  /** The engine's Codex tasks (T-0021); null when the engine is off. */
  private codexTasks(): Array<Omit<CodexTask, 'agentId'>> | null {
    return this.codex ? this.codex.tasks() : null;
  }

  /** The room of a Codex task's project (the engine's orchestrator). */
  private codexRoom(project: string): string | undefined {
    return this.world.agents.find((a) => a.key === `engine:${project}`)?.tab;
  }

  // ── GPU board (T-0021) ──────────────────────────────────────

  private publishGpu(): void {
    if (!this.gpuFold) return;
    const board = this.gpuFold.board();
    const hw = JSON.parse(this.latest.get('hwSample') ?? 'null') as HwSample | null;
    const procs =
      hw?.ts && Date.now() - Date.parse(hw.ts) < 5_000 ? (hw.gpuProcesses ?? null) : null;
    const holders = new Set(
      this.gpuQueue
        ?.state()
        .holders.map((h) => h.pid)
        .filter((p): p is number => p !== null) ?? [],
    );
    this.publish({
      ...board,
      unleased: procs?.length ? unleasedFromProcesses(procs, holders) : [],
      processesUnknown: procs === null,
    });
  }

  /** Remove what dead wrappers left in the queue; the sweep's events fold the board. */
  private sweepGpu(): void {
    const q = this.gpuQueue;
    q?.withAdmit(() => q.sweep(), 0);
  }

  /** The engine's jobs (T-0019), for the job panel. */
  private publishJobs(): void {
    if (!this.jobs) return;
    const jobs: OfficeJob[] = this.jobs.officeJobs();
    this.publish({ type: 'officeJobs', jobs });
  }

  // ── Engine E2 (T-0019): the cld-gui CLI's local socket ──────

  private async startControl(): Promise<void> {
    const engine = this.engine;
    const messenger = this.messenger;
    const jobs = this.jobs;
    if (!engine || !messenger || !jobs) return;
    const home = this.opts.home ?? os.homedir();
    const file = controlPath(home);
    try {
      ensureOwnerToken(home); // SEC-CONTROL: the owner's CLI reads it; made before anyone asks
    } catch (err) {
      console.warn(`[cld engine] owner token: ${err instanceof Error ? err.message : String(err)}; owner commands over ${file} are refused`);
    }
    const groupPost = (r: { room: string; text: string; from: string | null; source: string }) =>
      this.groupMessages
        ? this.groupMessages
            .post(r)
            .then((post) =>
              post.ok
                ? { ok: true, post: post.post }
                : { ok: false, code: 'group_failed', error: post.error },
            )
        : Promise.resolve({
            ok: false,
            code: 'daemon_error',
            error: '단톡방을 쓸 수 없어요',
          });
    // C5a: the agent tools behind the MCP adapter (counters in memory, per daemon).
    const mcp = new McpTools({
      roster: () => engine.roster(),
      tasks: this.tasks,
      queueLength: (name) => messenger.queued.filter((q) => q.to === name).length,
      limited: (provider) => {
        const u = this.usage.usage?.providers.find((entry) => entry.id === provider);
        const full = !!u && u.windows.some((w) => (w.pct ?? 0) >= 100);
        // One Codex account: a run waiting on its limit holds every Codex Worker (design §2.1).
        return full || (provider === 'codex' && (this.codex?.workerRecords() ?? []).some((r) => r.state === 'limit'));
      },
      send: (r) => messenger.send(r),
      groupPost,
      findRoom: (room) => this.groupStore?.find(room) ?? null,
      timeline: (room) => this.groupMessages?.timeline(room, Number.MAX_SAFE_INTEGER) ?? [],
      // P4 add_review_note: `task` is the worktree's folder or its Task id (the Lead knows the id).
      addReviewNote: ({ task, ...r }) => {
        const rec = this.repos.worktrees
          .all()
          .find((w) => w.project === r.project && w.status === 'active' && (w.task === task || w.taskId === task));
        if (!rec) return Promise.resolve({ ok: false, code: 'unknown_worktree', error: koText('worktree_missing') });
        return this.repos.leadReviewNote({ ...r, task: rec.task });
      },
      // C6: delegate_task makes and starts Workers through the engine's own actions.
      delegation: {
        approvals: this.approvals,
        providerReady: (provider) => engine.providerReady(provider),
        addWorker: (req) =>
          engine.run(
            { type: 'engineAction', requestId: `mcp-add-${Date.now()}`, action: 'add', ...req },
            true,
            'mcp',
          ),
        startAgent: (name) =>
          engine.run(
            { type: 'engineAction', requestId: `mcp-start-${Date.now()}`, action: 'start', name },
            true,
            'mcp',
          ),
        event: (type, fields) => {
          this.engineEvents?.append(type, 'mcp', fields);
          this.systemLine(type, fields);
        },
        // W2: worktree 'new' through the same operation as the 작업실 and the CLI.
        taskWorktree: (r) =>
          worktreeForTask(
            this.workerRuns.taskWorktreeDeps(),
            { taskId: r.taskId, assignee: r.assignee, scope: r.project, by: r.by, createdBy: `agent:${r.by}`, reuse: true },
            true,
            `mcp:${r.by}`,
          ),
      },
    });
    this.mcp = mcp;
    this.publishApprovals();
    try {
      this.control = await listenControl(file, (req) =>
        answerControl(req, {
          mcp: (agent, tool, input) => mcp.call(agent, tool, input),
          names: () => engine.names(),
          agentOf: (token) => engine.tokens.agentOf(token),
          permission: (agent, ask) => this.askPermission(agent, ask),
          isOwner: (credential) => ownerTokenMatches(home, credential),
          projectOf: (name) => engine.projectOf(name),
          engineAction: (req) => engine.run(req, true, 'cli'),
          moveAll: (stop) => (stop ? engine.moveAllStop(true) : engine.moveAll(true)),
          // AUTO-TRUST: `agty trust`, the owner's command (control.ts refuses an agent's token).
          trust: async (target, start) => {
            const r = await engine.trustProject(target, start);
            if (!r.ok) return r;
            const { trust, start: started, ...rest } = r;
            return {
              ...rest,
              outcome: trust.outcome,
              steps: trust.steps,
              ...(started && {
                started: started.ok,
                ...(started.note && { note: started.note }),
                ...(started.error && { startError: started.error }),
              }),
            };
          },
          workers: () => engine.state().projects.filter((p) => p.role),
          projectAt: (cwd) => engine.projectAt(cwd),
          send: (r) => messenger.send(r),
          groupPost,
          groups: () => ({ ok: true, groups: this.groupStore?.list() ?? [] }),
          groupRead: (room, n) => {
            const found = this.groupStore?.find(room);
            if (!found || !this.groupMessages)
              return { ok: false, code: 'unknown_group', error: `'${room}' 단톡방이 없습니다` };
            return { ok: true, room: found, posts: this.groupMessages.timeline(found, n) };
          },
          job: (r) => startForTask(this.tasks, r.task, 'job', r.source, () => jobs.run(r)),
          jobs: (all) => ({ ok: true, jobs: jobs.json(all) }),
          hw: () => this.hwForCli(),
          status: async () => {
            const hw = await this.hwForCli();
            const projects = engine.state().projects.map((project) => ({
              name: project.name,
              state: project.live ? 'on' : project.wantRunning ? 'rest' : 'off',
            }));
            return {
              ok: true,
              projects,
              jobs: jobs.json(false),
              tasks: (this.codex?.list(false) ?? []).map(codexJson),
              daemon: {
                pid: process.pid,
                port: this.daemonPort,
                entry: path.resolve(process.argv[1] ?? ''),
              },
              ...(hw.ok && 'hw' in hw ? { hw: hw.hw } : {}),
              ...staffFacts(this.usage.usage, this.temps.message().staff, this.usage.opts.home),
            };
          },
          stopAgents: async () => {
            const stopped: Array<{ kind: string; name: string }> = [];
            const left: Array<{ kind: string; name: string; why: string }> = [];
            // Use Engine.run, exactly the public action used by the office's
            // stop button.  It deliberately refuses conversations open in a
            // terminal rather than reaching into another process.
            for (const project of engine.state().projects.filter((p) => p.live)) {
              const result = await engine.run(
                {
                  type: 'engineAction',
                  requestId: `uninstall-stop-${project.name}`,
                  action: 'stop',
                  name: project.name,
                },
                true,
                'manager',
              );
              if (result.ok) stopped.push({ kind: 'session', name: project.name });
              else
                left.push({
                  kind: 'session',
                  name: project.name,
                  why: result.error ?? '멈추지 못했어요',
                });
            }
            // Codex workers are Jobs too; list(..., true) includes their
            // records so the existing Jobs.stop ownership checks apply.
            for (const job of jobs.list(true, true).filter((item) => !item.ended)) {
              const result = jobs.stop(job.id, 'manager');
              const kind = job.kind === 'codex' ? 'codex' : 'job';
              if (result.ok) stopped.push({ kind, name: job.id });
              else left.push({ kind, name: job.id, why: result.error });
            }
            return { ok: true, stopped, left };
          },
          // A Codex task id stops the job that runs it now (T-0021).
          stop: (target, source) => jobs.stop(this.codex?.jobOf(target) ?? target, source),
          codex: (r) =>
            this.codex
              ? startForTask(this.tasks, r.task, 'codex', r.source, () => this.codex!.run(r))
              : Promise.resolve({ ok: false, code: 'daemon_error', error: '엔진이 꺼져 있습니다' }),
          codexList: (all) => ({ ok: true, tasks: (this.codex?.list(all) ?? []).map(codexJson) }),
          worktree: (args, who) =>
            answerWorktree({ ...this.workerRuns.taskWorktreeDeps(), projects: () => engine.projectNames() }, args, who),
          task: (args, who) =>
            args.op === 'mode'
              ? answerMode(this.approvals, args, who, engine.projectNames())
              : answerTask(this.tasks, args, who, {
                  assignmentOf: (name) => this.workerRuns.assignments()?.get(name) ?? null,
                  names: () => engine.names(),
                }),
          rename: (name, to, source) => engine.rename(name, to, source),
          renew: (name, text, from, source) => {
            const r = engine.renew(name, renewText(text, from, shortStamp()), source);
            return r.ok ? { ok: true, name, renew: 'pending' } : r;
          },
        }),
      );
      if (this.control) console.log(`[cld engine] cld-gui commands on ${file}`);
    } catch (err) {
      console.warn(`[cld engine] ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** C6: the user's pending delegate_task calls, as the 작업실's cards (everyone, on change). */
  private publishApprovals(): void {
    if (!this.mcp?.delegator) return;
    this.publish({
      type: 'delegationApprovals',
      approvals: this.mcp.delegator.cards(this.engine?.roster() ?? []),
    });
  }

  /** C6: 승인 / 거절 from the 작업실 (the rules: delegation.ts answerDecision). */
  private async decideDelegation(
    msg: Record<string, unknown>,
    send: WsSend,
    privileged: boolean,
    stepUp?: SocketStepUp,
  ): Promise<void> {
    const d = this.mcp?.delegator;
    const fields = await answerDecision(
      d,
      msg,
      { privileged, readOnly: !!this.opts.readOnly, stepUp },
      STEPUP_REQUIRED,
    );
    send({
      type: 'delegationApprovals',
      approvals: d?.cards(this.engine?.roster() ?? []) ?? [],
      ...fields,
    });
  }

  /** The HTTP server may receive an OS-assigned port, so it reports the actual listener. */
  setDaemonPort(port: number): void {
    this.daemonPort = port;
  }

  private publishUsage(): void {
    const usage = this.usage.usage;
    if (usage) this.publish({ type: 'usageState', ...usage });
  }

  private codexUsageProbe(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-codex-usage-'));
    const env: NodeJS.ProcessEnv = {
      ...(this.engine?.jobEnv() ?? cleanEnv(process.env, this.opts.home ?? os.homedir())),
      // The folder the usage line reads: codex must write its fresh limits there.
      CODEX_HOME: this.usage.opts.codexHome,
    };
    const codex = findOnPath(process.platform === 'win32' ? 'codex.cmd' : 'codex', env.PATH);
    const finishError = (err: unknown): Error =>
      err instanceof CodedError ? err : new Error(oneLineError(err));
    return new Promise((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let timeoutError: Error | null = null;
      let child: ChildProcess | null = null;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (this.codexUsageProbeKillTimer) clearTimeout(this.codexUsageProbeKillTimer);
        this.codexUsageProbeKillTimer = null;
        if (this.codexUsageProbeChild === child) this.codexUsageProbeChild = null;
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // A probe cleanup failure must not leave the client waiting.
        }
        if (error) reject(error);
        else resolve();
      };
      try {
        if (!codex) {
          finish(new CodedError(CODEX_USAGE_PROBE_ERROR.missing));
          return;
        }
        child = (this.opts.codexUsageSpawnFn ?? spawn)(
          codex,
          // TOKEN-GUARD: the user's own click (cost said on the button); the smallest turn Codex has.
          ['exec', '--skip-git-repo-check', '-c', 'model_reasoning_effort=low', 'Reply with exactly: OK'],
          { cwd: dir, env, stdio: 'ignore', windowsHide: true } as SpawnOptions,
        );
        this.codexUsageProbeChild = child;
        timer = setTimeout(() => {
          timeoutError = new CodedError(CODEX_USAGE_PROBE_ERROR.timeout);
          this.stopCodexUsageProbe();
        }, this.opts.codexUsageProbeTimeoutMs ?? CODEX_USAGE_PROBE_TIMEOUT_MS);
        child.once('error', (err) =>
          finish(
            (err as NodeJS.ErrnoException).code === 'ENOENT'
              ? new CodedError(CODEX_USAGE_PROBE_ERROR.missing)
              : finishError(err),
          ),
        );
        child.once('close', (code) =>
          finish(
            timeoutError ??
              (code === 0 ? undefined : new CodedError(refused('usage_codex_exit', { code: code ?? '?' }))),
          ),
        );
      } catch (err) {
        finish(finishError(err));
      }
    });
  }

  /** This office owns the probe child; stop only that child, never an unrelated process. */
  private stopCodexUsageProbe(): void {
    const child = this.codexUsageProbeChild;
    if (!child) return;
    child.kill('SIGTERM');
    if (this.codexUsageProbeKillTimer) clearTimeout(this.codexUsageProbeKillTimer);
    this.codexUsageProbeKillTimer = setTimeout(() => {
      if (this.codexUsageProbeChild === child) child.kill('SIGKILL');
    }, this.opts.codexUsageProbeKillGraceMs ?? CODEX_USAGE_PROBE_KILL_GRACE_MS);
  }

  private async checkCodexUsage(send: WsSend, privileged: boolean): Promise<void> {
    if (!privileged) {
      send({ type: 'codexUsageCheckResult', ok: false, ...CODEX_USAGE_PROBE_ERROR.denied });
      return;
    }
    const now = (this.opts.codexUsageNow ?? Date.now)();
    if (now - this.lastCodexUsageProbe < CODEX_USAGE_PROBE_COOLDOWN_MS) {
      send({ type: 'codexUsageCheckResult', ok: false, ...CODEX_USAGE_PROBE_ERROR.cooldown });
      return;
    }
    this.lastCodexUsageProbe = now;
    try {
      await this.codexUsageProbe();
      await this.usage.refreshNow();
      send({ type: 'codexUsageCheckResult', ok: true });
    } catch (err) {
      send({ type: 'codexUsageCheckResult', ok: false, ...refusedOf(err, oneLineError) });
    }
  }

  /** A provider moved a still-future usage window later while its reading dropped. */
  private usageResetEarly(reset: EarlyUsageReset): void {
    const fields = { provider: reset.provider, providerName: reset.name, period: reset.period };
    if (this.engineEvents) {
      this.engineEvents.append('usage_reset_early', 'usage', fields);
      return;
    }
    appendEvent(eventsPath(this.opts.home), 'usage_reset_early', 'usage', fields);
    // An office without the engine still has to surface this one-off notice.
    this.publish({
      type: 'officeEvent',
      ts: isoLocal(),
      kind: 'usage_reset_early',
      source: 'usage',
      summary: koText(reset.period === '7d' ? 'ev_usage_reset_week' : 'ev_usage_reset_5h', {
        provider: reset.name,
      }),
      ...fields,
    });
  }

  private publish<T extends { type: string }>(msg: T): void {
    const json = JSON.stringify(msg);
    if (this.latest.get(msg.type) === json) return;
    this.latest.set(msg.type, json);
    this.opts.store.broadcast(msg as unknown as Record<string, unknown>);
  }

  // ── HW ──────────────────────────────────────────────────────

  /**
   * `cld-gui hw`: the latest sample a viewer's tick produced while it is
   * fresh, else one sample on demand (nobody viewing means no tick runs).
   * No timer of its own.
   */
  private async hwForCli(): Promise<Reply> {
    try {
      const last = JSON.parse(this.latest.get('hwSample') ?? 'null') as HwSample | null;
      let hw: Omit<HwSample, 'type'>;
      if (last?.ts && Date.now() - Date.parse(last.ts) < 3 * HW_MS) {
        const { type: _type, ...rest } = last;
        hw = rest;
      } else hw = await this.hw.sample();
      // On demand only: no viewer tick reads every process.
      if (hasHwReadings(hw))
        return { ok: true, hw: { ...withoutDetail(hw), topProcesses: readTopProcesses() } };
      return refuse(
        'no_sample',
        `HW 측정값이 아직 없습니다${hw.warnings.length ? `: ${hw.warnings.join(' · ')}` : ''}`,
      );
    } catch (err) {
      return refuse(
        'no_sample',
        `HW 측정값을 얻지 못했습니다: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private tickHw(): void {
    if (this.sampling) return;
    this.sampling = true;
    void (async () => {
      try {
        this.publish({ type: 'hwSample', ...(await this.hw.sample()) });
        this.publishGpu();
      } catch (err) {
        console.warn(`[cld] hw: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.sampling = false;
      }
    })();
  }

  private updateHwCadence(): void {
    const open = [...this.hwViewers].some(
      (send) => this.viewers.has(send) && !this.hidden.has(send),
    );
    if (open && !this.hwFastTimer) this.hwFastTimer = setInterval(() => this.tickHw(), 1_000);
    if (!open && this.hwFastTimer) {
      clearInterval(this.hwFastTimer);
      this.hwFastTimer = null;
    }
  }

  /** The disk card is viewer-triggered like H/W sampling, but never gets a timer of its own. */
  private requestDiskUsage(send: WsSend): void {
    void this.diskUsage
      .read()
      .then((usage) => {
        if (this.hwViewers.has(send) && this.viewers.has(send) && !this.hidden.has(send)) send({ ...usage });
      })
      .catch((err) => console.warn(`[cld] disk usage: ${oneLineError(err)}`));
  }

  /** The worker sees a hw.json while a GPU ticket waits for admission. */
  private async tickGpuHw(): Promise<void> {
    const q = this.gpuQueue;
    if (!q || this.gpuHwSampling) return;
    const state = q.state();
    if (!state.queue.length) return;
    this.gpuHwSampling = true;
    try {
      writeCollectorGpuHw(q, await this.hw.sample());
    } catch (err) {
      console.warn(`[cld] GPU HW: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.gpuHwSampling = false;
    }
  }

  // ── Layout, floors and seats ────────────────────────────────

  plan(): FloorPlan {
    return this.floors.plan();
  }

  layoutFor(): Record<string, unknown> {
    return this.floors.layoutFor();
  }

  saveLayout(layout: Record<string, unknown>, send: WsSend): true {
    return this.floors.saveLayout(layout, send);
  }

  seatFor(agentId: number): string | undefined {
    return this.floors.seatFor(agentId);
  }

  areaMappings(): Record<string, string[]> {
    return this.floors.areaMappings();
  }

  buildingState(why?: Coded & { error?: string }): BuildingState {
    return this.floors.buildingState(why);
  }

  /** setWhiteboardMemo (T-0065): a whiteboard of the current office; everyone gets the memos. */
  private setMemo(msg: Record<string, unknown>, send: WsSend, privileged: boolean, by: string) {
    const { uid, text } = msg;
    const isBoard = (u: string) =>
      (this.layoutFor().furniture as Array<{ uid: string; type: string }>).some(
        (f) => f.uid === u && f.type === WHITEBOARD_TYPE,
      );
    const error = !privileged
      ? '이 접속에는 조작 권한이 없어요'
      : typeof uid !== 'string' || typeof text !== 'string' || !isBoard(uid)
        ? '이 화이트보드를 찾지 못했어요'
        : this.memos.set(uid, text, by);
    if (error) console.warn(`[cld] memo: ${error}`);
    // Refused or not, the sender gets the truth back; a saved memo reaches everyone.
    if (error) send({ ...this.memos.message() });
    else this.opts.store.broadcast({ ...this.memos.message() });
  }

  /** taskEdit (DEV-BOARD): add a task, or change its status, owner, priority or note. */
  private editTask(
    msg: Record<string, unknown>,
    send: WsSend,
    privileged: boolean,
    device: string,
  ) {
    const raw =
      msg.fields && typeof msg.fields === 'object' ? (msg.fields as Record<string, unknown>) : {};
    const by = `gui:${device}`;
    const pick = (keys: string[]) =>
      Object.fromEntries(Object.entries(raw).filter(([k]) => keys.includes(k)));
    const r = !privileged
      ? refuse('read_only', '이 접속에는 조작 권한이 없어요')
      : typeof msg.id === 'string'
        ? this.tasks.update(msg.id, pick(['status', 'owner', 'priority', 'note']), by)
        : this.tasks.add(pick(['project', 'title', 'status', 'owner', 'priority', 'note']), by);
    if (r.ok && privileged && typeof msg.id !== 'string') this.levels.ownerDid('tasks'); // OWNER-STATS
    // Saved, everyone already has it (the store's broadcast); refused, the sender gets why.
    if (!r.ok) send({ ...this.tasks.message(), error: String(r.error) });
  }

  /** The projects the daemon manages, for the repository panel: the engine registry (E1). */
  private projectFolders(): ProjectFolder[] {
    return this.engine?.folders() ?? [];
  }

  // ── Clients ─────────────────────────────────────────────────

  /** Viewers whose page is showing: only they keep the office awake (T-0025). */
  private watching(): number {
    return this.viewers.size - this.hidden.size;
  }

  /** A /ws socket opened: the first viewer wakes the office. It counts as
   *  looking until its page says otherwise (viewerVisibility). */
  onClientOpened(send: WsSend): void {
    if (this.viewers.has(send)) return;
    this.viewers.add(send);
    this.lookedAt.set(send, Date.now());
    console.log(`[cld] viewer connected (${this.watching()} watching)`);
    if (this.watching() === 1) this.wake();
  }

  /** viewerVisibility: a hidden page stops counting, a shown one counts
   *  again; the last one to look away puts the office to sleep. */
  private onVisibility(send: WsSend, visible: boolean): void {
    if (visible && this.viewers.has(send)) this.lookedAt.set(send, Date.now()); // also the page's heartbeat (U-49)
    if (this.viewers.has(send) && visible === this.hidden.has(send)) {
      if (visible) this.hidden.delete(send);
      else this.hidden.add(send);
      console.log(`[cld] viewer ${visible ? 'back' : 'hidden'} (${this.watching()} watching)`);
      if (visible && this.watching() === 1) this.wake();
      if (!visible && this.watching() === 0) this.sleep();
      this.updateHwCadence();
    }
    send({ type: 'viewerVisibilityAck', visible: !this.hidden.has(send) });
  }

  /** After webviewReady (and its layoutLoaded): the floors, the latest of
   *  every message type and the feed. */
  onClientReady(send: WsSend): void {
    this.onClientOpened(send);
    send({ ...this.host }); // every /ws client is logged in (T-0022)
    const projects = path.join(this.host.home, 'projects');
    const dismissed = path.join(configDirectory(this.host.home), 'import-suggestion.json');
    if (
      this.engine &&
      !this.opts.readOnly &&
      this.engine.state().projects.length === 0 &&
      fs.existsSync(projects) &&
      !fs.existsSync(dismissed)
    )
      send({ type: 'projectImportSuggestion', folder: projects });
    send({ ...this.buildingState() });
    send(newAgentPermissionMessage(this.host.home) as never);
    const memos = this.memos.message();
    if (memos.memos.length) send({ ...memos });
    const pins = this.pins.message();
    if (pins.keys.length) send({ ...pins });
    const background = this.background.message();
    if (background) send({ ...background });
    send({ ...this.tasks.message() });
    for (const m of this.tracking.snapshot()) send({ ...m });
    if (this.groupStore) send({ type: 'groupRooms', rooms: this.rooms.groupRooms() });
    for (const json of this.latest.values()) send(JSON.parse(json) as Record<string, unknown>);
    const ez = this.ezRules.message(); // only when the user wrote valid ez-rules.json rules
    if (ez) send({ ...ez });
    // The engine's feed, oldest first (the client keeps the newest on top).
    for (const e of this.engineEvents?.feed ?? []) send({ type: 'officeEvent', ...e });
    this.push?.ready(send);
  }

  onClientClosed(send: WsSend): void {
    this.push?.closed(send);
    // MSG-HOLD2: a closed page (a reload, a dropped socket) never releases an edit hold.
    this.devroom.onClientClosed(send);
    this.repos.onClientClosed(send);
    this.chat.onClientClosed(send);
    this.hwViewers.delete(send);
    this.updateHwCadence();
    this.lookedAt.delete(send);
    if (!this.viewers.delete(send)) return;
    const wasLooking = !this.hidden.delete(send);
    for (const name of [...this.views.keys()]) this.unview(name, send);
    this.conversations.drop(send);
    this.rooms.onClientClosed(send);
    this.work.drop(send);
    console.log(`[cld] viewer left (${this.watching()} watching)`);
    if (wasLooking && this.watching() === 0) this.sleep();
  }

  /** The first viewer: one combined reload, then the viewing-only work. */
  private wake(): void {
    void this.load();
    this.usage.setViewing(true);
    this.characters.setViewing(true);
    this.tickHw();
    this.timers.push(setInterval(() => this.hwFastTimer || this.tickHw(), HW_MS));
    this.updateHwCadence();
    if (this.opts.chat) {
      this.conversations.poll();
      this.timers.push(
        setInterval(() => {
          this.conversations.poll();
          this.rooms.poll();
        }, CHAT_VIEW_POLL_MS),
      );
      this.timers.push(setInterval(() => void this.work.poll(), CHAT_VIEW_POLL_MS));
    }
    this.timers.push(setInterval(() => this.floors.sampleRooms(), ROOM_SAMPLE_MS));
    if (this.engine) this.timers.push(setInterval(() => void this.lookForCompacting(), COMPACT_LOOK_MS));
    if (this.gpuQueue) {
      this.sweepGpu();
      this.timers.push(setInterval(() => this.sweepGpu(), GPU_SWEEP_MS));
    }
    // The engine's running jobs: progress bars from their logs.
    if (this.jobs)
      this.timers.push(
        setInterval(() => {
          if (this.jobs?.list().some((r) => !r.ended)) this.publishJobs();
        }, JOB_PROGRESS_MS),
      );
    if (!this.opts.claude) return;
    this.timers.push(setInterval(() => void this.refreshClaude(), CLAUDE_POLL_MS));
    const dir = path.join(this.opts.home ?? os.homedir(), '.claude/sessions');
    try {
      this.sessionsWatcher = fs.watch(dir, () => this.sessionsChanged());
      this.sessionsWatcher.on('error', () => undefined);
    } catch {
      // No sessions/ (older Claude Code): the 30 s poll alone.
    }
  }

  private lookingForCompacting = false;
  /** COMPACT-COFFEE: a row's `compacting` changed: the office hears it at once. */
  private async lookForCompacting(): Promise<void> {
    if (!this.engine || this.lookingForCompacting) return;
    this.lookingForCompacting = true;
    try {
      if ((await this.engine.lookForCompacting()) && this.watching() > 0)
        this.publish<OfficeSnapshot>(this.officeState());
    } catch (err) {
      console.log(`[Agent Tycoon] compacting look: ${oneLineError(err)}`);
    } finally {
      this.lookingForCompacting = false;
    }
  }

  /** The last viewer left: no process and no sampling until the next one. */
  private sleep(): void {
    if (this.hwFastTimer) clearInterval(this.hwFastTimer);
    this.hwFastTimer = null;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.sessionsWatcher?.close();
    this.sessionsWatcher = null;
    if (this.claudeTimer) clearTimeout(this.claudeTimer);
    this.claudeTimer = null;
    this.usage.setViewing(false);
    this.characters.setViewing(false);
    void this.engine?.lookForCompacting(true);
    this.tracking.clear();
    this.cwdProjects.clear();
  }

  /** statusView {name, on}: poll a local report every 10 s while anyone
   *  looks. setCharacter (T-0017) and the floor changes (T-0027): cosmetic, so
   *  never gated on the read-only switch. */
  onClientMessage(
    msg: Record<string, unknown>,
    send: WsSend,
    privileged = false,
    userAgent?: string,
    stepUp?: SocketStepUp,
  ): void {
    if (privileged && OWNER_COUNTED.has(String(msg.type))) {
      // OWNER-STATS: the owner's own instruction, approval or merge, counted from the answer it got
      // (only these requests: other routes key their subscriptions by `send` itself).
      const reply = send;
      send = (m) => {
        const did = ownerActionOf(msg, m, privileged);
        if (did) this.levels.ownerDid(did);
        reply(m);
      };
    }
    if (msg.type === 'ownerActivity') {
      if (privileged && typeof msg.steps === 'number' && typeof msg.seconds === 'number')
        this.levels.ownerActivity(msg.steps, msg.seconds);
      return;
    }
    if (msg.type === 'hwView') {
      if (this.viewers.has(send) && typeof msg.on === 'boolean') {
        if (msg.on) this.hwViewers.add(send);
        else this.hwViewers.delete(send);
        this.updateHwCadence();
        if (msg.on) {
          this.tickHw();
          if (!this.hidden.has(send)) this.requestDiskUsage(send);
        }
      }
      return;
    }
    if (msg.type === 'viewerVisibility') {
      if (typeof msg.visible === 'boolean') this.onVisibility(send, msg.visible);
      return;
    }
    if (msg.type === 'agentRulesRequest') {
      handleAgentRules(msg, send, {
        home: this.host.home,
        rulesDir: rulesDirFor(CLD_BIN_DIR),
        privileged,
        readOnly: !!this.opts.readOnly,
        stepUp,
        log: (l) => console.warn(`[cld] ${l}`),
      });
      return;
    }
    if (msg.type === 'newAgentPermissionRequest') {
      handleNewAgentPermission(msg, send, {
        home: this.host.home,
        privileged,
        readOnly: !!this.opts.readOnly,
        stepUp,
        broadcast: (m) => this.opts.store.broadcast(m as never),
        log: (l) => console.warn(`[cld] ${l}`),
      });
      return;
    }
    if (msg.type === 'codexUsageCheck') {
      void this.checkCodexUsage(send, privileged);
      return;
    }
    if (this.push?.onClientMessage(msg, send, privileged)) return;
    if (this.characters.onClientMessage(msg, send)) {
      // CH-4 기본으로: the automatic look (the provider's recommendation) is pinned at once.
      if (msg.character === null) this.pinLooks();
      return;
    }
    if (this.floors.onClientMessage(msg, { send, privileged, userAgent, stepUp })) return;
    if (msg.type === 'taskEdit') {
      this.editTask(msg, send, privileged, deviceLabel(userAgent));
      return;
    }
    if (msg.type === 'trackingSettings') {
      void this.tracking.onSettings(msg, (m) => send({ ...m }), privileged);
      return;
    }
    if (msg.type === 'delegationDecision') {
      void this.decideDelegation(msg, send, privileged, stepUp);
      return;
    }
    if (msg.type === 'setWhiteboardMemo') {
      this.setMemo(msg, send, privileged, deviceLabel(userAgent));
      return;
    }
    if (msg.type === 'goneConversationDelete') {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId.slice(0, 128) : '';
      const r = !privileged || this.opts.readOnly || typeof msg.name !== 'string' ? null : this.deleteGone(msg.name);
      send({
        type: 'goneConversationDeleteResult',
        requestId,
        ...(!privileged || this.opts.readOnly
          ? { ok: false, ...refused('no_permission') }
          : r === null
            ? { ok: false, ...refused('gone_conversation_unknown') }
            : { ok: true, deleted: r.deleted, ...(r.failed.length && refused('data_not_moved', { stores: r.failed.join(', ') })) }),
      });
      if (r !== null)
        console.log(`[cld] gone conversation ${String(msg.name)}: ${r.deleted} conversation file(s) deleted${r.failed.length ? `; kept: ${r.failed.join(', ')}` : ''}`);
      return;
    }
    if (msg.type === 'setConversationPin') {
      const error = !privileged
        ? '이 접속에는 조작 권한이 없어요'
        : typeof msg.key !== 'string' || typeof msg.pinned !== 'boolean'
          ? '이 대화를 찾지 못했어요'
          : this.pins.set(msg.key, msg.pinned);
      if (error) console.warn(`[cld] pin: ${error}`);
      // Refused or not, the sender gets the truth back; a saved pin reaches everyone.
      if (error) send({ ...this.pins.message() });
      else this.opts.store.broadcast({ ...this.pins.message() });
      return;
    }
    if (msg.type === 'setOfficeBackground') {
      const error = !privileged ? '이 접속에는 조작 권한이 없어요' : this.background.set(msg);
      if (error) console.warn(`[cld] background: ${error}`);
      // Refused or not, the sender gets the truth back; a saved look reaches everyone.
      if (error) send({ ...this.background.current() });
      else this.opts.store.broadcast({ ...this.background.current() });
      return;
    }
    if (
      engineRoutes(
        msg,
        { send, privileged, userAgent, stepUp },
        {
          engine: this.engine,
          jobs: this.jobs,
          readOnly: this.opts.readOnly,
          home: this.host.home,
        },
      )
    )
      return;
    if (this.devroom.onClientMessage(msg, send, privileged)) return;
    if (this.repos.onClientMessage(msg, send, privileged, deviceSource(deviceLabel(userAgent)), stepUp)) {
      return;
    }
    if (msg.type === 'projectRepoCancel') {
      if (typeof msg.requestId === 'string') this.projectRepos.cancel(msg.requestId, privileged);
      return;
    }
    if (msg.type === 'projectRepo') {
      const req = parseProjectRepo(msg);
      if (!req) console.warn('[cld] malformed projectRepo dropped');
      else
        void this.projectRepos.handle(req, privileged, stepUp, (p) => send({ ...p })).then(
          (r) => send({ ...r }),
          (err: unknown) => console.warn(`[cld] projectRepo: ${String(err)}`),
        );
      return;
    }
    if (msg.type === 'listFolders') {
      const req = parseListFolders(msg);
      if (!req) console.warn('[cld] malformed listFolders dropped');
      else send({ ...this.folderList(req, privileged) });
      return;
    }
    if (this.chat.onClientMessage(msg, { send, privileged, userAgent, stepUp })) return;
    if (msg.type === 'permissionAnswer') {
      void this.permission.answer(msg, privileged, deviceLabel(userAgent)).then(
        (result) => (result ? send({ ...result }) : console.warn('[cld] malformed permissionAnswer dropped')),
        (err: unknown) => console.warn(`[cld] permission answer: ${String(err)}`),
      );
      return;
    }
    if (this.rooms.onClientMessage(msg, { send, privileged, userAgent, stepUp })) return;
    if (msg.type !== 'statusView' || typeof msg.name !== 'string') return;
    const name = msg.name;
    if (msg.on !== true) {
      this.unview(name, send);
      return;
    }
    if (!this.statusTarget(name)) return;
    let v = this.views.get(name);
    if (!v) {
      v = { sends: new Set(), timer: setInterval(() => void this.pollReport(name), REPORT_MS) };
      this.views.set(name, v);
    }
    v.sends.add(send);
    void this.pollReport(name);
  }

  /** The folder picker (T-0032): privileged clients only. A read-only daemon
   *  answers too: the 파일 tab's 다른 폴더 열기 (T-0050) is a read, and adding a
   *  project with the folder is refused where the action is. */
  private folderList(req: ListFolders, privileged: boolean): FolderList {
    const refusal = !privileged ? refused('no_permission') : null;
    if (!refusal) return listFolders(req, this.host);
    return {
      type: 'folderList',
      requestId: req.requestId,
      ok: false,
      ...refusal,
      roots: [],
      entries: [],
    };
  }

  // ── The office messenger (T-0043; T-0014's chat view) ──────

  private entryOf(agentId: number): AgentEntry | null {
    const key = this.binder.keyOf(agentId);
    return (key && this.world.agents.find((a) => a.key === key)) || null;
  }

  /**
   * RENAME / remove: projectData changes the stores' files between a flush of the ones this
   * daemon keeps in memory and their reload; the stores that did not follow.
   */
  private projectDataChange(change: () => string[], names: string[]): string[] {
    this.levels.flush();
    this.roster.flushIfDirty();
    const failed = change();
    this.nameHistory = readNameHistory(this.opts.home ?? os.homedir());
    this.levels.reload();
    this.approvals.reload();
    this.tracking.settings.reload();
    this.repos.reviewNotes.reload();
    this.roster.reload();
    this.pins.reload();
    this.characters.reload();
    this.building.data = loadBuilding(this.building.file);
    this.groupStore?.load();
    this.tasks.reload();
    this.messenger?.resync(names);
    // The sessions list read before the stop still names them: shown as plain sessions until the
    // next read, they would get a look pinned again under the freed name.
    if (this.claudeData)
      this.claudeData = { ...this.claudeData, agents: this.claudeData.agents.filter((a) => !names.includes(a.name)) };
    this.opts.store.broadcast({ ...this.pins.message() });
    this.floors.publishBuilding();
    this.rooms.publishGroups();
    this.recompute();
    return failed;
  }

  /** PROJECT-DATA: 대화방 지우기 (the owner's): a removed agent's conversation records deleted;
   *  null when `name` is no removed agent with a conversation. */
  private deleteGone(name: string): { deleted: number; failed: string[] } | null {
    const home = this.opts.home ?? os.homedir();
    if (!this.nameHistory.some((e) => e.as === name && e.gone && !e.gone.deleted)) return null;
    let r: { deleted: number; failed: string[] } | null = null;
    this.projectDataChange(() => {
      r = deleteGoneConversation(home, name, (l) => console.warn(`[cld] ${l}`), this.engine?.registeredSessionIds() ?? []);
      return r?.failed ?? [];
    }, [name]);
    return r;
  }

  /** Every lead the messenger lists: the engine's projects and the Claude sessions, then the
   *  removed agents with a conversation (read-only, shown as "(알 수 없음)"; their agentId is
   *  negative, never a character's, and stays with its name-history entry). */
  private leads(): Lead[] {
    const out: Lead[] = [];
    const gone: Lead[] = [];
    if (this.engine)
      this.nameHistory.forEach((e, i) => {
        if (e.gone?.transcript && !e.gone.deleted)
          gone.push({ agentId: -(i + 1), key: e.as, name: e.as, transcript: e.gone.transcript, dir: e.gone.folder, canSend: false });
      });
    for (const a of this.world.agents) {
      const agentId = this.binder.idOf(a.key);
      if (agentId === null) continue;
      const permission = this.permission.cardFor(agentId);
      // D3: a Worker is listed under its project (a Lead's project is its own name).
      const project = a.key.startsWith('engine:') ? this.engine?.projectOf(a.name) : null;
      out.push({
        agentId,
        key: a.key,
        name: a.name,
        ...(project && project !== a.name && { project }),
        transcript: a.transcript,
        dir: a.dir,
        canSend: this.chat.canSend(a.key, a.name),
        ...(this.messenger &&
          a.key.startsWith('engine:') && {
            queued: this.messenger.queuedFor(a.name),
            held: this.messenger.held(a.name),
          }),
        ...(permission && { permission }),
      });
    }
    return [...out, ...gone];
  }

  /** Everyone on this view has their page hidden: it is not polled meanwhile. */
  private allHidden(sends: Set<WsSend>): boolean {
    return sends.size > 0 && [...sends].every((s) => this.hidden.has(s));
  }

  private unview(name: string, send: WsSend): void {
    const v = this.views.get(name);
    if (!v) return;
    v.sends.delete(send);
    if (v.sends.size === 0) {
      clearInterval(v.timer);
      this.views.delete(name);
    }
  }

  private async pollReport(name: string): Promise<void> {
    const v = this.views.get(name);
    if (v && this.allHidden(v.sends)) return; // no status process for a hidden page
    const target = this.statusTarget(name);
    if (!target) return;
    try {
      const r = await localStatusReport(
        name,
        target.dir,
        target.provider === 'engine' ? engineJobsOutput(name, this.jobs?.list() ?? []) : '',
      );
      const out = { type: 'statusOutput', ...r, name };
      for (const s of this.views.get(name)?.sends ?? []) s(out);
    } catch (err) {
      console.warn(
        `[cld status] report ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Only a row this office currently publishes may open a status view. */
  private statusTarget(name: string): { provider: 'engine' | 'claude'; dir: string } | null {
    const entry = this.world.agents.find((agent) => agent.name === name);
    if (!entry?.dir) return null;
    return { provider: entry.key.startsWith('engine:') ? 'engine' : 'claude', dir: entry.dir };
  }
}

/** A daemon listens on the control socket (a stale file left by a crash refuses the connect). */
function controlAnswers(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(file);
    const done = (yes: boolean) => {
      s.destroy();
      resolve(yes);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(2_000, () => done(false));
  });
}

/**
 * Pick the providers and start the office, or return null (plain office)
 * when Claude Code is not found. The built-in engine runs unless `--engine off`.
 */
export async function startOffice(opts: {
  runtime: AgentRuntime;
  store: AgentStateStore;
  readOnly: boolean;
  chat?: boolean;
  attaching?: () => boolean;
  /** --engine auto|on|off (auto: on). */
  engineMode?: EngineMode;
  defaultLayout?: Record<string, unknown> | null;
  catalog?: () => Footprints;
  /** T-0019: types cld-gui sends (the attach manager). */
  typist?: Typist;
  lhmPort?: number | null;
  nvidiaSmi?: string | null;
  pushFile?: string;
  pushHost?: string;
}): Promise<Office | null> {
  const claudePath = findClaude();
  if (!claudePath) {
    console.log('[cld] claude not found: plain office');
    return null;
  }
  const claude = new ClaudeSessions(
    path.join(os.homedir(), '.claude/sessions'),
    new ClaudeAgentsSource(claudePath),
  );
  console.log(`[cld] claude: ${claudePath} (sessions from ${claude.dir})`);
  const mode = opts.engineMode ?? 'off';
  const engineClaude = engineOn(mode) ? claudePath : undefined;
  console.log(`[cld] engine ${engineClaude ? 'on' : 'off'} (--engine ${mode})`);
  const office = new Office({
    ...opts,
    claude,
    engineClaude,
    agentChoices: engineClaude
      ? new AgentChoicesCache(os.homedir(), process.env, fs, undefined, (command, pathValue) =>
          command === 'claude' ? engineClaude : findOnPath(command, pathValue),
        )
      : undefined,
    sessionPath: engineClaude ? buildSessionPath({ binDir: CLD_BIN_DIR }) : null,
  });
  await office.start();
  return office;
}
