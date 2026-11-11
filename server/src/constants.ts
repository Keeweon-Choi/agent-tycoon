import { CHAR_COUNT } from '../../core/src/assets/constants.js';

// ── JSONL File Watching ─────────────────────────────────────
export const FILE_WATCHER_POLL_INTERVAL_MS = 500;
export const PROJECT_SCAN_INTERVAL_MS = 1000;

// ── agty sources ─────────────────────────────────────────
/** Usage refresh cadence while an office viewer is present. */
export const USAGE_REFRESH_MS = 120_000;
/** `agty status` uses the status line's saved report (no viewer, so no reading in memory) while it is younger than this. */
export const CLAUDE_USAGE_STALE_MS = 6 * 3_600_000;
/** The status line's report is two small windows; anything bigger at that path is not one. */
export const CLAUDE_USAGE_REPORT_MAX_BYTES = 64 * 1024;
/** Claude Code's `/usage` (the per-model weeks the status line lacks): at most this often while someone views. */
export const USAGE_PROBE_MIN_GAP_MS = 5 * 60_000;
/** One `/usage` run gives up after this (it calls no model, so it answers in seconds; it holds stdin for 4 s of it). */
export const USAGE_PROBE_TIMEOUT_MS = 15_000;
/** The `/usage` child's stdin stays open this long: its background limits fetch needs a few seconds after start (the CLI's own stdin wait is 3 s). */
export const USAGE_PROBE_STDIN_HOLD_MS = 4_000;
/** spawnJson: a child that ignored the timeout's SIGTERM is killed (SIGKILL) this long after it, so it cannot block the process-wide queue. */
export const SPAWN_JSON_KILL_GRACE_MS = 3_000;
/** An on-demand Codex turn only refreshes its locally-written rate-limit log. */
export const CODEX_USAGE_PROBE_TIMEOUT_MS = 60_000;
/** Let an on-demand probe close gracefully before the daemon escalates its timeout. */
export const CODEX_USAGE_PROBE_KILL_GRACE_MS = 3_000;
/** Avoid spending even the tiny on-demand turn more than once per ten minutes. */
export const CODEX_USAGE_PROBE_COOLDOWN_MS = 10 * 60_000;
/** The terminal host's host.log moves to host.log.1 past this size (owner-approved 11-01). */
export const HOST_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Old host logs kept (host.log.1 .. .3), so at most about 20 MB. */
export const HOST_LOG_KEEP = 3;
/** A group room log is one file per month; a month older than this many months is gzipped (never deleted). */
export const GROUP_LOG_GZIP_AFTER_MONTHS = 6;
/** Disk-card snapshots stay useful while avoiding repeat walks when the hardware page reopens. */
export const DISK_USAGE_CACHE_MS = 10 * 60_000;
/** A slow or mounted directory cannot hold a hardware-page disk measurement indefinitely. */
export const DISK_USAGE_TIMEOUT_MS = 120_000;
/** Simultaneous metadata reads while walking the disk-card folders. */
export const DISK_USAGE_WALK_CONCURRENCY = 16;
/** A near-due reset can be ordinary rollover under a skewed host clock. */
export const USAGE_EARLY_RESET_MIN_FUTURE_MS = 5 * 60_000;
/** A new deadline must move by more than clock jitter before it is noteworthy. Fixed, not a share of the
 *  window: the new deadline is about now + one window, so a share would hide resets that came early with
 *  most of the window still left (10-24: a weekly reset days early). */
export const USAGE_EARLY_RESET_MIN_NEXT_SHIFT_MS = {
  fiveHour: 30 * 60_000,
  sevenDay: 12 * 60 * 60_000,
} as const;

// ── Heuristic Agent Status Detection ────────────────────────
// These timers are the fallback when CLI hooks are not active
// (hookDelivered = false). When hooks are working, these are
// suppressed and the server receives instant events instead.
/** Delay before sending agentToolDone (prevents UI flicker on rapid tool transitions) */
export const TOOL_DONE_DELAY_MS = 300;
/** Heuristic: time after a non-exempt tool starts before showing permission bubble.
 *  Not used for teammates -- false positives on slow tools (WebFetch/WebSearch).
 *  Teammates rely on the lead's routed Notification(permission_prompt) hook. */
export const PERMISSION_TIMER_DELAY_MS = 7000;
/** PERM-PROMPT: an engine session's tool call open this long (hooks mode too) makes the
 *  permission-wait tracker ask `claude agents --json` once whether a dialog holds it. */
export const PERMISSION_WAIT_SUSPECT_MS = 8_000;
/** PERM-PROMPT: at most one `claude agents --json` per this long; and the re-check pace
 *  while a permission wait is confirmed (none at all once nothing waits or is suspected). */
export const PERMISSION_WAIT_CHECK_MS = 15_000;
/** Heuristic: silence duration before marking a text-only turn as complete */
export const TEXT_IDLE_DELAY_MS = 5000;

// ── External Session Detection ──────────────────────────────
export const EXTERNAL_SCAN_INTERVAL_MS = 3000;
/** Only adopt JSONL files modified within this window */
export const EXTERNAL_ACTIVE_THRESHOLD_MS = 120_000; // 2 minutes
/** Remove external agents after this much inactivity */
// export const EXTERNAL_STALE_TIMEOUT_MS = 300_000; // 5 minutes - deprecated
export const EXTERNAL_STALE_CHECK_INTERVAL_MS = 30_000;
/** Cooldown after user closes an agent via X. Must be > EXTERNAL_ACTIVE_THRESHOLD_MS
 *  so the file's mtime becomes stale before the dismissal expires. */
export const DISMISSED_COOLDOWN_MS = 180_000; // 3 minutes

// ── Context Window Usage ────────────────────────────────────
/** Window size assumed until a transcript proves otherwise. Transcripts never
 *  state the model's context limit, so this is the floor, not the truth. */
export const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
/** Known window sizes, ascending. The smallest tier that fits the largest
 *  context observed so far wins; beyond the last tier we round up to a whole
 *  multiple of it, so an unknown future window still reads under 100%. */
export const CONTEXT_WINDOW_TIERS = [200_000, 1_000_000] as const;
/** The newest compactions kept (and sent) per agent. Older ones are only in the count. */
export const COMPACTION_LOG_KEPT = 5;
/** How much of a transcript's tail to read when seeding an agent's context on
 *  adoption or restore. Comfortably more than one turn's worth of records. */
export const CONTEXT_SEED_TAIL_BYTES = 256 * 1024;
/** A background spawn this process never saw launch (restart, adoption, a
 *  SendMessage resume) counts as running when its transcript was written this
 *  recently... */
