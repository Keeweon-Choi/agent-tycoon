// ── JSONL File Watching ─────────────────────────────────────
export const FILE_WATCHER_POLL_INTERVAL_MS = 500;
export const PROJECT_SCAN_INTERVAL_MS = 1000;

// ── cld-gui sources ─────────────────────────────────────────
/** Usage refresh cadence while an office viewer is present. */
export const USAGE_REFRESH_MS = 120_000;
/** Claude's account usage endpoint (the one Claude Code's own /usage reads), with the user's OAuth token. */
export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** The beta header that endpoint requires for an OAuth bearer token. */
export const CLAUDE_USAGE_BETA = 'oauth-2025-04-20';
export const CLAUDE_USAGE_USER_AGENT = 'agent-tycoon';
/** One usage request (fetch or its curl retry) gives up after this. */
export const CLAUDE_USAGE_TIMEOUT_MS = 10_000;
/** At most one usage request per refresh interval, whatever asks (a reconnect, the refresh icon); the
 *  slack keeps a timer tick that fires a hair early from skipping a whole interval. */
export const CLAUDE_USAGE_MIN_GAP_MS = USAGE_REFRESH_MS - 5_000;
/** After a 429, a 5xx or a network error the next usage request waits USAGE_REFRESH_MS doubled per failure
 *  in a row (4, 8, 16 min ...), or the server's Retry-After; either way at most this long. */
export const CLAUDE_USAGE_BACKOFF_MAX_MS = 30 * 60_000;
/** While backing off, the last good endpoint reading (per-model figures included) stays shown until it is this old. */
export const CLAUDE_USAGE_STALE_MS = 6 * 3_600_000;
/** The last good endpoint reading, kept next to usage-claude.json (the status line's) so a restart still shows per-model windows. */
export const CLAUDE_USAGE_API_FILE = 'usage-claude-api.json';
/** macOS: the Keychain item Claude Code keeps its OAuth credentials in. */
export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
/** A Keychain read that would wait on a permission dialog is given up after this. */
export const CLAUDE_KEYCHAIN_TIMEOUT_MS = 3_000;
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
/** Number of pre-colored bundled character palettes (char_0.png–char_5.png).
 *  Mirrors `PALETTE_COUNT` in webview-ui/src/constants.ts; kept separate
 *  because the server has no DOM/sprite access and cannot import the webview
 *  constant. The two values must stay in sync. */
export const PALETTE_COUNT = 6;
/** Inclusive upper bound for a valid agent hue shift, in degrees. Used by
 *  clientMessageHandler to guard saveAgentSeats payloads from a remote or
 *  hand-edited source corrupting the stored values with out-of-range values. */
export const HUE_SHIFT_MAX_DEG = 360;

/** Maximum transcript bytes read by one messenger search. */
export const CHAT_SEARCH_MAX_BYTES = 64 * 1024 * 1024;
/** Maximum search matches returned to one client. */
export const CHAT_SEARCH_MAX_HITS = 50;

/** cld-gui (S6): a confirmed connector change closes the connection it came through this long after answering, so the page gets the result and can move. */
export const CUT_GRACE_MS = 5000;
/** cld-gui: the daemon's shutdown gives up and exits after this long (a hung step held deploys until systemd's SIGKILL). */
export const SHUTDOWN_DEADLINE_MS = 10_000;

/** Tool descriptions remembered per agent for re-sends; a running tool is always among the newest. */
export const TOOL_DESC_KEEP = 64;

/** AGENT-CLI: a plain office (no Claude Code at start) looks again when a viewer connects, at most this often. */
export const AGENT_CLI_RECHECK_MIN_GAP_MS = 5_000;
/** AGENT-CLI: Windows logon environment registry reads are shared by shells opened together. */
export const WINDOWS_LOGON_ENV_CACHE_MS = 5_000;
/** AGENT-CLI: maximum time spent proving a discovered Claude Code candidate works. */
export const AGENT_CLI_VERSION_TIMEOUT_MS = 10_000;
/** AGENT-CLI: after ordering the restart, the plain daemon waits this long to be replaced before it says the restart failed. */
export const AGENT_CLI_RESTART_WAIT_MS = 30_000;
/** AGENT-CLI: the service manager command that restarts the daemon gives up after this long. */
export const AGENT_CLI_RESTART_COMMAND_TIMEOUT_MS = 30_000;
/** AGENT-CLI: exit code of a daemon that ends itself for a restart (EX_TEMPFAIL); the exit code itself restarts nothing, a helper or a test runner does. */
export const AGENT_CLI_RESTART_EXIT_CODE = 75;

// ── cld-gui TERM-P1 (ADR-0018): our own PTY host for agent sessions ──
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
/** Claude Code's own limit on that hook (seconds): above our wait, so our "no decision" comes first. */
export const PTY_PERMISSION_HOOK_S = 270;
/** TERM-P3: a move's rollback waits this long for the agent's host terminals to close (SIGKILL after TERMINAL_KILL_GRACE_MS). */
export const PTY_CLOSE_WAIT_MS = 10_000;
/** A control-socket request that may wait this long (that hook, a move): longer than both. */
export const CONTROL_LONG_MS = 5 * 60_000;

// ── P4 dev room (cld/devroom.ts) ──
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
