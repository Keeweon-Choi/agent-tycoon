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
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { type Coded, CodedError, koText, pickRefusal, type Refused, refused, refusedOf, type WithError } from '../../../core/src/cld/serverText.js';
import type {
  BuildingState,
  ChatCancel,
  ChatEdit,
  ChatHold,
  ChatPendingResult,
  ChatSend,
  ChatSendNow,
  ChatSendResult,
  CodexTask,
  CodexTasks as CodexTasksMsg,
  FolderList,
  HostInfo,
  HwSample,
  JobActionKind,
  JobActionResult,
  ListFolders,
  OfficeJob,
  OfficeSnapshot,
  PermissionAnswerResult,
  PermissionWait,
  SlashCommand,
  SlashCommandsList,
} from '../../../core/src/messages.js';
import { pickDiversePalette } from '../../../core/src/paletteUtils.js';
import type { AgentRuntime } from '../agentRuntime.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { readConfig, setAdapterSettingDefaults } from '../configPersistence.js';
import {
  CODEX_USAGE_PROBE_COOLDOWN_MS,
  CODEX_USAGE_PROBE_KILL_GRACE_MS,
  CODEX_USAGE_PROBE_TIMEOUT_MS,
} from '../constants.js';
import { PALETTE_COUNT } from '../constants.js';
import { readLayoutFromFile } from '../layoutPersistence.js';
import { hookProviders } from '../providers/index.js';
import type { StandaloneAuth } from './auth.js';
import type { BuildingData, Change } from './building.js';
import {
  addFloor,
  BuildingStore,
  floorName,
  floorOfCharacter,
  floorOfRoom,
  isLayout,
  moveCharacter,
  moveRoom,
  placeNewRooms,
  removeFloor,
  renameFloor,
  setPerProject,
} from './building.js';
import { CharacterPartStore, registerPartRoutes } from './characterParts.js';
import { CharacterPresets, registerCharacterRoutes } from './characterPresets.js';
import type { CharacterSpec } from './characters.js';
import { CharacterBinder } from './characters.js';
import {
  parseChatCancel,
  parseChatEdit,
  parseChatHold,
  parseChatSend,
  parseChatSendNow,
  sendTextRefusal,
} from './chatSend.js';
import type { Lead } from './conversations.js';
import { Conversations, readOptions } from './conversations.js';
import type { BaseFloor, FloorLayout, Footprints } from './decor.js';
import { composeOffice, decorFromSave, DecorStore, resetDecorRoom } from './decor.js';
import { deviceLabel, deviceSource } from './device.js';
import type { AgentChoicesReader } from './engine/agentCapabilities.js';
import { AgentChoicesCache } from './engine/agentCapabilities.js';
import { handleAgentRules, rulesDirFor } from './engine/agentRules.js';
import { CodexAgent, runReport } from './engine/agents/codex/codex.js';
import type { CodexRecord } from './engine/codex.js';
import { codexJson, CodexTasks, readCodex } from './engine/codex.js';
import type { Reply } from './engine/control.js';
import { answerControl, controlPath, listenControl, refuse } from './engine/control.js';
import { answerDecision, answerMode, approvalsPath, ApprovalStore } from './engine/delegation.js';
import type { EngineMode } from './engine/engine.js';
import { CLD_BIN_DIR, cleanEnv, Engine, engineOn, nudgeText, renewText } from './engine/engine.js';
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
import { TASK_PATTERN, worktreePath } from './engine/git/worktrees.js';
import {
  defaultLocks,
  gpuDir,
  GpuQueue,
  unleasedFromProcesses,
  writeCollectorGpuHw,
} from './engine/gpu.js';
import { GpuBoardFold } from './engine/gpuBoard.js';
import { GroupMessages, roomEvents, roomTranscript } from './engine/groupMessages.js';
import { GroupStore } from './engine/groups.js';
import type { JobRecord } from './engine/jobs.js';
import { Jobs } from './engine/jobs.js';
import { leadTermBefore, readLeadHistory } from './engine/leadSwap.js';
import { LOG_PRUNE_INTERVAL_MS } from './engine/logPolicy.js';
import { pruneLogs } from './engine/logPrune.js';
import { McpTools } from './engine/mcpTools.js';
import type { MESSENGER_TIMING, Typist } from './engine/messenger.js';
import { Messenger, writeAtomic } from './engine/messenger.js';
import { DEFAULT_PROVIDER, loadRegistry, registryPath } from './engine/registry.js';
import { buildSessionPath } from './engine/sessionPath.js';
import { answerTask, startForTask, tasksPath, TaskStore } from './engine/tasks.js';
import type { TaskWorktreeDeps } from './engine/taskWorktree.js';
import { answerWorktree, worktreeForTask } from './engine/taskWorktree.js';
import { TurnLedger } from './engine/turnLedger.js';
import { EzRulesFile, ezRulesPath } from './ezRules.js';
import { detectHostInfo, listFolders, parseListFolders } from './folders.js';
import type { SocketStepUp, WsSend } from './hooks.js';
import { cldHooks } from './hooks.js';
import { hasHwReadings, HwSource, readTopProcesses, withoutDetail } from './hw/hwSource.js';
import type { RoomRect, RoomSpec } from './layout.js';
import {
  codexLabel,
  contractorSeatUid,
  floorPrefix,
  generateLayout,
  LOUNGE_ROOM,
  stackFloors,
  WHITEBOARD_TYPE,
} from './layout.js';
import { LevelStore } from './levels.js';
import { ENV_DUMP_NOTE, maskText } from './mask.js';
import { MemoStore } from './memos.js';
import { handleNewAgentPermission, newAgentPermissionMessage } from './newAgentPermission.js';
import { registerOwnerProfileRoutes } from './ownerProfile.js';
import { builtInPacksDir, PackStore } from './packs.js';
import {
  dialogCard,
  type OpenToolCall,
  parsePermissionAnswer,
  PermissionWaits,
  subjectCall,
} from './permissionWait.js';
import { PinStore } from './pins.js';
import type { ClaudeSession } from './providers/claudeProvider.js';
import {
  ClaudeAgentsSource,
  ClaudeSessions,
  entriesFromSessions,
  findOnPath,
  transcriptPath,
  waitsForPermission,
} from './providers/claudeProvider.js';
import type { AgentEntry, World } from './providers/types.js';
import { PushService, PushStore, type TurnInfo } from './push.js';
import { RoomSizer } from './roomSizer.js';
import { applyRoomReplies, RoomSummaries, type RoomSummary } from './roomUnread.js';
import { RosterStore } from './roster.js';
import { STEPUP_REQUIRED } from './shell/gate.js';
import { SlashCatalogue, slashRefusal } from './slashCommands.js';
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
import { currentTurn, type RoomRef } from './transcriptView.js';
import { managedInstall, registerUpdateRoutes, UpdateNotice } from './updateNotice.js';
import { type EarlyUsageReset, usageScript, UsageSource } from './usage.js';
import type { WorkReader, WorkTarget } from './workView.js';
import { echo, fileReader, parseWorkView, subagentReader, WorkViews } from './workView.js';

/** PERM-PROMPT: a confirmed permission wait of an engine lead, as the office keeps it. */
interface PermissionEntry {
  /** Which wait (a new episode gets a new one): a screen read answers only its own. */
  wait: number;
  asker?: string;
  /** The card from the transcripts, and the words an answer must find in the dialog. */
  transcript: PermissionWait & { match: string[] };
  /** The screen read of this wait: under way, or done (`dialog` when it found the whole dialog). */
  screen?: 'reading' | 'done';
  dialog?: string;
}