export const BACKGROUND_RECOVERY_FRESH_MS = 5 * 60_000;
/** ...or when it has a tool call with no result yet and was written within
 *  this long (a dead run's open call must not keep it alive forever). */
export const BACKGROUND_RECOVERY_OPEN_TOOL_MAX_MS = 30 * 60_000;

/** `permissionMode` a transcript's `permission-mode` record carries when the session
 *  skips permission prompts (--dangerously-skip-permissions). */
export const PERMISSION_MODE_BYPASS = 'bypassPermissions';
/** ACP-1: an ACP agent's transcript (acp/transcript.ts): it asks every permission through ACP, so a
 *  quiet tool call is never a permission wait either. */
export const PERMISSION_MODE_ASKS_EXACTLY = 'acp';
/** Modes under which the office never guesses a permission wait. */
export const PERMISSION_MODES_NO_GUESS: ReadonlySet<string> = new Set([PERMISSION_MODE_BYPASS, PERMISSION_MODE_ASKS_EXACTLY]);

/** Renew before Claude Code's own compaction point (core/src/constants.ts). */
export { RENEW_FILL_PCT } from '../../core/src/constants.js';

// ── Global Session Scanning ─────────────────────────────────
/** Only adopt global JSONL files larger than this (filters out empty/init-only sessions) */
export const GLOBAL_SCAN_ACTIVE_MIN_SIZE = 3_072; // 3KB
/** Only adopt global JSONL files modified within this window */
export const GLOBAL_SCAN_ACTIVE_MAX_AGE_MS = 600_000; // 10 minutes

// ── Directory Suggestions ───────────────────────────────────
/** How much of a session transcript is read to recover the working directory it
 *  records. The cwd sits on the first records, so the head is enough — whole
 *  transcripts run to megabytes and there is one per session on the machine. */
export const DIRECTORY_SUGGESTION_HEAD_BYTES = 8_192;
/** Transcripts tried per session directory before moving on. Every session in
 *  one directory shares a cwd (the directory name encodes it), so the extra
 *  attempts only cover empty or half-written files. */
export const DIRECTORY_SUGGESTION_FILES_PER_SESSION_DIR = 5;
/** Upper bound on suggestions returned, so a long agent history can't flood the
 *  Directory modal on a phone. The newest survive the cut — the list is ordered
 *  by when a session last ran there. */
export const DIRECTORY_SUGGESTION_LIMIT = 10;

// ── Display Truncation + Agent Tycoon Server paths ──────────
// Centralized in core/src/constants.ts; re-exported here for back-compat.
export {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  HOOK_API_PREFIX,
  SERVER_JSON_NAME,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from '../../core/src/constants.js';

// ── Multi-Server Discovery ──────────────────────────────────
/** Subdirectory (of the office folder, server/src/officeFolder.ts) holding one registry entry per live
 *  server, so a hook event can fan out to every running instance instead of
 *  only the single legacy server.json pointer. See server/src/server.ts. */
export const SERVERS_DIR = 'servers';
/** Subdirectory of the office folder holding the installed hook script. */
export const HOOK_SCRIPTS_SUBDIR = 'hooks';
/** Valid explicit TCP port range. Port 0 remains an internal-only signal for
 *  OS-assigned ephemeral binding and is never accepted from persisted records
 *  or the CLI's --port option. */
export const MIN_PORT = 1;
export const MAX_PORT = 65_535;
/** Format version stamped on every registry entry (both the per-server records
 *  and the legacy server.json). Bump on breaking field changes; additive
 *  fields (servesSpa, protocol itself) don't require a bump -- readers already
 *  tolerate unknown/missing fields (see ServerConfig.debugLog precedent). */
export const SERVER_REGISTRY_PROTOCOL_VERSION = 1;

/** Public `/api/health` response format. Bump for breaking health-client changes. */
export const SERVER_HEALTH_PROTOCOL_VERSION = 1;

// ── WebSocket close codes (application range 4000-4999) ────
/** The handshake's token is missing or wrong: the embedded `/ws` Bearer header,
 *  or the `?token=` query on `/terminal/:agentId` (an untokened standalone `/ws`
 *  still connects, unprivileged -- see wsAuth.ts). */
export const WS_CLOSE_UNAUTHORIZED = 4001;

/** Standalone mode: the handshake's Origin is not this server's own origin.
 *  WebSocket connects bypass CORS, so this is the only thing standing between
 *  a drive-by web page and the privileged client-message channel. */
export const WS_CLOSE_FORBIDDEN_ORIGIN = 4003;
/** Terminal socket: the agent has no PTY on this server (never spawned, or
 *  already exited). The route only ever attaches; it cannot start one. */
export const WS_CLOSE_NO_SESSION = 4004;
/** A terminal stream ended while its terminal lives (the PTY host connection went): not 4xxx, so the pane reconnects. */
export const WS_CLOSE_STREAM_ENDED = 1011;

export const HOOK_EVENT_BUFFER_MS = 5_000;
/** Grace period after SessionEnd(reason=clear/resume) before triggering onSessionEnd.
 *  /clear and /resume fire SessionEnd then SessionStart within ms. This timeout is a
 *  safety net: if SessionStart never arrives (e.g. the CLI crashes mid-transition),
 *  the agent is cleaned up instead of staying as a zombie with pendingClear forever. */
export const SESSION_END_GRACE_MS = 2000;
export const MAX_HOOK_BODY_SIZE = 65_536; // 64KB

// ── Standalone Embedded Terminal ────────────────────────────
/** PTY module ids tried in order by the loader. @lydell/node-pty ships prebuilt
 *  binaries for all six platform/arch targets as optionalDependencies with no
 *  install scripts; official node-pty has no Linux prebuild and relies on
 *  install scripts that npm >=11.16 gates by default. Keeping a candidate LIST
 *  means anyone who prefers the Microsoft package can just install it.
 *  See docs/design/standalone-terminal.md. */
export const PTY_MODULE_CANDIDATES = ['@lydell/node-pty', 'node-pty'] as const;
/** Loopback hostnames. Used to warn when the server binds off-loopback, and
 *  always part of the privileged-Host allowlist (wsAuth.privilegedHostnames). */
export const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '::1'] as const;
/** Wildcard bind addresses: listen targets, never a name a browser sends as
 *  Host, so binding to one adds nothing to the privileged-Host allowlist. */
export const WILDCARD_HOSTNAMES = ['0.0.0.0', '::'] as const;

/** Scrollback lines the per-session headless-xterm mirror retains. Matches the
 *  browser's TERMINAL_SCROLLBACK_LINES so a reattach replays the same depth the
 *  client would have kept. Bounds the serialized replay snapshot. */
export const TERMINAL_MIRROR_SCROLLBACK_LINES = 5_000;
/** Terminal size used until the browser reports its real geometry. */
export const TERMINAL_DEFAULT_COLS = 80;
export const TERMINAL_DEFAULT_ROWS = 24;
/** TERM value exported into the PTY. */
export const TERMINAL_TERM_NAME = 'xterm-256color';
/** Grace period between SIGHUP and SIGKILL when disposing a PTY. */
export const TERMINAL_KILL_GRACE_MS = 2_000;
/** How long shutdown waits past the SIGKILL escalation for the exits to land. */
export const TERMINAL_SHUTDOWN_SLACK_MS = 1_000;
/** unavailableReason() when the operator opted out with --no-terminal. Shown
 *  verbatim as the disabled + Agent button's tooltip in the browser. */
export const TERMINAL_DISABLED_BY_FLAG_REASON = 'Terminal disabled with --no-terminal.';
/** terminalAvailability reason for an UNPRIVILEGED /ws client (no valid token,
 *  or a Host outside the allowlist): the PTY may work, but this connection may
 *  not open one. Launching an agent starts a shell as the operator, so it is
 *  gated exactly like the hooks toggle (wsAuth.standaloneHandshakeVerdict). */
export const TERMINAL_REQUIRES_TOKEN_REASON =
  'Open the URL the CLI printed (with its ?token=), at localhost or a name passed with --allowed-host, to launch agents from this browser.';
/** directoryRejected reason when the shared config write behind a Directory
 *  save or delete failed. The detail (permissions, disk full, ...) is on the
 *  host's console, where writeConfig logged it. */
export const DIRECTORY_WRITE_FAILED_REASON =
  "Couldn't save the change: writing the office config.json failed (see the host's log).";
/** Standalone persists its server token here (mode 0600, beside server.json) so
 *  the tokened URL a browser bookmarked keeps working across restarts. The
 *  embedded (VS Code) server still mints a fresh token per process. */
export const STANDALONE_TOKEN_FILE_NAME = 'standalone-token';

// ── Layout/Config Persistence ──────────────────────────────
export const LAYOUT_FILE_NAME = 'layout.json';
export const LAYOUT_FILE_POLL_INTERVAL_MS = 2000;
export const LAYOUT_REVISION_KEY = 'layoutRevision';
export const CONFIG_FILE_NAME = 'config.json';
export const STANDALONE_STATE_FILE_NAME = 'standalone-state.json';

// ── Avatar Customization ────────────────────────────────────
/** Number of bundled character palettes (`char_N.png`): core's `CHAR_COUNT`. */
export const PALETTE_COUNT = CHAR_COUNT;
/** Inclusive upper bound for a valid agent hue shift, in degrees. Used by
 *  clientMessageHandler to guard saveAgentSeats payloads from a remote or
 *  hand-edited source corrupting the stored values with out-of-range values. */
export const HUE_SHIFT_MAX_DEG = 360;

/** Maximum transcript bytes read by one messenger search. */
export const CHAT_SEARCH_MAX_BYTES = 64 * 1024 * 1024;
/** Maximum search matches returned to one client. */
export const CHAT_SEARCH_MAX_HITS = 50;
/** The messenger-wide search (searchAll.ts), bounded so a big history never stalls a PC that also does heavy work:
 *  at most this many results in all, and per conversation, */
export const ALL_SEARCH_MAX_HITS = 60;
export const ALL_SEARCH_HITS_PER_CONVERSATION = 4;
/** the newest this many transcript bytes per conversation (the earlier sessions of a conversation share them), */
export const ALL_SEARCH_BYTES_PER_CONVERSATION = 4 * 1024 * 1024;
/** and this long in all, then the answer goes out with what was found. */
export const ALL_SEARCH_MAX_MS = 3000;
/** A message's text around a match that is masked before its snippet is cut (characters each way). */
export const CHAT_SEARCH_MASK_WINDOW = 8000;
/** The longest a room-post search reads (months of a room's log, newest first). */
export const ALL_SEARCH_ROOM_SEGMENTS = 3;
/** Files one library page returns (ends on a message boundary, so a message with several may pass it). */
export const CHAT_LIBRARY_PAGE = 30;

/** agty (S6): a confirmed connector change closes the connection it came through this long after answering, so the page gets the result and can move. */
export const CUT_GRACE_MS = 5000;
/** agty: the daemon's shutdown gives up and exits after this long (a hung step held deploys until systemd's SIGKILL). */
export const SHUTDOWN_DEADLINE_MS = 10_000;

/** Tool descriptions remembered per agent for re-sends; a running tool is always among the newest. */
export const TOOL_DESC_KEEP = 64;

/** AGENT-CLI: a plain office (no Claude Code at start) looks again when a viewer connects, at most this often. */
export const AGENT_CLI_RECHECK_MIN_GAP_MS = 5_000;
/** AGENT-CLI: Windows logon environment registry reads are shared by shells opened together. */
export const WINDOWS_LOGON_ENV_CACHE_MS = 5_000;
/** AGENT-CLI: maximum time spent proving a discovered Claude Code candidate works. */
export const AGENT_CLI_VERSION_TIMEOUT_MS = 10_000;
/** AGENT-UPDATE: an agent CLI's own self-update (`claude update`, `codex update`) gets this long before it is stopped. */
export const AGENT_CLI_UPDATE_TIMEOUT_MS = 5 * 60_000;
/** AGENT-UPDATE: after the timeout's SIGTERM, how long before the CLI is killed and its pipes are closed. */
export const AGENT_CLI_UPDATE_KILL_GRACE_MS = 5_000;
/** AGENT-UPDATE: what the update run may print before it is cut off (bytes), and how many of its last lines the owner sees. */
export const AGENT_CLI_UPDATE_MAX_BYTES = 4 * 1024 * 1024;
export const AGENT_CLI_UPDATE_LINES = 12;
/** AGENT-LATEST: the newest published version of an agent CLI (display only), read from the npm registry over HTTPS. */
export const AGENT_LATEST_REGISTRY = 'https://registry.npmjs.org/';
export const AGENT_LATEST_PACKAGES = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' } as const;
/** AGENT-LATEST: a lookup gives up after this long, reads at most this many bytes, and a CLI is asked again after the TTL (a forced one after the gap). */
export const AGENT_LATEST_TIMEOUT_MS = 5_000;
export const AGENT_LATEST_MAX_BYTES = 256 * 1024;
export const AGENT_LATEST_TTL_MS = 60 * 60_000;
export const AGENT_LATEST_MIN_GAP_MS = 30_000;
/** AGENT-CLI: after ordering the restart, the plain daemon waits this long to be replaced before it says the restart failed. */
export const AGENT_CLI_RESTART_WAIT_MS = 30_000;
/** AGENT-CLI: the service manager command that restarts the daemon gives up after this long. */
export const AGENT_CLI_RESTART_COMMAND_TIMEOUT_MS = 30_000;
/** AGENT-CLI: exit code of a daemon that ends itself for a restart (EX_TEMPFAIL); the exit code itself restarts nothing, a helper or a test runner does. */
export const AGENT_CLI_RESTART_EXIT_CODE = 75;