export const CLAUDE_POLL_MS = 30_000;
export const SESSIONS_DEBOUNCE_MS = 1_000;
export const HW_MS = 2_000;
const JOB_PROGRESS_MS = 10_000;
const REPORT_MS = 10_000;
/** While anyone watches, the messenger's transcript tails (T-0043) look for appended lines this often. */
export const CHAT_VIEW_POLL_MS = 1_500;
const CODEX_GRACE_MS = 5_000;
/** While anyone views: dead wrappers' tickets are swept this often (their end events fold the board). */
const GPU_SWEEP_MS = 30_000;
/** dist/cld-worker.js (T-0021): beside dist/cli.js, or the checkout's dist/ from the sources. */
export const CLD_WORKER: string | null =
  [
    path.join(__dirname, 'cld-worker.js'),
    path.resolve(__dirname, '../../../dist/cld-worker.js'),
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

/** Every floor's generated office (T-0027). */
interface FloorPlan {
  stamp: string;
  floors: Array<{ id: string; own: boolean; rooms: RoomRect[] }>;
  /** Floor 1 first. */
  layouts: Array<Record<string, unknown>>;
  /** Character key -> seat (chair uid). */
  seats: Record<string, string>;
  /** Character key -> the room (area label) it sits in on its floor. */
  areaOf: Map<string, string>;
}

export interface OfficeOptions {
  runtime: AgentRuntime;
  store: AgentStateStore;
  readOnly: boolean;
  /** --allow-chat: background sessions get a 대화 terminal (officeState.chat). */
  chat?: boolean;
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
  /** T-0039: push.json (the standalone CLI's ~/.config/cld-gui); none: no Web Push. */
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
  /** Catalogue refresh subscriptions, keyed by the client and its open lead. */
  private readonly slashViews = new Map<WsSend, Map<number, () => void>>();
  readonly jobs: Jobs | null;
  /** T-0021: Codex tasks the engine runs, and the GPU reservation queue. */
  readonly codex: CodexTasks | null;
  /** D5: the Codex provider (Codex Workers' runs on `codex`). */
  private readonly codexAgent: CodexAgent | null;
  /** D5: Worker runs whose end or limit is being told to their Lead right now. */
  private readonly telling = new Set<string>();
  /** D5: Worker runs whose end was told (read once from <id>.told, never again). */
  private readonly toldEnd = new Set<string>();
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
  /** P3a: the released-version notice; null for a source install (nothing to update from here). */
  private readonly updates: UpdateNotice | null;
  /** R3: the start policy and its facts, in 설정. */
  private readonly startPolicy: StartPolicyControl;
  private readonly hw: Pick<HwSource, 'sample'>;
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
  /** Open room timelines are the only reason to read member transcripts for replies. */
  private readonly groupViews = new Map<WsSend, Set<string>>();
  /** C3: what the messenger typed, which turn is whose (read by the DM view, contacts and push). */
  private readonly turnLedger = new TurnLedger();
  /** C3: each room's list summary, kept incrementally (roomUnread.ts). */
  private readonly roomSummaries = new RoomSummaries((room) => this.buildRoomSummary(room));
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
  private gen: { key: string; value: FloorPlan } | null = null;
  private readonly bases = new Map<string, FloorPlan>();
  /** Spare desks for temps per room (T-0041). */
  private readonly sizer = new RoomSizer();
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
  /** TEMP-PLATES: looks picked for employees hired this run, until characters.json has them. */
  private readonly hireLooks = new Map<string, { palette: number; hueShift: number }>();
  /** U-30: the pinned conversations. */
  readonly pins: PinStore;
  /** 작업 현황 (DEV-BOARD): the reported tasks; everyone gets them as they change. */
  readonly tasks: TaskStore;
  /** U-48 phase 1: the agents' own work lists as tracked items, read only while someone views. */
  private readonly tracking: TrackingFeed;
  /** The project folders `tracking` last resolved a cwd against (JSON); a change forgets the cwd answers. */
  private trackingFolders = '';
  private readonly cwdProjects = new Map<string, string | null>();
  /** D6: the removed assignees the task board last went out with (JSON). */
  private sentRemoved = '[]';
  /** D6: the agents' assignment ids by name, read from the engine's registry while its files stay the same. */
  private assignmentCache: {
    sig: string;
    map: Map<string, string> | null;
    /** CH-3: each registry name's agent provider (its first look's mascot). */
    providers: Map<string, string>;
  } | null = null;
  /** The office last broadcast after a building change (JSON). */
  private sentLayout = '';
  /** The floors last given to a client: they list the live world's rooms and characters. */
  private sentFloors = '';
  private lastBuildingError = '';
  private lastClaudeError = '';
  private started = false;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  /** T-0039: Web Push to devices that are not looking. */
  readonly push: PushService | null;
  /** PERM-PROMPT: engine sessions held by a permission dialog, and what each card shows. */
  private readonly permissionWaits: PermissionWaits | null;
  private readonly permissions = new Map<number, PermissionEntry>();
  private permissionSerial = 0;

  constructor(private readonly opts: OfficeOptions) {
    const home = opts.home ?? os.homedir();
    this.slash = new SlashCatalogue({ home });
    this.host = detectHostInfo(opts.home ?? os.homedir());
    this.binder = new CharacterBinder(opts.runtime, opts.store);
    this.codexBinder = new CharacterBinder(opts.runtime, opts.store, CODEX_GRACE_MS);
    this.characters = new CharacterPresets({
      configDir: path.join(opts.home ?? os.homedir(), '.config', 'cld-gui'),
      publish: (msg) => this.publish(msg),
      // Keys are names: an engine project's or a Claude session's; a temp employee's `emp:<id>`.
      knownKey: (key) =>
        this.world.agents.some((a) => a.name === key) ||
        (key.startsWith('emp:') && this.roster.allEmployees().some((e) => `emp:${e.id}` === key)),
    });
    const cldConfig = path.join(opts.home ?? os.homedir(), '.config', 'cld-gui');
    this.parts = new CharacterPartStore(
      path.join(cldConfig, 'parts'),
      (msg) => this.publish(msg),
      new PackStore({ builtInDir: builtInPacksDir(), userDir: path.join(cldConfig, 'packs') }),
    );
    this.updates = this.makeUpdateNotice(opts);
    this.startPolicy = this.makeStartPolicy();
    this.repos = new RepoManager({
      projects: () => this.projectFolders(),
      readOnly: opts.readOnly,
      configDir: path.join(opts.home ?? os.homedir(), '.config', 'cld-gui'),
      looking: (send) => !this.hidden.has(send),
      // W2: the 작업실's "worktree 만들기" (the owner's: createdBy user).
      taskWorktree: (req, privileged, source) =>
        worktreeForTask(
          this.taskWorktreeDeps(),
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
      nameOf: (id) => this.nameOfAssignment(id),
    });
    this.hw =
      opts.hw ??
      new HwSource({
        home: opts.home,
        lhmPort: opts.lhmPort,
        nvidiaSmi: opts.nvidiaSmi,
      });
    this.ezRules = new EzRulesFile(ezRulesPath(opts.home));
    this.building = new BuildingStore(
      path.join(opts.home ?? os.homedir(), '.config', 'cld-gui', 'building.json'),
    );
    this.decor = new DecorStore(path.join(home, '.config', 'cld-gui', 'decor.json'));
    this.memos = new MemoStore(path.join(home, '.config', 'cld-gui', 'memos.json'));
    // Nobody watching: the counters and their file only. A viewer's wake() reloads the
    // office, whose snapshot then carries the current levels (no snapshot built for nobody).
    this.levels = new LevelStore(path.join(home, '.config', 'cld-gui', 'levels.json'), () => {
      if (this.watching() > 0) this.publish<OfficeSnapshot>(this.officeState());
      this.publish(this.temps.message());
    });
    this.roster = new RosterStore(path.join(home, '.config', 'cld-gui', 'roster.json'));
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
    this.pins = new PinStore(path.join(home, '.config', 'cld-gui', 'pins.json'));
    this.tasks = new TaskStore(
      tasksPath(home),
      () => {
        this.opts.store.broadcast({ ...this.tasks.message() });
        this.mergeDoneTasks();
      },
      undefined,
      {
        readOnly: opts.readOnly,
        live: () => {
          const map = this.assignments();
          return map && new Set(map.values());
        },
        // D3b: a Task's assignee shows under the name its assignment answers to now.
        nameOf: (id) => this.nameOfAssignment(id),
      },
    );
    this.doneTasks = new Set(this.tasks.list({ status: 'done' }).map((t) => t.id));
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
        script: usageScript(home),
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
          taskWorktree: (project, task, assignmentId) => this.codexTaskWorktree(project, task, assignmentId),
          mayUse: (project, dir, assignmentId) => this.codexMayUse(project, dir, assignmentId),
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
          swapped: ([lead, worker]) => {
            this.messenger?.resync([lead, worker]);
            this.mcp?.forget([lead, worker]);
            this.leadProposals(lead, worker);
            this.opts.store.broadcast({ ...this.tasks.message() });
          },
        })
      : null;
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
            onDelivery: (item, delivered) => {
              this.groupMessages?.observe(item, delivered);
              // PERM-PROMPT: a message held for its session's terminal is a trigger to look.
              const id = delivered === 'held' ? this.agentIdOfName(item.to) : null;
              if (id !== null) this.permissionWaits?.suspect(id);
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
            changed: (roomId) => this.publishGroups(roomId),
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
              this.observeExecutions();
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
              this.observeExecutions();
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
    this.work = new WorkViews((t) => this.workReader(t));
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
            };
          },
          agentIdOf: (name) => this.agentIdOfName(name),
          // C3: only a lead with a conversation has room turns (the room posts go to those).
          turn: (id) => this.turnOf(id),
        })
      : null;
    this.permissionWaits = this.engine ? this.makePermissionWaits(opts.engineClaude!) : null;
  }

  /** The character of a project or session name, or null. */
  private agentIdOfName(name: string): number | null {
    const entry = this.world.agents.find((a) => a.name === name);
    return entry ? this.binder.idOf(entry.key) : null;
  }

  /**
   * PERM-PROMPT (permissionWait.ts): an engine session held by a permission dialog notifies
   * through the existing path (the lead's permission bubble, its sub-agent's, the 🔐 notice and
   * Web Push naming the asking sub-agent) and its messenger card shows what is asked.
   */
  private makePermissionWaits(claudePath: string): PermissionWaits {
    const agents = new ClaudeAgentsSource(claudePath);
    const engineEntry = (id: number) => {
      const e = this.entryOf(id);
      return e?.key.startsWith('engine:') && e.bg?.id ? e : null;
    };
    const waits = new PermissionWaits({
      isEngineLead: (id) => !!engineEntry(id),
      exempt: new Set(hookProviders.flatMap((p) => [...p.permissionExemptTools])),
      check: async () => {
        const rows = (await agents.list()).filter(waitsForPermission);
        const ids = new Set<number>();
        for (const a of this.world.agents) {
          const id = a.key.startsWith('engine:') ? this.binder.idOf(a.key) : null;
          if (id !== null && rows.some((r) => r.id === a.bg?.id || r.sessionId === a.sessionId)) ids.add(id);
        }
        return ids;
      },
      started: (id, subject, again) => {
        const e = engineEntry(id);
        const call: OpenToolCall | null =
          subject && e?.transcript ? subjectCall(e.transcript, subject) : null;
        const asker = subject?.parentToolId
          ? this.roster.employeeOf(`claude:${subject.parentToolId}`)?.nameId
          : undefined;
        // The same wait keeps its screen read (once per wait) and, once read, its screen card.
        const before = again ? this.permissions.get(id) : undefined;
        this.permissions.set(id, {
          wait: before?.wait ?? ++this.permissionSerial,
          ...((asker ?? before?.asker) && { asker: asker ?? before?.asker }),
          transcript: {
            // Answerable only with words its dialog must show.
            toolId: call?.match.length ? subject!.toolId : '',
            ...(call && { tool: call.tool }),
            ...(call?.detail && { detail: maskText(call.detail) }),
            match: call?.match ?? [],
          },
          ...(before?.screen && { screen: before.screen }),
          ...(before?.dialog && { dialog: before.dialog }),
        });
        this.readPermissionScreen(id);
        if (!again) {
          console.log(`[cld engine] "${e?.name ?? id}" waits on a permission dialog`);
          this.opts.store.broadcast({ type: 'agentToolPermission', id, ...(asker && { asker }) });
          if (subject?.parentToolId)
            this.opts.store.broadcast({
              type: 'subagentToolPermission',
              id,
              parentToolId: subject.parentToolId,
            });
        }
        this.conversations.republish();
      },
      cleared: (id) => {
        this.permissions.delete(id);
        this.opts.store.broadcast({ type: 'agentToolPermissionClear', id });
        this.conversations.republish();
      },
    });
    this.opts.store.on('broadcast', (m) => waits.observe(m));
    this.opts.store.on('agentRemoved', (id) => {
      waits.forget(id);
      this.permissions.delete(id);
    });
    return waits;
  }

  /**
   * PERM-PROMPT: while a wait is confirmed and someone views its conversation, read the dialog off
   * the session's screen, once per wait (one attach, read, detach: ~150 MB for a few seconds), and
   * make it the card: what the dialog itself says, and exactly what an answer must find on screen.
   * Unreadable (no attach, a dialog taller than the screen): the transcript card stays.
   */
  private readPermissionScreen(id: number): void {
    const p = this.permissions.get(id);
    const bg = this.entryOf(id)?.bg?.id;
    const read = this.opts.typist?.readPermissionDialog;
    if (!p || p.screen || !bg || !read || !this.conversations.viewing(id)) return;
    p.screen = 'reading';
    const done = (dialog: string | null) => {
      const cur = this.permissions.get(id);
      if (cur?.wait !== p.wait) return; // that wait is over
      cur.screen = 'done';
      if (dialog === null) delete cur.dialog;
      else cur.dialog = dialog;
      this.conversations.republish();
    };
    void read.call(this.opts.typist, bg).then(done, () => done(null));
  }

  /** PERM-PROMPT: the card a contact carries (never the words an answer matches against). */
  private permissionCard(p: PermissionEntry): PermissionWait {
    const screen = p.dialog ? dialogCard(p.dialog) : null;
    const detail = screen?.detail && maskText(screen.detail);
    const shown = screen
      ? {
          // Masking that dropped whole lines (an env-style block) hid part of what 허용 approves:
          // then the card offers only the terminal.
          toolId: detail?.includes(ENV_DUMP_NOTE)
            ? ''
            : `screen:${createHash('sha256').update(p.dialog!).digest('hex').slice(0, 16)}`,
          tool: maskText(screen.tool),
          ...(detail && { detail }),
        }
      : (({ match: _match, ...card }) => card)(p.transcript);
    return { ...shown, ...(p.asker && { asker: p.asker }) };
  }

  /** PERM-PROMPT: 허용/거부 on a card: privileged like typing into that session's terminal; a key
   *  only when its dialog is on screen and about the card's call (chat.ts answerPermission). */
  private async answerPermission(
    msg: Record<string, unknown>,
    privileged: boolean,
    device: string,
  ): Promise<PermissionAnswerResult | null> {
    const req = parsePermissionAnswer(msg);
    if (!req) return null;
    const reply = (o: Partial<PermissionAnswerResult>): PermissionAnswerResult => ({
      type: 'permissionAnswerResult',
      requestId: req.requestId,
      agentId: req.agentId,
      ok: true,
      ...o,
    });
    const e = this.entryOf(req.agentId);
    const refusal = !this.opts.chat
      ? refused('chat_off')
      : !privileged
        ? refused('no_permission')
        : !e?.key.startsWith('engine:') || !e.bg?.id
          ? refused('not_engine_project')
          : null;
    const what = `permission ${req.allow ? 'allow' : 'deny'} ${JSON.stringify(e?.name ?? req.agentId).slice(0, 66)} gui:${device}`;
    if (refusal || !e?.bg?.id) {
      console.log(`[cld engine] ${what}: refused (${refusal?.error})`);
      return reply({ ok: false, ...refusal });
    }
    const p = this.permissions.get(req.agentId);
    const card = p && this.permissionCard(p);
    const match = p?.dialog !== undefined ? { dialog: p.dialog } : p?.transcript.match;
    const result =
      !card?.toolId || card.toolId !== req.toolId || !match
        ? ('gone' as const)
        : ((await this.opts.typist?.answerPermission?.(e.bg.id, match, req.allow)) ?? 'failed');
    console.log(`[cld engine] ${what}: ${result}`);
    if (result === 'answered') this.permissionWaits?.answered(req.agentId);
    // Another dialog is up than the card says: read the screen again (the owner asked, once).
    if (result === 'otherDialog' && this.permissions.get(req.agentId) === p && p?.screen === 'done') {
      delete p.screen;
      this.readPermissionScreen(req.agentId);
    }
    return reply({ result });
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
      configDir: path.join(opts.home ?? os.homedir(), '.config', 'cld-gui'),
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
        path.join(this.opts.home ?? os.homedir(), '.config', 'cld-gui', 'profile'),
      );
      if (this.updates) registerUpdateRoutes(app, auth, this.updates, !!this.opts.readOnly, stepUpFresh, kindOf, actorOf);
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
    this.attachWorkerRuns();
    this.observeExecutions(); // runs that ended while the daemon was down
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
    this.migrateLayoutJson();
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
    this.permissionWaits?.dispose();
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
      const { error, changed } = this.building.apply((b) => placeNewRooms(b, this.roomLabels()));
      if (error && error !== this.lastBuildingError) console.warn(`[cld] building: ${error}`);
      this.lastBuildingError = error ?? '';
      if (changed) this.publishBuilding();
    }
    // After a restart the first clients get their floors before the world loads.
    // A client got its floors before the world loaded (a restart): re-send the list and
    // who sits in which room (not the office itself: it has its own path, the sizer).
    if (this.sentFloors && JSON.stringify(this.floorRows()) !== this.sentFloors) {
      this.opts.store.broadcast({ ...this.buildingState() });
      this.opts.store.broadcast(this.mappingsMessage());
    }
  }

  /** CH-1: every character name keeps the look it has now (characterPresets.pin). */
  private pinLooks(): void {
    const live = this.world.agents.flatMap((a) => {
      const id = this.binder.idOf(a.key);
      const agent = id === null ? undefined : this.opts.store.get(id);
      if (agent?.palette === undefined) return [];
      const provider = a.provider === 'engine' ? this.providerOfName(a.name) : 'claude';
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

  /** CH-3: an engine name's agent provider from the registry (null: unknown). */
  private providerOfName(name: string): string | null {
    this.assignments();
    return this.assignmentCache?.providers.get(name) ?? null;
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
        ...(key.startsWith('engine:') && this.heldEdits(o.name)),
      })),
    };
  }

  /**
   * D6: every agent's assignment id by name (a Lead's and a Worker's), from the
   * engine's registry files (the engine writes them on each change); null when
   * the engine is off or its registry cannot be read.
   */
  /** The name assignment `id` answers to now. */
  private nameOfAssignment(id: string): string | undefined {
    for (const [name, a] of this.assignments() ?? []) if (a === id) return name;
    return undefined;
  }

  /** W3: the Tasks seen done (null until the store is read): a newly done one merges. */
  private doneTasks: Set<string> | null = null;

  /** W3: a Task newly done: its worktree's branch merges into its base, automatically (so never
   *  into a protected branch: that one waits for a person's click in the 작업실). */
  private mergeDoneTasks(): void {
    if (!this.doneTasks || this.opts.readOnly) return;
    const done = this.tasks.list({ status: 'done' });
    for (const t of done) {
      if (this.doneTasks.has(t.id)) continue;
      const rec = this.repos.worktrees.forTask(t.project, t.id);
      if (rec) void this.repos.merge(t.project, rec.task, { privileged: true, source: 'auto', auto: true });
    }
    this.doneTasks = new Set(done.map((t) => t.id));
  }

  /** W2 (N6): worktrees just given, until their agent starts (taskWorktree.ts CLAIM_MS). */
  private readonly worktreeClaims = new Map<string, { assignmentId: string; until: number }>();

  /** W2: what "a worktree for a Task" works with (taskWorktree.ts). */
  private taskWorktreeDeps(): TaskWorktreeDeps {
    return {
      tasks: this.tasks,
      repos: this.repos,
      roster: () => this.engine?.roster() ?? [],
      holds: (a, taskId) => this.holdsWorktree(a, taskId),
      claims: this.worktreeClaims,
    };
  }

  /** W2 (N5, N6): agent `a` may be working in Task `taskId`'s worktree: running; a Claude agent
   *  that is on (down sessions are started again); a resting Codex Worker whose last run, which
   *  a follow-up continues, is that Task's. */
  holdsWorktree(a: { role: string; assignmentId: string | null; provider: string; live: boolean; wantRunning: boolean }, taskId: string): boolean {
    if (a.role === 'lead') return false; // its folder is the project's: it holds no worktree
    if (a.live) return true;
    if (a.provider !== 'codex') return a.wantRunning;
    return a.wantRunning && !!a.assignmentId && this.codex?.runsOf(a.assignmentId).at(-1)?.task === taskId;
  }

  /** W2 (N5): the folder of a Codex Worker's last run is still its own: not one of the daemon's
   *  worktrees that is now another agent's or removed. */
  codexMayUse(project: { name: string; folder: string }, dir: string, assignmentId: string): boolean {
    let top: string;
    try {
      top = fs.realpathSync(project.folder);
    } catch {
      return true;
    }
    const at = path.resolve(dir);
    const recs = this.repos.worktrees
      .all()
      .filter((r) => r.project === project.name && TASK_PATTERN.test(r.task) && worktreePath(top, r.task) === at);
    if (!recs.length) return true;
    const active = recs.find((r) => r.status === 'active');
    return !!active && (!active.assignmentId || active.assignmentId === assignmentId);
  }

  /** W2: `.worktrees/<task>` of the repository at `folder` (rebuilt, never the file's path), if it is there. */
  private worktreeFolder(folder: string, task: string): string | null {
    try {
      const at = worktreePath(fs.realpathSync(folder), task);
      return TASK_PATTERN.test(task) && fs.statSync(at).isDirectory() ? at : null;
    } catch {
      return null;
    }
  }

  /** W2: where a Codex Worker's new run for Task `task` goes: the Task's recorded worktree when
   *  it is this Worker's or nobody's (another Worker's is never shared), and it is there. */
  codexTaskWorktree(
    project: { name: string; folder: string },
    task: string,
    assignmentId: string,
  ): { path: string; branch: string } | null {
    const rec = this.repos.worktrees.forTask(project.name, task);
    if (!rec || (rec.assignmentId && rec.assignmentId !== assignmentId)) return null;
    const at = this.worktreeFolder(project.folder, rec.task);
    return at ? { path: at, branch: rec.branch } : null;
  }

  /**
   * W2: where a Claude Worker starts next (Engine's `assignedFolder`): the worktree last given
   * to it (and there); else, when its folder is one of the daemon's worktrees that is no longer
   * its own (given to another agent, or removed), its project's folder again; otherwise null
   * (no change: a folder the user gave it stays).
   */
  assignedFolder(p: { name: string; assignmentId?: string; workFolder?: string }): string | null {
    const project = p.assignmentId && this.engine?.projectOf(p.name);
    const folder = project ? this.engine?.folders().find((f) => f.name === project)?.folder : undefined;
    if (!project || !folder) return null;
    const recs = this.repos.worktrees.all().filter((r) => r.project === project);
    const when = (r: { assignedAt?: string; created: string }) => r.assignedAt ?? r.created;
    const mine = recs
      .filter((r) => r.status === 'active' && r.assignmentId === p.assignmentId)
      .sort((a, b) => when(b).localeCompare(when(a)))[0];
    const at = mine && this.worktreeFolder(folder, mine.task);
    if (at) return at;
    if (!p.workFolder) return null;
    let top: string;
    try {
      top = fs.realpathSync(folder);
    } catch {
      return null;
    }
    const own = path.resolve(p.workFolder);
    return recs.some((r) => TASK_PATTERN.test(r.task) && worktreePath(top, r.task) === own) ? folder : null;
  }

  private assignments(): Map<string, string> | null {
    if (!this.engine) return null;
    const file = registryPath(this.opts.home ?? os.homedir());
    const stamp = (f: string) => {
      try {
        const st = fs.statSync(f);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return '-';
      }
    };
    const sig = `${stamp(file)}|${stamp(path.join(path.dirname(file), 'assignments.json'))}`;
    if (this.assignmentCache?.sig !== sig) {
      const loaded = loadRegistry(file);
      this.assignmentCache = {
        sig,
        map:
          loaded.broken || loaded.migrated
            ? null
            : new Map(
                loaded.projects.flatMap((p) => {
                  const id = p.role ? p.assignmentId : p.leadAssignmentId;
                  return id ? [[p.name, id] as const] : [];
                }),
              ),
        providers: new Map(loaded.projects.map((p) => [p.name, p.provider ?? DEFAULT_PROVIDER])),
      };
    }
    return this.assignmentCache.map;
  }

  /**
   * D3b + C6: a proposal (a Worker's Task proposed to its Lead) is assigned to the Lead's
   * assignment. After a swap that assignment is the Worker `worker`; the project's open
   * proposals go to the new Lead, which decides them now (the Lead seat, like the project's
   * queued messages). Other Tasks keep their assignee (they follow the agent).
   */
  private leadProposals(lead: string, worker: string): void {
    const ids = this.assignments();
    const newLead = ids?.get(lead);
    const oldLead = ids?.get(worker);
    if (!newLead || !oldLead) return;
    for (const t of this.tasks.list({ project: lead, status: 'proposed' }))
      if (t.assignee?.assignmentId === oldLead) {
        const r = this.tasks.update(t.id, { assignee: { assignmentId: newLead, name: lead } }, 'engine');
        if (!r.ok) console.warn(`[cld] lead swap: proposal ${t.id} not moved to the new Lead (${String(r.error)})`);
      }
  }

  /** D6: the tasks' open Executions, settled from the Codex and job records. */
  private observeExecutions(): void {
    const jobs = this.jobs;
    const codex = this.codex;
    if (!jobs) return;
    let all: JobRecord[] | null = null;
    this.tasks.observe({
      codex: (id) => (codex ? readCodex(codex.dir, id) : null),
      job: (id) => (all ??= jobs.list(true, true)).find((j) => j.id === id) ?? null,
    });
  }

  /** D5: a Worker run with a Task is that Task's Execution, also when the daemon died between
   *  starting it and attaching it (the same id attaches once). */
  private attachWorkerRuns(): void {
    for (const r of this.codex?.workerRecords() ?? [])
      if (r.task && r.agent && !this.tasks.get(r.task)?.executions?.some((e) => e.id === `codex:${r.id}`))
        this.tasks.attach(r.task, { kind: 'codex', ref: r.id, log: r.log }, r.agent);
  }

  /** D5 (design §2.4): a Worker run that ended, or waits on a usage limit, is told to its Lead
   *  once, under the Worker's name; a room post's end goes to the room too. What was told is in
   *  <id>.told beside the record (the worker rewrites the record whole: never written here). */
  private reportWorkerRuns(): void {
    const codex = this.codex;
    if (!codex || !this.messenger || !this.engine || this.opts.readOnly) return;
    for (const r of codex.workerRecords()) {
      const mark = r.state === 'limit' ? `limit:${r.resetAt ?? ''}` : r.ended ? 'end' : null;
      if (!mark || !r.agent || this.telling.has(r.id) || this.toldEnd.has(r.id)) continue;
      const file = path.join(codex.dir, `${r.id}.told`);
      let told = '';
      try {
        told = fs.readFileSync(file, 'utf-8').trim();
      } catch {
        /* not told yet */
      }
      if (told === 'end') this.toldEnd.add(r.id);
      if (told === mark || told === 'end') continue;
      this.telling.add(r.id);
      void this.tellWorkerRun(r, mark, file)
        .catch((err) => console.warn(`[cld] codex ${r.id}: ${String(err)}`))
        .finally(() => this.telling.delete(r.id));
    }
  }

  /** C4: a delegation event as a room's one line: a Task given out, a Worker's report. */
  private systemLine(type: string, f: Record<string, unknown>): void {
    const task = typeof f.task === 'string' ? f.task : null;
    const from = typeof f.from === 'string' ? f.from : null;
    if (!task || !from || !this.groupMessages) return;
    if (type === 'delegate' && typeof f.to === 'string')
      this.groupMessages.system({ kind: 'assigned', task, from, to: f.to, detail: this.tasks.get(task)?.title });
    else if (type === 'task_report')
      this.groupMessages.system({
        kind: 'reported',
        task,
        from,
        to: this.engine?.projectOf(from) ?? undefined,
        detail: typeof f.status === 'string' ? f.status : undefined,
      });
  }

  private async tellWorkerRun(r: CodexRecord, mark: string, file: string): Promise<void> {
    const text = runReport(r, shortStamp);
    const lead = this.engine?.projectOf(r.agent!) ?? r.project;
    if (text && lead && this.engine?.names().includes(lead)) {
      const sent = await this.messenger!.send({
        to: lead,
        text,
        ifIdle: false,
        from: r.agent!,
        source: 'codex',
        ...(r.task && { task: r.task }),
        // K1: a finished run is the Lead's to decide on; a usage-limit wait resumes by itself.
        notice: mark === 'end' ? 'action' : 'fyi',
      });
      if (!sent.ok) {
        console.warn(`[cld] codex ${r.id}: ${lead} not told (${sent.error}); tried again on the next change`);
        return;
      }
    }
    // C4: the report as one line in the rooms that hold the Worker and its Lead (not the run's own
    // room: the summary below says it there).
    if (mark === 'end' && r.task && lead && lead !== r.agent)
      this.groupMessages?.system({ kind: 'reported', task: r.task, from: r.agent!, to: lead, detail: r.state, except: r.room?.id });
    if (mark === 'end' && r.room && this.groupMessages) {
      const post = await this.groupMessages.post({
        room: r.room.id,
        text: r.summary?.trim() || '(마지막 메시지가 없어요)',
        from: r.agent!,
        source: 'codex',
        quiet: true, // TOKEN-GUARD (TG-02b): the Lead is told above; the room copy wakes nobody
      });
      if (!post.ok) console.warn(`[cld] codex ${r.id}: room ${r.room.id} not posted (${post.error})`);
    }
    try {
      writeAtomic(file, `${mark}\n`);
      if (mark === 'end') this.toldEnd.add(r.id);
    } catch (err) {
      console.warn(`[cld] codex ${r.id}: ${String(err)}`);
    }
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
    const file = controlPath(this.opts.home ?? os.homedir());
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
        const u =
          provider === 'claude' ? this.usage.usage?.claude : provider === 'codex' ? this.usage.usage?.codex : null;
        const full = !!u && ((u.fiveHourPct ?? 0) >= 100 || (u.sevenDayPct ?? 0) >= 100);
        // One Codex account: a run waiting on its limit holds every Codex Worker (design §2.1).
        return full || (provider === 'codex' && (this.codex?.workerRecords() ?? []).some((r) => r.state === 'limit'));
      },
      send: (r) => messenger.send(r),
      groupPost,
      findRoom: (room) => this.groupStore?.find(room) ?? null,
      timeline: (room) => this.groupMessages?.timeline(room, Number.MAX_SAFE_INTEGER) ?? [],
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
            this.taskWorktreeDeps(),
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
          projectOf: (name) => engine.projectOf(name),
          engineAction: (req) => engine.run(req, true, 'cli'),
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
            answerWorktree({ ...this.taskWorktreeDeps(), projects: () => engine.projectNames() }, args, who),
          task: (args, who) =>
            args.op === 'mode'
              ? answerMode(this.approvals, args, who, engine.projectNames())
              : answerTask(this.tasks, args, who, {
                  assignmentOf: (name) => this.assignments()?.get(name) ?? null,
                  names: () => engine.names(),
                }),
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

  /** The job panel (T-0019): read an engine job's log, or stop it (actions on, after the client's confirmation). */
  private jobAction(
    msg: Record<string, unknown>,
    send: WsSend,
    privileged: boolean,
    device: string,
  ): void {
    const { requestId, action, id } = msg;
    if (typeof requestId !== 'string' || !requestId || requestId.length > 128) return;
    if (action !== 'log' && action !== 'stop') return;
    if (typeof id !== 'string' || id.length > 128) return;
    const reply = (r: Partial<JobActionResult> & { ok: boolean }) =>
      send({ type: 'jobActionResult', requestId, action: action as JobActionKind, id, ...r });
    if (!this.jobs) return reply({ ok: false, ...refused('engine_off') });
    if (!privileged) return reply({ ok: false, ...refused('no_permission') });
    if (action === 'log') {
      const log = this.jobs.readLog(id);
      return reply(
        log
          ? {
              ok: true,
              log: log.text,
              truncated: log.truncated,
              digest: log.digest,
              logPath: log.path,
            }
          : { ok: false, ...refused('job_unknown') },
      );
    }
    if (this.opts.readOnly) return reply({ ok: false, ...refused('read_only_mode') });
    const r = this.jobs.stop(id, `gui:${device}`);
    reply(r.ok ? { ok: true } : { ok: false, error: r.error, ...(r.errorCode && { errorCode: r.errorCode, errorParams: r.errorParams }) });
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
    const provider = reset.provider === 'codex' ? 'Codex' : 'Claude';
    const fields = { provider: reset.provider, period: reset.period };
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
      summary: koText(reset.period === 'sevenDay' ? 'ev_usage_reset_week' : 'ev_usage_reset_5h', { provider }),
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

  private everyone(): AgentEntry[] {
    return this.world.agents;
  }

  roomSpecs(): RoomSpec[] {
    const all = this.everyone();
    const engineCodex = !!this.codex;
    return this.world.rooms.map((r) => {
      const members = all.filter((a) => a.tab === r.name).sort((a, b) => a.order - b.order);
      return {
        label: r.name,
        members: members.map((a) => a.key),
        contractorDesk:
          r.kind === 'orch' && members.some((a) => engineCodex && a.key.startsWith('engine:')),
        spare: this.sizer.spareFor(r.name),
      };
    });
  }

  /** The rooms the office draws (with a character or a contractor desk), in order. */
  private roomLabels(): string[] {
    return this.roomSpecs()
      .filter((r) => r.members.length || r.contractorDesk)
      .map((r) => r.label);
  }

  /**
   * Every floor's generated office (T-0027): a room on its floor with its
   * contractor desk; its characters placed on another floor sit in an annex
   * there ("2층 <room>"), and each floor has a lounge ("2층 라운지" above the
   * first; floor 1 also has the 로비, T-0046), so no area label is on two floors. Seats stay `seat:<key>`
   * whichever floor a character is on.
   */
  plan(): FloorPlan {
    const b = this.building.data;
    const specs = this.roomSpecs();
    const names = new Map(this.everyone().map((a) => [a.key, a.name]));
    const key = JSON.stringify([
      specs,
      b.floors.map((f) => [f.id, f.rooms, f.characters, f.layout]),
      [...names],
    ]);
    if (this.gen?.key === key) return this.gen.value;
    const seats: Record<string, string> = {};
    const areaOf = new Map<string, string>();
    const overflow: Array<[string, number]> = [];
    const floorPlans: FloorPlan['floors'] = [];
    const layouts = b.floors.map((floor, k) => {
      const rooms: RoomSpec[] = specs.map((spec) => {
        const home = floorOfRoom(b, spec.label).id === floor.id;
        const label = home ? spec.label : `${floorName(k + 1)} ${spec.label}`;
        const members = spec.members.filter(
          (m) => floorOfCharacter(b, names.get(m) ?? m, spec.label).id === floor.id,
        );
        for (const m of members) areaOf.set(m, label);
        return {
          label,
          members,
          contractorDesk: home && spec.contractorDesk,
          spare: home && members.length ? spec.spare : 0,
        };
      });
      const gen = generateLayout(rooms, k ? koText('room_lounge_floor', { floor: floorName(k + 1) }) : LOUNGE_ROOM);
      const own = k > 0 && isLayout(floor.layout);
      floorPlans.push({ id: floor.id, own, rooms: own ? [] : gen.rooms });
      Object.assign(seats, gen.seats);
      for (const label of gen.overflow) overflow.push([label, k]);
      return own ? floor.layout! : (gen.layout as unknown as Record<string, unknown>);
    });
    const stamp = createHash('sha1').update(key).digest('hex').slice(0, 12);
    this.gen = { key, value: { stamp, floors: floorPlans, layouts, seats, areaOf } };
    this.bases.delete(stamp);
    this.bases.set(stamp, this.gen.value);
    if (this.bases.size > 16) this.bases.delete(this.bases.keys().next().value!);
    if (overflow.length) queueMicrotask(() => this.spill(overflow));
    return this.gen.value;
  }

  /**
   * Rooms a floor had no room for (64 rows) go to the next floor, a new one
   * when it was the last: never shrunk (T-0041). Only a room on its home
   * floor moves; an annex follows its room.
   */
  private spill(overflow: Array<[string, number]>): void {
    const { changed } = this.building.apply((b) => {
      let next: BuildingData = b;
      for (const [label, k] of overflow) {
        if (floorOfRoom(next, label).id !== next.floors[k]?.id) continue;
        if (!next.floors[k + 1]) {
          const grown = addFloor(next);
          if ('error' in grown) return next; // at the most floors: as it is
          next = grown;
        }
        const moved = moveRoom(next, label, next.floors[k + 1].id);
        if (!('error' in moved)) next = moved;
      }
      return next;
    });
    if (changed) {
      console.log(`[cld] building: ${overflow.length} room(s) spilled to the next floor`);
      this.publishBuilding();
    }
  }

  /** Temps per room now: sub-agent spawns and teammates under their lead,
   *  running Codex tasks in their project's room (T-0041). */
  private tempCounts(): Map<string, number> {
    const roomOf = new Map(this.everyone().map((a) => [a.key, a.tab]));
    const counts = new Map<string, number>();
    const add = (id: number, n: number) => {
      const room = roomOf.get(this.binder.keyOf(id) ?? '');
      if (room && n) counts.set(room, (counts.get(room) ?? 0) + n);
    };
    for (const a of this.opts.store.values()) {
      if (a.leadAgentId !== undefined) {
        add(a.leadAgentId, 1);
        continue;
      }
      const spawns = new Set([
        ...a.activeSubagentToolNames.keys(),
        ...a.backgroundAgentToolIds,
        ...[...a.activeToolNames]
          .filter(([, n]) => n === 'Task' || n === 'Agent')
          .map(([id]) => id),
      ]);
      add(a.id, spawns.size);
    }
    for (const t of this.codexTasks() ?? []) {
      const room = this.codexRoom(t.project);
      if (room && (t.state === 'running' || t.state === 'limit'))
        counts.set(room, (counts.get(room) ?? 0) + 1);
    }
    return counts;
  }

  /** Count the temps; when a room's need crossed a step (at most every few
   *  minutes), the office is drawn again with its spare desks. */
  private sampleRooms(now = Date.now()): void {
    this.sizer.note(this.tempCounts(), now);
    if (this.sizer.resize(now)) this.publishBuilding();
  }

  private baseFloors(p: FloorPlan): BaseFloor[] {
    return p.floors.map((f, k) => ({ ...f, layout: p.layouts[k] as FloorLayout }));
  }

  /** The user's decor first, the generated plan around it (T-0066), per floor. */
  layoutFor(): Record<string, unknown> {
    const p = this.plan();
    const { layouts, seats } = composeOffice(
      this.baseFloors(p),
      this.decor.data,
      this.opts.catalog?.() ?? [],
    );
    const office =
      layouts.length === 1
        ? layouts[0]
        : stackFloors(
            p.floors.map((f, k) => ({
              id: f.id,
              prefix: floorPrefix(f.id, k),
              layout: layouts[k],
            })),
          );
    // A chair the user removed: the webview seats its member at the chair named here (null: none).
    // Our tiles are the current format (VOID 255): without a revision the webview reads tile 8,
    // a floor pattern, as the old VOID and a painted floor came back as a hole.
    return {
      ...office,
      layoutRevision: Math.max(1, Number(office.layoutRevision) || 0),
      cldBase: p.stamp,
      ...(Object.keys(seats).length && { cldSeats: seats }),
    };
  }

  saveLayout(layout: Record<string, unknown>, send: WsSend): true {
    const base = typeof layout.cldBase === 'string' ? this.bases.get(layout.cldBase) : this.plan();
    if (!base) {
      console.warn('[cld] decor: an edit of an office no longer known; not kept');
      send({ type: 'layoutLoaded', layout: this.layoutFor() });
      return true;
    }
    const next = decorFromSave(
      layout,
      this.baseFloors(base),
      this.decor.data,
      this.opts.catalog?.() ?? [],
    );
    if (typeof next === 'string') {
      console.warn(`[cld] decor: ${next}; not kept`);
      return true;
    }
    const error = this.decor.save(next);
    if (error) {
      console.warn(`[cld] decor: ${error}`);
      return true;
    }
    send({ type: 'layoutLoaded', layout: this.layoutFor() });
    this.publishBuilding();
    return true;
  }

  private migrateLayoutJson(): void {
    if (this.decor.exists()) return;
    let saved: Record<string, unknown> | null;
    if (this.opts.home) {
      try {
        saved = JSON.parse(
          fs.readFileSync(path.join(this.opts.home, '.pixel-agents', 'layout.json'), 'utf-8'),
        ) as Record<string, unknown>;
      } catch {
        saved = null;
      }
    } else saved = readLayoutFromFile();
    const def = this.opts.defaultLayout;
    const isDefault =
      !!saved &&
      !!def &&
      JSON.stringify(saved.tiles) === JSON.stringify(def.tiles) &&
      JSON.stringify(saved.furniture) === JSON.stringify(def.furniture);
    if (!saved || !isLayout(saved) || isDefault) return;
    const next = decorFromSave(
      saved,
      this.baseFloors(this.plan()),
      { version: 1, rooms: {} },
      this.opts.catalog?.() ?? [],
    );
    const unrelated = typeof next === 'string';
    const data = unrelated ? { version: 1 as const, rooms: {} } : next;
    const error = this.decor.save(data);
    if (error) console.warn(`[cld] decor: migration: ${error}`);
    else if (unrelated) console.log('[cld] decor: layout.json is not a cld office; no longer used');
    else
      console.log(`[cld] decor: layout.json converted (${Object.keys(data.rooms).length} rooms)`);
  }

  seatFor(agentId: number): string | undefined {
    const key = this.binder.keyOf(agentId);
    if (key) return this.plan().seats[key];
    // A contractor prefers its project's contractor desk.
    const task = this.codexTasks()?.find(
      (t) => `codex:${t.id}` === this.codexBinder.keyOf(agentId),
    );
    const room = task && this.codexRoom(task.project);
    return room ? contractorSeatUid(room) : undefined;
  }

  /** Character label -> its room on its floor (contractors `codex·<project>`
   *  -> the project's room, where the contractor desk is). */
  areaMappings(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    const { areaOf } = this.plan();
    for (const a of this.everyone()) {
      out[a.name] = [areaOf.get(a.key) ?? a.tab];
      if (this.codex && a.key.startsWith('engine:')) out[codexLabel(a.name)] = [a.tab];
    }
    return out;
  }

  /** The floors, floor 1 first, with the rooms and characters on each (T-0027). */
  private floorRows(): BuildingState['floors'] {
    const b = this.building.data;
    const rooms = this.roomLabels();
    const names = new Set(this.everyone().map((a) => a.name));
    return b.floors.map((f) => ({
      id: f.id,
      name: f.name,
      rooms: rooms.filter((r) => floorOfRoom(b, r).id === f.id),
      characters: f.characters.filter((c) => names.has(c)),
    }));
  }

  /** Who sits in which room; the user's own mappings win, as at connect. */
  private mappingsMessage(): Record<string, unknown> {
    return {
      type: 'areaMappingsLoaded',
      mappings: { ...this.areaMappings(), ...(readConfig().standalone.areaMappings ?? {}) },
    };
  }

  /** The floor list with the 보관함 counts; the floors it gives out are remembered. */
  buildingState(why?: Coded & { error?: string }): BuildingState {
    const { stored, held } = composeOffice(
      this.baseFloors(this.plan()),
      this.decor.data,
      this.opts.catalog?.() ?? [],
    );
    // 보관함: the user's items that do not fit, and generator items with no room left.
    const decorRows = Object.keys(this.decor.data.rooms).map((room) => ({
      room,
      stored: (stored[room]?.furniture.length ?? 0) + (held[room]?.length ?? 0),
    }));
    const floors = this.floorRows();
    this.sentFloors = JSON.stringify(floors);
    return {
      type: 'buildingState',
      floors,
      perProject: this.building.data.perProject,
      ...(decorRows.length && { decor: decorRows }),
      ...(why?.error && { error: why.error, ...(why.errorCode && { errorCode: why.errorCode, ...(why.errorParams && { errorParams: why.errorParams }) }) }),
    };
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
    // Saved, everyone already has it (the store's broadcast); refused, the sender gets why.
    if (!r.ok) send({ ...this.tasks.message(), error: String(r.error) });
  }

  /** A building change reaches every client: the office first when it
   *  changed (it says which rows are which floor; a re-sent office seats every
   *  character anew, so a rename sends none), then the floor list. */
  private publishBuilding(forceLayout = false): void {
    const store = this.opts.store;
    const layout = this.layoutFor();
    const json = JSON.stringify(layout);
    if (forceLayout || json !== this.sentLayout) {
      this.sentLayout = json;
      store.broadcast({ type: 'layoutLoaded', layout });
      store.broadcast(this.mappingsMessage());
    }
    store.broadcast({ ...this.buildingState() });
  }

  /** addFloor, renameFloor, removeFloor, moveToFloor, setFloorRule (T-0027).
   *  Cosmetic: any logged-in client, also on a read-only daemon. */
  private onBuildingMessage(
    msg: Record<string, unknown>,
    send: WsSend,
    privileged: boolean,
  ): boolean {
    const id = typeof msg.floorId === 'string' ? msg.floorId : '';
    let change: (b: BuildingData) => Change;
    if (msg.type === 'addFloor') change = (b) => addFloor(b, msg.name);
    else if (msg.type === 'renameFloor') change = (b) => renameFloor(b, id, msg.name);
    else if (msg.type === 'removeFloor') change = (b) => removeFloor(b, id);
    else if (msg.type === 'moveToFloor') change = (b) => this.moveToFloor(b, msg, id);
    else if (msg.type === 'setFloorRule')
      change = (b) =>
        typeof msg.perProject === 'boolean'
          ? setPerProject(b, msg.perProject, this.roomLabels())
          : refused('floor_choose_toggle');
    else return false;
    if (!privileged) return true; // upstream refuses a read-only client before this
    const { changed, ...failure } = this.building.apply((b) => {
      const next = change(b);
      return 'error' in next ? next : this.tidy(next);
    });
    if (failure.error) {
      console.warn(`[cld] ${msg.type}: ${failure.error}`);
      send({ ...this.buildingState(failure) });
    } else if (changed) {
      console.log(`[cld] building: ${msg.type} (${this.building.data.floors.length} floors)`);
      this.publishBuilding();
    }
    return true;
  }

  /** A character placed on its own room's floor just follows its room. */
  private tidy(b: BuildingData): BuildingData {
    const roomOf = new Map(this.everyone().map((a) => [a.name, a.tab]));
    return {
      ...b,
      floors: b.floors.map((f) => ({
        ...f,
        characters: f.characters.filter((c) => {
          const room = roomOf.get(c);
          return room === undefined || floorOfRoom(b, room).id !== f.id;
        }),
      })),
    };
  }

  private moveToFloor(b: BuildingData, msg: Record<string, unknown>, floorId: string): Change {
    const { room, character } = msg;
    if (typeof room === 'string' && character === undefined) {
      if (!this.roomLabels().includes(room)) return refused('office_unknown');
      const members = this.everyone().filter((a) => a.tab === room);
      return moveRoom(
        b,
        room,
        floorId,
        members.map((a) => a.name),
      );
    }
    if (typeof character === 'string' && room === undefined) {
      const entry = this.everyone().find((a) => a.name === character);
      return entry ? moveCharacter(b, entry.name, entry.tab, floorId) : refused('character_unknown');
    }
    return refused('office_or_character');
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
    const dismissed = path.join(this.host.home, '.config', 'cld-gui', 'import-suggestion.json');
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
    send({ ...this.tasks.message() });
    for (const m of this.tracking.snapshot()) send({ ...m });
    if (this.groupStore) send({ type: 'groupRooms', rooms: this.groupRooms() });
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
    this.repos.onClientClosed(send);
    this.unwatchSlash(send);
    this.hwViewers.delete(send);
    this.updateHwCadence();
    this.lookedAt.delete(send);
    if (!this.viewers.delete(send)) return;
    const wasLooking = !this.hidden.delete(send);
    for (const name of [...this.views.keys()]) this.unview(name, send);
    this.conversations.drop(send);
    this.groupViews.delete(send);
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
          this.publishRoomActivity();
          this.pollGroupViews();
        }, CHAT_VIEW_POLL_MS),
      );
      this.timers.push(setInterval(() => void this.work.poll(), CHAT_VIEW_POLL_MS));
    }
    this.timers.push(setInterval(() => this.sampleRooms(), ROOM_SAMPLE_MS));
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
    if (msg.type === 'hwView') {
      if (this.viewers.has(send) && typeof msg.on === 'boolean') {
        if (msg.on) this.hwViewers.add(send);
        else this.hwViewers.delete(send);
        this.updateHwCadence();
        if (msg.on) this.tickHw();
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
    if (this.onBuildingMessage(msg, send, privileged)) return;
    if (msg.type === 'resetRoomDecor') {
      if (privileged && typeof msg.room === 'string') {
        const error = this.decor.save(resetDecorRoom(this.decor.data, msg.room));
        if (error) console.warn(`[cld] decor: ${error}`);
        else this.publishBuilding(true);
      }
      return;
    }
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
    if (msg.type === 'engineAction') {
      this.engine?.handle(msg, send, privileged, deviceLabel(userAgent), stepUp);
      return;
    }
    if (msg.type === 'projectScan') {
      if (
        typeof msg.requestId !== 'string' ||
        (msg.folder !== undefined && typeof msg.folder !== 'string')
      )
        return;
      try {
        const candidates =
          this.engine?.scanImport(
            msg.folder ?? path.join(this.host.home, 'projects'),
            privileged,
          ) ?? [];
        send({
          type: 'projectScanResult',
          requestId: msg.requestId,
          ok: !!this.engine,
          candidates,
        });
      } catch (e) {
        send({
          type: 'projectScanResult',
          requestId: msg.requestId,
          ok: false,
          candidates: [],
          ...refusedOf(e, (err) => (err instanceof Error ? err.message : refused('folder_unreadable').error)),
        });
      }
      return;
    }
    if (msg.type === 'projectImport') {
      if (
        typeof msg.requestId !== 'string' ||
        typeof msg.folder !== 'string' ||
        !Array.isArray(msg.rows) ||
        msg.rows.length > 100 ||
        !msg.rows.every(
          (r: unknown) =>
            typeof r === 'object' &&
            r !== null &&
            typeof (r as Record<string, unknown>).folder === 'string' &&
            typeof (r as Record<string, unknown>).name === 'string' &&
            typeof (r as Record<string, unknown>).room === 'string' &&
            typeof (r as Record<string, unknown>).resume === 'boolean' &&
            typeof (r as Record<string, unknown>).start === 'boolean',
        )
      )
        return;
      if (this.engine)
        void this.engine
          .importProjects(
            msg.requestId,
            msg.folder,
            msg.rows as import('../../../core/src/messages.js').ProjectImportRow[],
            privileged,
          )
          .then((result) => send({ ...result }));
      return;
    }
    if (msg.type === 'projectImportUndo') {
      if (typeof msg.requestId === 'string' && typeof msg.batchId === 'string' && this.engine)
        send({ ...this.engine.undoImport(msg.requestId, msg.batchId, privileged) });
      return;
    }
    if (msg.type === 'projectImportDismiss') {
      if (privileged && !this.opts.readOnly) {
        const file = path.join(this.host.home, '.config', 'cld-gui', 'import-suggestion.json');
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          fs.writeFileSync(file, '{}\n', { mode: 0o600 });
        } catch {
          /* next launch may suggest again */
        }
      }
      return;
    }
    if (msg.type === 'engineChoicesRefresh') {
      // Runs the CLIs (synchronously): not for a read-only viewer.
      if (this.engine && privileged)
        send(this.engine.refreshAgentChoices() as unknown as Record<string, unknown>);
      return;
    }
    if (msg.type === 'jobAction') {
      this.jobAction(msg, send, privileged, deviceLabel(userAgent));
      return;
    }
    if (this.repos.onClientMessage(msg, send, privileged, deviceSource(deviceLabel(userAgent)), stepUp)) {
      return;
    }
    if (msg.type === 'listFolders') {
      const req = parseListFolders(msg);
      if (!req) console.warn('[cld] malformed listFolders dropped');
      else send({ ...this.folderList(req, privileged) });
      return;
    }
    if (msg.type === 'chatSend' || msg.type === 'chatSendNow') {
      const req = msg.type === 'chatSend' ? parseChatSend(msg) : parseChatSendNow(msg);
      if (!req) console.warn(`[cld] malformed ${msg.type} dropped`);
      else
        void this.chatSend(req, privileged, deviceLabel(userAgent)).then(
          (result) => send({ ...result }),
          (err: unknown) => console.warn(`[cld] send: ${String(err)}`),
        );
      return;
    }
    if (msg.type === 'chatCancel' || msg.type === 'chatEdit') {
      const req = msg.type === 'chatCancel' ? parseChatCancel(msg) : parseChatEdit(msg);
      if (!req) console.warn(`[cld] malformed ${msg.type} dropped`);
      else
        void this.chatPending(req, privileged, deviceLabel(userAgent)).then(
          (result) => send({ ...result }),
          (err: unknown) => console.warn(`[cld] pending message: ${String(err)}`),
        );
      return;
    }
    if (msg.type === 'permissionAnswer') {
      void this.answerPermission(msg, privileged, deviceLabel(userAgent)).then(
        (result) => (result ? send({ ...result }) : console.warn('[cld] malformed permissionAnswer dropped')),
        (err: unknown) => console.warn(`[cld] permission answer: ${String(err)}`),
      );
      return;
    }
    if (msg.type === 'chatHold') {
      const req = parseChatHold(msg);
      if (!req) console.warn('[cld] malformed chatHold dropped');
      else this.chatHold(req, privileged);
      return;
    }
    if (msg.type === 'groupView') {
      // Like chatView: reading a member's transcript needs the chat feature.
      if (!this.opts.chat || typeof msg.room !== 'string' || typeof msg.on !== 'boolean') return;
      const room = this.groupStore?.find(msg.room);
      if (!room || !this.groupMessages) return;
      const mine = this.groupViews.get(send) ?? new Set<string>();
      if (msg.on) {
        mine.add(room.id);
        this.groupViews.set(send, mine);
        send({ type: 'groupTimeline', room, posts: this.roomTimeline(room) });
      } else {
        mine.delete(room.id);
        if (!mine.size) this.groupViews.delete(send);
      }
      return;
    }
    if (msg.type === 'groupPost') {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
      const room = typeof msg.room === 'string' ? msg.room : '';
      const text = typeof msg.text === 'string' ? msg.text : '';
      if (!this.opts.chat || !privileged || !requestId || !this.groupMessages) {
        send({
          type: 'groupActionResult',
          requestId,
          ok: false,
          ...(!this.opts.chat ? refused('chat_off') : refused('no_permission')),
        });
        return;
      }
      void this.groupMessages
        .post({
          room,
          text,
          from: null,
          source: `messenger:${deviceLabel(userAgent)}`,
          replyTo: msg.replyTo,
        })
        .then((result) => {
          send({
            type: 'groupActionResult',
            requestId,
            ok: result.ok,
            ...(!result.ok && pickRefusal(result)),
          });
          if (result.ok) this.publishGroups(room);
        });
      return;
    }
    if (msg.type === 'groupAction') {
      const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
      const action = typeof msg.action === 'string' ? msg.action : '';
      const id = typeof msg.id === 'string' ? msg.id : '';
      const name = typeof msg.name === 'string' ? msg.name : '';
      const members =
        Array.isArray(msg.members) && msg.members.every((x) => typeof x === 'string')
          ? msg.members
          : [];
      let result: { ok: boolean } & Partial<WithError> = { ok: false, ...refused('bad_request') };
      if (!privileged) result = { ok: false, ...refused('no_permission') };
      else if (this.groupStore) {
        if (action === 'create') result = this.groupStore.create(name, members);
        else if (action === 'rename') result = this.groupStore.rename(id, name);
        else if (action === 'delete') result = this.groupStore.remove(id);
        else if (action === 'setMembers') result = this.groupStore.setMembers(id, members);
        else if (action === 'systemLines' && typeof msg.on === 'boolean')
          result = this.groupStore.setSystemLines(id, msg.on);
      }
      send({
        type: 'groupActionResult',
        requestId,
        ok: result.ok,
        ...(!result.ok && (result.error ? pickRefusal(result as WithError) : refused('group_change_failed'))),
      });
      if (result.ok) this.publishGroups();
      return;
    }
    if (msg.type === 'slashCommands') {
      if (!Number.isInteger(msg.agentId) || typeof msg.requestId !== 'string') return;
      this.sendSlashCommands(msg.agentId as number, msg.requestId, send, privileged);
      return;
    }
    if (msg.type === 'chatView') {
      if (!this.opts.chat || typeof msg.agentId !== 'number' || typeof msg.on !== 'boolean') return;
      this.conversations.view(send, msg.agentId, msg.on);
      if (!msg.on) this.unwatchSlash(send, msg.agentId);
      else this.readPermissionScreen(msg.agentId); // PERM-PROMPT: a card someone now looks at
      return;
    }
    if (msg.type === 'chatHistory' || msg.type === 'chatSearch') {
      if (!this.opts.chat || !Number.isInteger(msg.agentId) || typeof msg.requestId !== 'string')
        return;
      const agentId = msg.agentId as number;
      if (!privileged) {
        send(
          msg.type === 'chatHistory'
            ? {
                type: 'chatHistoryResult',
                requestId: msg.requestId,
                agentId,
                items: [],
                done: false,
                ...refused('no_permission'),
              }
            : {
                type: 'chatSearchResult',
                requestId: msg.requestId,
                agentId,
                hits: [],
                truncated: false,
                ...refused('no_permission'),
              },
        );
        return;
      }
      if (msg.type === 'chatHistory') {
        if (msg.before !== undefined && typeof msg.before !== 'string') return;
        if (
          msg.until !== undefined &&
          (typeof msg.until !== 'number' || !Number.isFinite(msg.until))
        )
          return;
        this.conversations.history(
          send,
          agentId,
          msg.requestId,
          msg.before as string | undefined,
          msg.until as number | undefined,
        );
      } else if (typeof msg.query === 'string') {
        this.conversations.search(send, agentId, msg.requestId, msg.query);
      }
      return;
    }
    if (msg.type === 'workView') {
      const req = this.opts.chat ? parseWorkView(msg) : null;
      if (!req) return;
      if (req.on && !privileged) {
        send({
          type: 'workContent',
          ...echo(req.target),
          items: [],
          ...refused('no_permission'),
        });
        return;
      }
      this.work.view(send, req.target, req.on);
      return;
    }
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

  /** C3: a member's reply to a room post lands in its transcript, not in the room's record. The
   *  replies the tails read are added to the room list's summaries (no transcript is read) and the
   *  rooms that changed are sent, each at most once per ROOM_PUBLISH_MS. */
  private publishRoomActivity(): void {
    if (!this.groupStore) return;
    const groups = this.groupStore;
    const rebuilt = applyRoomReplies(this.roomSummaries, this.conversations.takeRoomReplies(), (room) =>
      groups.find(room),
    );
    if (rebuilt || this.roomSummaries.due().length)
      this.publish({ type: 'groupRooms', rooms: this.groupRooms() });
  }

  /** C3 + U-49: the room the newest turn of character `id` belongs to, and the text it ended with,
   *  for a turn end's push. What the messenger typed answers the room at once; the transcript is
   *  read (async, and only when push has someone to tell) for the text and for a turn it did not type. */
  private async turnOf(id: number): Promise<TurnInfo> {
    const name = this.entryOf(id)?.name;
    if (!name) return { room: null, text: null };
    const typed = this.turnLedger.current(name); // asked now: a later post must not change this turn's room
    const read = await currentTurn(this.entryOf(id)?.transcript ?? null);
    if (!this.groupStore) return { room: null, text: read.text };
    const withId = (ref: RoomRef | null): RoomRef | null =>
      ref && !ref.id ? { ...ref, id: this.groupStore?.find(ref.name)?.id } : ref;
    return {
      room: withId(typed !== undefined ? typed : read.room ? { name: read.room } : null),
      text: read.text,
    };
  }

  /** A room change has a small global list update; open clients request/read its timeline. */
  private publishGroups(roomName?: string): void {
    if (!this.groupStore) return;
    const room = roomName ? this.groupStore.find(roomName) : null;
    if (room) this.roomSummaries.invalidate(room.id); // a post or delivery changed it: read it again
    this.publish({ type: 'groupRooms', rooms: this.groupRooms() });
    if (room && this.groupMessages)
      for (const [send, viewed] of this.groupViews)
        if (viewed.has(room.id))
          send({ type: 'groupTimeline', room, posts: this.roomTimeline(room) });
  }

  /** Small room-list summaries: enough to sort, preview and count unseen room
   * activity without making the client open every room conversation. */
  private groupRooms() {
    const rooms = this.groupStore!.list();
    this.roomSummaries.retain(rooms);
    return rooms.map((room) => {
      const { updates, ...rest } = this.roomSummaries.get(room);
      return { ...room, ...rest, ...(updates.length && { updates }) };
    });
  }

  /** One room's summary, read from the transcripts (the expensive one: RoomSummaries keeps it). */
  private buildRoomSummary(room: import('./engine/groups.js').GroupRoom): RoomSummary {
    const posts = this.groupMessages ? this.roomTimeline(room) : [];
    const events = roomEvents(posts);
    const last = events.reduce<(typeof events)[number] | undefined>(
      (newest, event) => (!newest || event.at >= newest.at ? event : newest),
      undefined,
    );
    return {
      ...(last && { preview: `${last.sender ? `${last.sender}: ` : ''}${last.text}` }),
      ...(last && { lastAt: last.at }),
      updates: events.filter((event) => event.counts).map((event) => event.id),
    };
  }

  /** Read reply turns only for room viewers; a room record itself never copies a transcript. */
  private roomTimeline(room: import('./engine/groups.js').GroupRoom) {
    const lead = (member: string) => this.leads().find((l) => l.name === member);
    return this.groupMessages!.timelineWithReplies(
      room,
      (member, since) => {
        const transcript = lead(member)?.transcript;
        return transcript ? roomTranscript(transcript, since) : null; // its end, never the whole file
      },
      undefined,
      (member) => {
        const found = lead(member);
        return found ? readOptions(found, (x) => this.noticeEmployee(x)) : {};
      },
    );
  }

  private pollGroupViews(): void {
    if (!this.groupStore || !this.groupMessages || !this.groupViews.size) return;
    for (const [send, rooms] of this.groupViews)
      for (const id of rooms) {
        const room = this.groupStore.find(id);
        if (room) send({ type: 'groupTimeline', room, posts: this.roomTimeline(room) });
      }
  }

  /** Every lead the messenger lists: the engine's projects and the Claude sessions. */
  private leads(): Lead[] {
    const out: Lead[] = [];
    for (const a of this.world.agents) {
      const agentId = this.binder.idOf(a.key);
      if (agentId === null) continue;
      // D3: a Worker is listed under its project (a Lead's project is its own name).
      const project = a.key.startsWith('engine:') ? this.engine?.projectOf(a.name) : null;
      out.push({
        agentId,
        key: a.key,
        name: a.name,
        ...(project && project !== a.name && { project }),
        transcript: a.transcript,
        dir: a.dir,
        canSend: this.canSend(a.key, a.name),
        ...(this.messenger &&
          a.key.startsWith('engine:') && {
            queued: this.messenger.queuedFor(a.name),
            held: this.messenger.held(a.name),
          }),
        ...(this.permissions.has(agentId) && {
          permission: this.permissionCard(this.permissions.get(agentId)!),
        }),
      });
    }
    return out;
  }

  /** chatSend reaches an engine project (the engine messenger). */
  private canSend(key: string, name: string): boolean {
    if (!this.opts.chat || !key.startsWith('engine:')) return false;
    return !!this.messenger && !!this.engine?.names().includes(name);
  }

  /** The daemon owns the allow-list; raw commands exist only for engine leads. */
  private sendSlashCommands(
    agentId: number,
    requestId: string,
    send: WsSend,
    privileged: boolean,
  ): void {
    const reply = (commands: SlashCommand[], why?: Refused): SlashCommandsList => ({
      type: 'slashCommandsList',
      requestId,
      agentId,
      commands,
      ...why,
    });
    const entry = this.entryOf(agentId);
    if (!this.opts.chat) return void send({ ...reply([], refused('chat_off')) });
    if (!privileged) return void send({ ...reply([], refused('no_permission')) });
    if (!entry?.key.startsWith('engine:') || !this.engine?.names().includes(entry.name)) {
      return void send({ ...reply([], refused('not_engine_project')) });
    }
    send({ ...reply(this.slash.list(entry.dir)) });
    this.unwatchSlash(send, agentId);
    const stop = this.slash.watch(entry.dir, (commands) => send({ ...reply(commands) }));
    let views = this.slashViews.get(send);
    if (!views) {
      views = new Map();
      this.slashViews.set(send, views);
    }
    views.set(agentId, stop);
  }

  private unwatchSlash(send: WsSend, agentId?: number): void {
    const views = this.slashViews.get(send);
    if (!views) return;
    if (agentId !== undefined) {
      views.get(agentId)?.();
      views.delete(agentId);
    } else {
      for (const stop of views.values()) stop();
      views.clear();
    }
    if (!views.size) this.slashViews.delete(send);
  }

  /** A reader for a temp's work view, or why there is none. */
  private workReader(t: WorkTarget): WorkReader | Refused {
    const none = refused('work_record_missing');
    const store = this.opts.store;
    if (t.kind === 'subagent') {
      const lead =
        store.get(t.agentId!)?.jsonlFile ||
        this.leads().find((l) => l.agentId === t.agentId)?.transcript;
      return lead ? subagentReader(lead, t.id!) : none;
    }
    const id = t.agentId!;
    if (!store.get(id)?.jsonlFile) return none;
    const root = path.join(this.opts.home ?? os.homedir(), '.claude/projects');
    return fileReader(() => store.get(id)?.jsonlFile ?? null, root);
  }

  /**
   * A messenger message to an engine project, through the engine messenger
   * (typed in when idle, else queued; header `[사장 · 메신저 · time]`). A
   * catalogue-listed `/` command from the privileged boss goes through the
   * engine without that header. `now` and chatSendNow (지금 보내기 on a waiting
   * one): the engine messenger may type it in while the session works. Never rejects.
   */
  private async chatSend(
    req: ChatSend | ChatSendNow,
    privileged: boolean,
    device: string,
  ): Promise<ChatSendResult> {
    const engine = !!this.messenger && !!this.engine?.names().includes(req.name);
    const reply = (o: Omit<ChatSendResult, 'type' | 'requestId' | 'name'>): ChatSendResult => ({
      type: 'chatSendResult',
      requestId: req.requestId,
      name: req.name,
      ...o,
    });
    const folder = this.engine?.folderOf(req.name); // a Worker's own (its slash commands)
    const rawRefusal =
      req.type === 'chatSend' && req.text.startsWith('/') && folder
        ? slashRefusal(this.slash.list(folder), req.text)
        : null;
    const refusal = !this.opts.chat
      ? refused('chat_off')
      : !privileged
        ? refused('no_permission')
        : !engine || !this.messenger
          ? refused('not_engine_project')
          : req.type === 'chatSend'
            ? (sendTextRefusal(req.text) ?? rawRefusal)
            : null;
    const what = `${req.type === 'chatSend' ? 'send' : 'send now'} ${JSON.stringify(req.name).slice(0, 66)} gui:${device}`;
    if (refusal || !this.messenger) {
      console.log(`[cld engine] ${what}: refused (${refusal?.error})`);
      return reply({ ok: false, ...(refusal ?? { error: '' }) });
    }
    // The boss's words wait for the session as long as it lives: never into the
    // inbox (read only at the next start) because it stayed busy for 10 minutes.
    const r =
      req.type === 'chatSendNow'
        ? this.messenger.promote(req.name, req.id)
        : await this.messenger.send({
            to: req.name,
            text: req.text,
            ifIdle: false,
            from: null,
            source: `messenger:${device}`,
            ...(req.now && { now: true }),
            ...(req.replyTo && { replyTo: req.replyTo }),
            ...(req.text.startsWith('/') ? { raw: true } : {}),
          });
    console.log(`[cld engine] ${what}: ${r.ok ? r.delivered : `failed (${r.code})`}`);
    return r.ok
      ? reply({
          ok: true,
          delivered: r.delivered,
          ...(r.id && { queueId: r.id }),
          ...(r.messageId && { messageId: r.messageId }),
        })
      : reply({ ok: false, ...pickRefusal(r) });
  }

  /** Change or remove a boss message that has not reached the Typist yet. */
  private async chatPending(
    req: ChatCancel | ChatEdit,
    privileged: boolean,
    device: string,
  ): Promise<ChatPendingResult> {
    const engine = !!this.messenger && !!this.engine?.names().includes(req.name);
    const reply = (o: Omit<ChatPendingResult, 'type' | 'requestId' | 'name' | 'id'>) => ({
      type: 'chatPendingResult' as const,
      requestId: req.requestId,
      name: req.name,
      id: req.id,
      ...o,
    });
    const refusal = !this.opts.chat
      ? refused('chat_off')
      : !privileged
        ? refused('no_permission')
        : !engine || !this.messenger
          ? refused('not_engine_project')
          : req.type === 'chatEdit'
            ? sendTextRefusal(req.text)
            : null;
    if (refusal || !this.messenger) return reply({ ok: false, ...(refusal ?? { error: '' }) });
    const r =
      req.type === 'chatCancel'
        ? this.messenger.cancel(req.name, req.id)
        : this.messenger.edit(req.name, req.id, req.text);
    console.log(
      `[cld engine] ${req.type === 'chatCancel' ? 'cancel' : 'edit'} ${JSON.stringify(req.name).slice(0, 66)} gui:${device}: ${r.ok ? 'ok' : `failed (${r.code})`}`,
    );
    // The queue is part of every open conversation's snapshot. Poll now so
    // another screen sees the edited/cancelled bubble without waiting 1.5 s.
    if (r.ok) {
      this.conversations.poll();
      this.publish<OfficeSnapshot>(this.officeState()); // a saved or cancelled edit ends its hold
    }
    return r.ok
      ? reply({ ok: true })
      : reply({ ok: false, ...pickRefusal(r), ...((r.code === 'not_queued' || r.code === 'typing') && { gone: true }) });
  }

  /** MSG-HOLD2: the office row's mark for edits left held (a forgotten edit cannot hide). */
  private heldEdits(name: string): { heldEdits?: number } {
    const n = this.messenger?.queuedFor(name).filter((q) => q.held).length ?? 0;
    return n ? { heldEdits: n } : {};
  }

  /** Keep a browser's queued message in place while that browser edits it. */
  private chatHold(req: ChatHold, privileged: boolean): void {
    const engine = !!this.messenger && !!this.engine?.names().includes(req.name);
    if (!this.opts.chat || !privileged || !engine || !this.messenger) return;
    // Every open messenger shows the held state (MSG-HOLD2: a reloaded page finds it with its choices).
    if (this.messenger.hold(req.name, req.id, req.on)) {
      this.conversations.poll();
      this.publish<OfficeSnapshot>(this.officeState()); // the row's heldEdits
    }
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
 * Pick the providers and start the office, or return null (plain pixel-agents)
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
  const claudePath = findOnPath('claude');
  if (!claudePath) {
    console.log('[cld] claude not found: plain pixel-agents office');
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