// ── agty TERM-P1 (ADR-0018): our own PTY host for agent sessions ──
/** Scrollback of each agent terminal's mirror in the host (~3 MB at 200 columns). */
export const PTYHOST_SCROLLBACK_LINES = 1_000;
/** The host ends itself after this long with no terminal and no request. */
export const PTYHOST_IDLE_EXIT_MS = 60_000;
/** How long the daemon waits for a host it launched to listen. */
export const PTYHOST_CONNECT_MS = 5_000;
/** A host request without an answer in this long fails (the socket is local). */
export const PTYHOST_REQUEST_MS = 10_000;
/** A client that lets this much output pile up unread is dropped (a stuck viewer must not grow the host). */
export const PTYHOST_CLIENT_BACKLOG_BYTES = 16 * 1024 * 1024;
/**
 * Enter goes in this long after a bracketed paste, plus the paste's ingest time below. Orca's settle
 * for a prompt with no settlement signal (AGENT_PROMPT_SUBMIT_SETTLE_MS: bytes arriving do not prove
 * Claude attached the paste); its 50 ms is only for a freshly launched composer it then re-checks.
 */
export const PTY_PASTE_ENTER_MS = 500;
/** Bytes per ms Windows ConPTY takes a paste in at (Orca, Win11 bundled ConPTY, 1.5x margin); a long paste waits longer before Enter. */
export const PTY_PASTE_BYTES_PER_MS_WINDOWS = 64;
/** The same on macOS and Linux (Orca measured macOS: 320 KB in ~26 ms; 3x margin). */
export const PTY_PASTE_BYTES_PER_MS = 4_096;
/** TERM-P2: how long the host waits for a fresh Windows ConPTY to ask DA1/CPR (it reads input) before it hands the terminal out unchecked (Orca's limit). */
export const PTYHOST_CONPTY_INPUT_MS = 5_000;
/** A spawn's answer may wait for that check twice and for the first terminal's exit between (conpty.ts). */
export const PTYHOST_SPAWN_MS = PTYHOST_REQUEST_MS + 3 * PTYHOST_CONPTY_INPUT_MS;
/** After Enter, how long the turn may take to show it started (OSC working, session busy, transcript). */
export const PTY_SUBMIT_MS = 5_000;
/** TYPIST-STALE (11-04 laptop): Enter is pressed again this long after one that left our paste in the
 *  box (no prompt, no turn: a composer not ready yet, an Enter a slow paste swallowed)... */
export const PTY_SUBMIT_RETRY_MS = 1_500;
/** ...at most this many times per delivery; after that the delivery is `unsubmitted`. */
export const PTY_SUBMIT_RETRIES = 2;
/** An idle agent terminal no one watches is closed after this long and resumed by its next message. */
export const AGENT_IDLE_STOP_MS = 60 * 60_000;
/** TERM-P3: a Claude agent moved into our PTY host must be found idle on its own conversation within this. */
export const PTY_MOVE_IDLE_MS = 60_000;
/** TERM-P3 move-all: how often a busy agent is looked at again, and how long it may stay busy before it is skipped. */
export const PTY_MOVE_ALL_POLL_MS = 10_000;
export const PTY_MOVE_ALL_WAIT_MS = 30 * 60_000;
/**
 * TERM-P3: how long a PTY agent's PermissionRequest hook waits for the owner's 허용/거부. With no
 * answer by then the hook gives no decision and Claude shows its own dialog in the agent's terminal.
 */
export const PTY_PERMISSION_WAIT_MS = 4 * 60_000;
/** FIX-PERM-RESTART: a hook asking again right after our start may beat the engine finding its
 *  agent: for this long after the start its ask waits for the agent (looking this often). */
export const PTY_PERMISSION_READY_MS = 30_000;
export const PTY_PERMISSION_READY_POLL_MS = 500;
/** Claude Code's own limit on that hook (seconds): above our wait, so our "no decision" comes first. */
export const PTY_PERMISSION_HOOK_S = 270;
/** TERM-P3: a move's rollback waits this long for the agent's host terminals to close (SIGKILL after TERMINAL_KILL_GRACE_MS). */
export const PTY_CLOSE_WAIT_MS = 10_000;
/** A control-socket request that may wait this long (that hook, a move): longer than both. */
export const CONTROL_LONG_MS = 5 * 60_000;

// ── P4 dev room (agent-tycoon/devroom.ts) ──
/** The dev room footer's stats (daemon and PTY host memory, terminals) while anyone has it open. */
export const DEVROOM_STATS_MS = 10_000;
/** A review's changed-file list is reused this long by its per-file diffs (RepoManager.changesOf). */
export const DEVROOM_CHANGES_KEEP_MS = 10_000;
/** 프로젝트 추가's `git clone` (projectRepo.ts): a big repository over a slow line, then it stops. */
export const PROJECT_CLONE_TIMEOUT_MS = 10 * 60_000;
/** CLONE-PROGRESS: at most one progress report to the dialog this often (a new phase at once). */
export const PROJECT_CLONE_PROGRESS_MS = 250;

// ── WAITING-PERSIST (server/src/question.ts) ──
/** On restart, a transcript grown more than this past an open question counts as answered (not read). */
export const QUESTION_RECONCILE_MAX_BYTES = 1024 * 1024;
/** The saved open questions (office folder), and at most this many of them. */
export const QUESTIONS_FILE_NAME = 'questions.json';
export const QUESTIONS_MAX = 100;
// ── Project files: tickets ──────────────────────────────────
/** DESKTOP-ACTIONS: an 'open' ticket (handed to the default browser) dies this long after its mint,
 *  however often a PDF or video viewer reads it: enough to read or watch, never a lasting link. */
export const EXTERNAL_TICKET_MAX_MS = 30 * 60_000;

// ── SPT-P1A spec tracking (server/src/agent-tycoon/spec/) ──
/** Finding documents walks the project folder's working tree this far, then stops (what it found stands). */
export const SPEC_WALK_DIRS_MAX = 2_000;
export const SPEC_WALK_FILES_MAX = 5_000;
export const SPEC_WALK_DEPTH_MAX = 6;
/** A document bigger than this is not offered, and a tracked one that grows past it is not read. */
export const SPEC_FILE_MAX_BYTES = 2 * 1024 * 1024;
/** SPT §2.3: the bytes read from a document's top for its front-matter kind (the 켜기 window, enable). */
export const SPEC_FM_HEAD_BYTES = 4 * 1024;
/** Folders the walk never enters, on top of tracking's SKIP_DIRS: virtual environments and datasets. */
export const SPEC_SKIP_DIRS: readonly string[] = ['.venv', 'venv', '__pycache__', 'site-packages', 'dataset', 'datasets'];
/** A file changed this recently is being written: the next scan reads it. */
export const SPEC_SETTLE_MS = 5_000;
/** A project is scanned at most this often, however often its routes are read. */
export const SPEC_SCAN_MIN_MS = 10_000;
/** The 개요's recent commits, read once per HEAD. */
export const SPEC_RECENT_COMMITS = 20;
/** A commit subject sent to the screen: masked, then cut here. */
export const SPEC_TITLE_MAX = 120;
/** git output for one status or file list (a huge untracked tree is cut there). */
export const SPEC_GIT_MAX_BYTES = 1024 * 1024;
/** A document record keeps this many past paths and decisions. */
export const SPEC_PATH_HISTORY_MAX = 20;
export const SPEC_DECISIONS_MAX = 10;
/** Documents one enable may name. */
export const SPEC_ENABLE_DOCS_MAX = 300;
/** A document path the 켜기 window may send. */
export const SPEC_PATH_MAX = 400;
// ── SPT-P1B items ──
/** ID-less headings become items down to this level when a document's mode is headings (SPT §7.1), and at most this deep. */
export const SPEC_HEADING_DEPTH = 2;
export const SPEC_HEADING_DEPTH_MAX = 6;
/** An item's title or section sent to the screen: masked, then cut here. */
export const SPEC_ITEM_TITLE_MAX = 200;
/** The 요구사항 list: rows per page by default, and at most. */
export const SPEC_ITEMS_PAGE = 200;
export const SPEC_ITEMS_PAGE_MAX = 500;

// RQ4: the optional official Spec Kit install (server/src/agent-tycoon/spec/workflow.ts).
/** The Spec Kit release `uvx --from` runs, as shown (a new one is read, files and options, before it goes here). */
export const SPEC_KIT_VERSION = 'v1.3.1';
/** …pinned by its commit (v1.3.1's annotated tag points here; a tag can move, the release is not immutable).
 *  ponytail: Spec Kit's own Python dependencies still float (it ships no lock file); uv resolves them at
 *  run time. A `--with` pin list or a vendored wheel if that ever matters. */
export const SPEC_KIT_COMMIT = '51f03cfccfe20e6744aefbb76c50521fdf306673';
export const SPEC_KIT_SOURCE = 'git+https://github.com/github/spec-kit.git';
/** The core commands a v1.3.1 integration writes one skill each for (templates/commands/*.md). */
export const SPEC_KIT_COMMANDS: readonly string[] = ['analyze', 'checklist', 'clarify', 'constitution', 'converge', 'implement', 'plan', 'specify', 'tasks'];
/** One `uvx … specify` run: the first downloads Spec Kit and maybe a Python. */
export const SPEC_KIT_RUN_TIMEOUT_MS = 5 * 60_000;
export const SPEC_KIT_OUTPUT_MAX_BYTES = 256 * 1024;
/** A shown plan can be consented to this long, once, by the session it was shown to. */
export const SPEC_KIT_CONSENT_TTL_MS = 10 * 60_000;
/** The report's list of created files stops here (the count is whole). */
export const SPEC_KIT_REPORT_FILES_MAX = 200;
/** The before/after listing of Spec Kit's folders stops here. */
export const SPEC_KIT_WALK_MAX = 5_000;

/** The 요구사항 search text, at most. */
export const SPEC_QUERY_MAX = 100;
// ── SPT-P1C identity ladder, match cache, questions ──
/**
 * R2's ladder (agent-tycoon/docs/research/spec-tracking-identity-2026-11-03.md §3), every number by name.
 * accept/low/margin: T3 takes a pair at `accept` with `margin` over the next one, asks from `low`;
 * crossDocBody: a pair across documents needs this much body overlap (else capped under accept);
 * retiredPenalty: coming back from retirement needs a bit more.
 */
export const SPEC_LADDER = {
  accept: 0.6,
  low: 0.45,
  margin: 0.1,
  crossDocBody: 0.5,
  retiredPenalty: 0.05,
  /** T3 skips a pair this far under `low` before the bonuses. */
  prefilter: 0.2,
  /** T3: title weight, same-document bonus, neighbour bonus (each side counts half). */
  titleWeight: 0.6,
  sameDocBonus: 0.05,
  neighbourBonus: 0.1,
  /** Shingles in more than max(stopMin, stopShare × items) items are template text, left out of T2/T3. */
  stopMin: 3,
  stopShare: 0.1,
  /** Containment of the smaller side (damped), only from this many shingles and up to this size ratio. */
  containMin: 20,
  containRatio: 5,
  containDamp: 0.8,
  /** Under this share of the bigger side's size two sets cannot reach any threshold. */
  sizeFloor: 0.05,
  /** T1: identical text shorter than this is matched only inside its document (and, repeated, gets new UIDs, never a question). */
  shortText: 20,
  /** T2a keeps an item at this body overlap (or a title overlap of t2Title); T2b (another document) at t2Other. */
  t2Same: 0.15,
  t2Title: 0.5,
  t2Other: 0.3,
  /** T2: under t2Weak, an old text still alive elsewhere at t2Reused makes it ID reuse. */
  t2Weak: 0.5,
  t2Reused: 0.6,
  /** D0 continuity (SPT 0.3): overlap at least this, or this share of the old items continuing by T1 or T2. */
  d0Overlap: 0.1,
  d0Items: 0.5,
  /** D2: a front-matter id with the same file name or this much overlap. */
  d2Overlap: 0.2,
  /** D3: keep at d3Accept with d3Margin over the next; ask from d3Low; containment from d3ContainMin old shingles. */
  d3Accept: 0.5,
  d3Margin: 0.15,
  d3Low: 0.25,
  d3ContainMin: 200,
  /** A pair accepted under this goes to 확인 권장 (SPT 0.3). */
  reviewBelow: 0.7,
  /** A new item whose best retired candidate scored from here up to `low` gets '어쩌면 같은 것' (SPT §2.5, non-blocking). */
  maybeLow: 0.3,
} as const;
/** Ties at exactly the margin: scores are sums of decimals (1.15 - 1.05 is 0.0999…). */
export const SPEC_SCORE_EPSILON = 1e-9;
/** A document's sketch in the match cache: the bottom-k of its 3-gram hashes (Jaccard and containment estimates). */
export const SPEC_SKETCH_K = 256;
/** Old or current text in a 같은 항목 확인 question, masked, at most (bytes of UTF-8). */
export const SPEC_QUESTION_TEXT_MAX = 4 * 1024;
/** Files read as where a missing document may have gone (no git rename for it), at most per scan. */
export const SPEC_MOVE_CANDIDATES_MAX = 300;
/** 최근 판정: by default and at most; 합치기 offers this many retired items. */
export const SPEC_DECISIONS_PAGE = 20;
export const SPEC_DECISIONS_PAGE_MAX = 100;
export const SPEC_MERGE_TARGETS_MAX = 10;
/** A document nearly all of whose display IDs are defined elsewhere too looks like a table that repeats them (참조만 하는 표?). */
export const SPEC_REPEATER_SHARE = 0.9;
/** A scan that left a file being written scans once more this long after it settles, only if a route asked within SPEC_FOLLOW_UP_READ_MS. */
export const SPEC_FOLLOW_UP_MARGIN_MS = 500;
export const SPEC_FOLLOW_UP_READ_MS = 60_000;
/** SPT §2.8: a folder that is no repository is offered an orphaned Registry when this share of its documents is here unchanged (suggest only). */
export const SPEC_INHERIT_DOC_SHARE = 0.5;
/** SPT-P2 trace (§4.4-4.5, §7.1): the commit scan reads at most this many first-parent commits of HEAD (cached by HEAD). */
export const SPEC_TRACE_COMMITS_MAX = 500;
/** [연결 추가]'s pickers: the last commits and jobs offered, and at most this many rows of any kind. */
export const SPEC_TRACE_PICK_COMMITS = 200;
export const SPEC_TRACE_PICK_JOBS = 100;
export const SPEC_TRACE_PICK_MAX = 200;
/** traceQuery: at most this many nodes and this depth; commits past SPEC_TRACE_COMMITS_PER_NODE of one requirement fold into '+N'. */
export const SPEC_TRACE_NODES_MAX = 150;
export const SPEC_TRACE_DEPTH_MAX = 2;
export const SPEC_TRACE_COMMITS_PER_NODE = 20;
/** The trace index is dropped this long after its last read; rebuilt when older than SPEC_SCAN_MIN_MS (Tasks and jobs move without a rev). */
export const SPEC_TRACE_IDLE_MS = 60_000;
/** links.json: a link's note at most (characters), the link history kept, a bulk confirm at most. */
export const SPEC_LINK_NOTE_MAX = 500;
export const SPEC_LINK_HISTORY_MAX = 2_000;
export const SPEC_LINK_BULK_MAX = 500;
/** SPT-P3-ACCEPT: an item's 인수 기준 in its detail, at most (each cut at SPEC_ITEM_TITLE_MAX). */
export const SPEC_CRITERIA_MAX = 20;
/** acceptance.json: at most this many records (about 300 bytes each); past it every acceptance write is refused, none is ever deleted. */
export const SPEC_ACCEPT_RECORDS_MAX = 10_000;
/** GAME-UI-1: the summary's 이번 주 수락 compares this week with this many past weeks (records older are not read). */
export const SPEC_ACCEPT_WEEKS_PAST = 5;
/** An item's history in its detail, at most (the newest). */
export const SPEC_TRACE_HISTORY_MAX = 50;
/** SPT-P3-OVERVIEW: the 개요's 최근 근거 lists the last SPEC_RECENT_COMMITS commits and at most this many ended jobs and merge records. */
export const SPEC_RECENT_JOBS = 10;
export const SPEC_RECENT_MERGES = 10;
/** A commit's or a job's requirement chips in 최근 근거, at most. */
export const SPEC_RECENT_REQS = 10;
/** MEM-IDLE: the glibc malloc settings the installer starts the daemon with (DAEMON_ENV in
 *  agent-tycoon/install/install.mjs). glibc reads them at exec; the daemon then drops them so claude
 *  sessions, terminals, jobs and codex it starts keep glibc's defaults. */
export const DAEMON_ONLY_ENV = ['MALLOC_MMAP_THRESHOLD_', 'MALLOC_TRIM_THRESHOLD_'] as const;
/** SPT-P4A architecture graph (§8): a Mermaid line longer than this refuses its block (the readers stay linear). */
export const SPEC_ARCH_LINE_MAX = 4_096;
/** An unsupported block's source sent with it, masked, at most (bytes). */
export const SPEC_ARCH_SOURCE_MAX = 4 * 1024;
/** The architecture query: at most this many components (the rest counted in `hidden`) and unsupported blocks. */
export const SPEC_ARCH_NODES_MAX = 200;
export const SPEC_ARCH_UNSUPPORTED_MAX = 50;
/** One Mermaid block, at most (real documents: 20 nodes, 23 edges): past these the block is refused as too big. */
export const SPEC_ARCH_BLOCK_NODES_MAX = 500;
export const SPEC_ARCH_BLOCK_EDGES_MAX = 2_000;
export const SPEC_ARCH_BLOCK_GROUPS_MAX = 100;
/** One document's architecture, at most: past these the document's architecture is refused as too big (nothing of it read). */
export const SPEC_ARCH_DOC_COMPS_MAX = 1_000;
export const SPEC_ARCH_DOC_LINKS_MAX = 5_000;
/** Retired components kept per document (the oldest go first). */
export const SPEC_ARCH_RETIRED_PER_DOC = 200;
/** The architecture query sends at most this many edges per layer (the rest counted in `hiddenEdges`). */
export const SPEC_ARCH_EDGES_MAX = 1_000;
/** A component table's 의존 cell names at most this many components (a longer cell's rest is not read). */
export const SPEC_ARCH_DEP_NAMES_MAX = 100;
/** One project's components read from its documents, at most: the documents past it show as too big (their components kept as they were). */
export const SPEC_ARCH_PROJECT_COMPS_MAX = 10_000;
// ── SPT-P4C: requirement ↔ component (§8). Computed links only: suggested from a label, observed from a module column ──
/** Labels compared per index build, at most (doc path order); a label is whole words, at least this many characters, at most this many words. */
export const SPEC_LINK_LABELS_MAX = 500;
export const SPEC_LINK_LABEL_MIN = 3;
export const SPEC_LINK_LABEL_WORDS_MAX = 4;
/** Requirements whose text is compared with the labels per index build, at most (document order), and the words of each kept for it. */
export const SPEC_LINK_MATCH_REQS_MAX = 2_000;
export const SPEC_LINK_TEXT_WORDS_MAX = 300;
/** Components one label names, and computed component links one requirement gets, at most. */
export const SPEC_LINK_LABEL_COMPS_MAX = 4;
export const SPEC_LINK_PER_REQ_MAX = 10;
/** A module cell's paths (merged over the rows of one requirement), at most. */
export const SPEC_LINK_MODULE_PATHS_MAX = 8;
/** A requirement's text read for its words, at most (characters); a word longer than SPEC_ITEM_TITLE_MAX names no label and is dropped. */
export const SPEC_LINK_TEXT_MAX = 4_096;
/** Korean particles a word may end with: '스케줄러가' names '스케줄러' (longest first; one is stripped). */
export const SPEC_LINK_PARTICLES: readonly string[] = ['입니다', '에서', '에게', '으로', '까지', '부터', '처럼', '보다', '이다', '이', '가', '은', '는', '을', '를', '의', '에', '로', '와', '과', '도', '만'];
/** Words too common to suggest a component by (a one-word label only; lower case). */
export const SPEC_LINK_STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'not', 'are', 'can', 'will', 'has', 'all', 'any', 'new', 'one', 'use', 'each', 'when', 'then',
  'user', 'users', 'data', 'system', 'service', 'app', 'api', 'module', 'component', 'file', 'files', 'page', 'list', 'item', 'name', 'type', 'value',
  'error', 'test', 'tests', 'start', 'end', 'time', 'task', 'job', 'main', 'core', 'base', 'common', 'utils', 'util', 'src', 'lib', 'docs',
  '사용자', '시스템', '데이터', '화면', '기능', '모듈', '구성요소',
]);
// ── SPT-P4B: the owner's architecture (arch.json, the folder skeleton) ──
/** arch.json, at most (bytes): a write past it is refused (spec_arch_full); a bigger file is not read (corrupt, left as it is). */
export const SPEC_ARCH_FILE_MAX_BYTES = 1024 * 1024;
/** arch.json's lists, at most: past one the write that would grow it is refused. History keeps its newest. */
export const SPEC_ARCH_OWNER_COMPS_MAX = 500;
export const SPEC_ARCH_OWNER_RELS_MAX = 1_000;
export const SPEC_ARCH_ALIASES_MAX = 1_000;
export const SPEC_ARCH_APPROVALS_MAX = 1_000;
export const SPEC_ARCH_KINDS_MAX = 2_000;
export const SPEC_ARCH_DECISIONS_MAX = 500;
export const SPEC_ARCH_HISTORY_MAX = 1_000;
/** MAP-A's parents (arch.json, read for one release, never written: SPT C1). */
export const SPEC_ARCH_PARENTS_MAX = 2_000;
// ── SPT C1: the 지도 (GET …/map, SPT §8.1-8.3, §8.6). Estimates until C1-C2 measure them (SPT §14). ──
/** Cells the structure folds into (one per layer first, the rest to the biggest units). */
export const SPEC_MAP_CELLS = 9;
/** Imports between two blocks drawn as an arrow, and a top folder a workspace imports this much from becomes a layer (SPT §8.2 M1). */
export const SPEC_MAP_ARROW_MIN = 50;
/** A layer with this many blocks or more says its pairs inside the cells (⇄ text) instead of lines. */
export const SPEC_MAP_TEXT_PAIRS_FROM = 4;
/** Two code scans (the child process) of one project at least this far apart. */
export const SPEC_MAP_MIN_MS = 30_000;
/** The child process's caps: past one the scan says 일부만 셈 (SPT §8.6). */
export const SPEC_MAP_FILES_MAX = 20_000;
export const SPEC_MAP_FILE_MAX_BYTES = 1024 * 1024;
export const SPEC_MAP_READ_MAX_BYTES = 200 * 1024 * 1024;
export const SPEC_MAP_TIME_MS = 15_000;
export const SPEC_MAP_HEAP_MB = 128;
/** The daemon's wait past the child's own time cap before it kills it, and the answer's size cap. */
export const SPEC_MAP_KILL_GRACE_MS = 5_000;
export const SPEC_MAP_OUT_MAX_BYTES = 32 * 1024 * 1024;
/** Layer violations listed as file pairs, at most. */
export const SPEC_MAP_VIOLATION_PAIRS_MAX = 10;
/** A cell's 안에 든 것: its biggest parts, at most. */
export const SPEC_MAP_INSIDE_MAX = 4;
/** 진행 and 원문 바뀜 look this far back. */
export const SPEC_MAP_RECENT_MS = 7 * 24 * 60 * 60 * 1000;
/** A feature's requirements listed on the right, at most ('+N'). */
export const SPEC_MAP_FEATURE_REQS_MAX = 200;
/** [한 단계 들어가기] this deep at most (the `in` chain). */
export const SPEC_MAP_IN_DEPTH_MAX = 8;
// ── SPT C2: the links (§8.4) and the chain (§6.8) ──
/** The code scan's `git log --no-merges` from HEAD, newest first: at most this many commits, this much output (the child's own cap: this repository's 3,000 are 1.9 MB with their bodies). */
export const SPEC_MAP_COMMITS_MAX = 3_000;
export const SPEC_MAP_LOG_MAX_BYTES = 8 * 1024 * 1024;
/**
 * The link paths counted by default (the bar, the chain's 파일, the cells' 요구 N); the others show in
 * [펼치기] only. A path is on when its sample, judged by an independent agent (not the owner), is right
 * at least SPEC_MAP_PATH_ON_RATE of the time (agent-tycoon/docs/research/spec-map-links-2026-11-04.md;
 * chain.test.ts holds it to the sample).
 */
export const SPEC_MAP_PATH_ON_RATE = 0.7;
export const SPEC_MAP_PATHS_ON: readonly string[] = ['confirmed', 'direct'];
/** [펼치기]: a path's files named per requirement, at most; a cell's recent commits and tags. */
export const SPEC_MAP_PATH_FILES_MAX = 3;
export const SPEC_MAP_BLOCK_RECENT_MAX = 5;
export const SPEC_MAP_BLOCK_TAGS_MAX = 6;
/** A feature's tasks listed in the chain, at most ('+N'). */
export const SPEC_MAP_FEATURE_TASKS_MAX = 50;
/** K9: a Spec Kit folder's lists in the map answer (stories, FR/SC, tasks, plan paths, decisions), at most each, and one line's text at most this many characters. */
export const SPEC_KIT_LIST_MAX = 200;
export const SPEC_KIT_TEXT_MAX = 300;
/** Spec Kit's constitution file, whose prose the rules do not read (the page says so). */
export const SPEC_KIT_CONSTITUTION = '.specify/memory/constitution.md';
/** The folder skeleton: at most this many folders proposed (top folders first, then one level below). */
export const SPEC_ARCH_SKELETON_MAX = 60;
/** BRN K8: a document's folder tree lines read, at most (past it the rest of its trees are not read; its diagrams are). */
export const SPEC_ARCH_TREE_LINES_MAX = 500;
/** BRN K8: the design modules, arrows and drift items a map answer carries, at most (the counts are whole). */
export const SPEC_MAP_DESIGN_MODULES_MAX = 300;
export const SPEC_MAP_DESIGN_EDGES_MAX = 500;
export const SPEC_MAP_DRIFT_ITEMS_MAX = 100;

// ── LOOKS-MEM: the character scan never inflates a sheet it already knows ──
/** A PNG's signature, IHDR and the colour/interlace bytes: all the scan reads of a sheet to judge it. */
export const PNG_HEAD_BYTES = 33;
/** The chip thumbnails' cache folder, inside the settings directory. */
export const THUMB_CACHE_DIR = 'cache/thumbs';
/** Part of a thumbnail's cache key: raise it when `thumbOf` draws differently. */
export const THUMB_CACHE_VERSION = 1;
/** K1 (G6): how much of a transcript's end the one-time background sub-agent scan reads (a spawn
 *  older than that is not seen: ponytail, the whole file if renews ever miss one). */
export const BACKGROUND_SCAN_BYTES = 8 * 1024 * 1024;
/** K1 (G6): a renew stops counting a background sub-agent whose sidecar says it stopped
 *  (`finished`) and whose own transcript has not been written for this long: one that waits on its
 *  own background work and is never woken again would block every renew of its Lead. The longest
 *  real wait seen was 34 minutes; work that runs longer belongs in `agty job`, which outlives the
 *  session. */
export const BACKGROUND_WAITING_MAX_MS = 60 * 60 * 1000;

// ── BRN K3: the agent query tools (read only; BRN Appendix A.4, v0.1 Q12) ──
/** Query calls an agent may make a minute (every query tool together), and the window. */
export const AGENT_QUERY_PER_MINUTE = 30;
export const AGENT_QUERY_WINDOW_MS = 60_000;
/** A query answer's JSON at most (bytes): most tools, search_requirements, get_resume_context. */
export const AGENT_QUERY_BYTES = 8 * 1024;
export const AGENT_QUERY_SEARCH_BYTES = 4 * 1024;
export const AGENT_QUERY_RESUME_BYTES = 16 * 1024;
/** get_message: the neighbour lines' text at most (characters); the message itself is capped by the bytes. */
export const AGENT_QUERY_LINE_MAX = 300;
/** search_requirements: rows asked of the spec reader at most. */
export const AGENT_QUERY_SEARCH_ROWS = 30;
/** get_task_context: files and modules listed at most. */
export const AGENT_QUERY_FILES_MAX = 40;
export const AGENT_QUERY_MODULES_MAX = 12;
/** get_resume_context: commits since the handoff's HEAD, Tasks changed since, at most; the git read's limits. */
export const AGENT_QUERY_SINCE_COMMITS = 20;
export const AGENT_QUERY_SINCE_TASKS = 20;
export const AGENT_QUERY_GIT_MS = 5_000;
export const AGENT_QUERY_GIT_BYTES = 64 * 1024;
/** get_message: the newest posts read of each room the caller is in (an older post is not found). */
export const AGENT_QUERY_ROOM_POSTS = 500;
/** The asked arguments as the agent_query event records them, at most (characters). */
export const AGENT_QUERY_ASK_MAX = 200;

// ── BRN K5: the 개요's five lines (the Lead's latest handoff, read on request) ──
/** Lines kept of each handoff section, and characters of a line, at most. */
export const RESUME_SECTION_ITEMS = 5;
export const RESUME_ITEM_CHARS = 200;

// ── The street (MHO v1b, ADR-0020) ───────────────────────────
/** A neighbour's summary is asked for this often, and only while some client watches the street. */
export const STREET_POLL_MS = 10_000;
/** One summary or pairing call to another PC gives up after this long. */
export const STREET_FETCH_TIMEOUT_MS = 5_000;
/** A pair code lives this long (as a short login code, NFR-SEC-016), once, and one at a time. */
export const STREET_PAIR_CODE_MS = 5 * 60_000;
/** A signed summary request is good this long either side of the reader's clock (ADR-0020 M1). */
export const STREET_SIG_WINDOW_MS = 2 * 60_000;
/** One reader gets at most one summary this often (a leaked key cannot hammer the host). */
export const STREET_SUMMARY_MIN_MS = 2_000;

// ── ACP-1: agents that speak ACP (engine/agents/acp/) ──
/** initialize plus session/new (or resume/load) must answer within this, or the child is ended. */
export const ACP_START_MS = 60_000;
/** session/close is waited for this long on a stop, then the child is ended anyway. */
export const ACP_CLOSE_MS = 2_000;
/** After SIGTERM, SIGKILL our child this much later if it is still there. */
export const ACP_KILL_GRACE_MS = 3_000;
/** One JSON-RPC message from an agent, at most (a longer line closes its connection). */
export const ACP_MESSAGE_MAX_BYTES = 8 * 1024 * 1024;
/** One assistant text record in the transcript, at most (characters; the rest is cut). */
export const ACP_TEXT_MAX = 64 * 1024;
/** One field an agent gives (a tool title, a command, a path, an option name), at most. */
export const ACP_FIELD_MAX = 2_000;
/** Permission options a card shows at most (ACP defines four kinds). */
export const ACP_OPTIONS_MAX = 8;
/** Permission requests one ACP session may hold open at once; more are answered `cancelled`. */
export const ACP_ASKS_MAX = 4;
/** Tool calls one ACP transcript keeps open (never ended) at most; more are not written. */
export const ACP_OPEN_TOOLS_MAX = 1_000;
/** An ACP transcript's size past which only our prompts and turn ends are written (bytes). */
export const ACP_TRANSCRIPT_MAX_BYTES = 128 * 1024 * 1024;
/** Plan entries written at most. */
export const ACP_PLAN_MAX = 50;
/** The end of an agent's stderr kept for the log when it fails to start (bytes). */
export const ACP_STDERR_KEEP = 2_048;

// ── Webview error reports (T-74) ──
/** Reports one socket may log per window; the rest are counted and summed up once the window ends. */
export const WEBVIEW_ERROR_BURST = 10;
export const WEBVIEW_ERROR_WINDOW_MS = 60_000;
