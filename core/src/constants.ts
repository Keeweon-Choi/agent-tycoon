/**
 * Shared constants used across server, extension, and webview.
 * Only constants needed by core interfaces live here.
 * Server-specific timing constants stay in server/src/constants.ts.
 * Webview-specific rendering constants stay in webview-ui/src/constants.ts.
 * Provider-specific constants stay in their provider directory.
 */

// ── Hook API ─────────────────────────────────────────────────

export const HOOK_API_PREFIX = '/api/hooks';
export const SERVER_JSON_DIR = '.pixel-agents';
export const SERVER_JSON_NAME = 'server.json';
export const HOOK_SCRIPTS_DIR = '.pixel-agents/hooks';

// ── Display ──────────────────────────────────────────────────

export const BASH_COMMAND_DISPLAY_MAX_LENGTH = 30;
export const TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40;

// ── Terminal (standalone embedded terminal) ──────────────────
// The raw PTY byte stream deliberately lives OUTSIDE the AsyncAPI contract --
// it is a data plane (unstructured, high-frequency), not a control plane.
// Only the terminal's control-plane facts (availability, session open/close)
// are AsyncAPI ServerMessages. See docs/design/standalone-terminal.md.

/** Path prefix for the per-agent terminal WebSocket: `/terminal/:agentId`. The
 *  handshake carries the server token as `?token=`, exactly like `/ws` (see
 *  server/src/wsAuth.ts); the frame shapes are in terminalFrames.ts. */
export const TERMINAL_WS_PREFIX = '/terminal';
/** cld-gui chat (T-0014): `/cld/attach/:id` streams `claude attach <id>` of a
 *  Claude background session in the terminal frames above. */
export const CHAT_WS_PREFIX = '/cld/attach';

// ── Transport ────────────────────────────────────────────────
// Connection-state names for the MessageTransport state machine.

export const TRANSPORT_STATE_CONNECTING = 'connecting';
export const TRANSPORT_STATE_CONNECTED = 'connected';
export const TRANSPORT_STATE_RECONNECTING = 'reconnecting';
export const TRANSPORT_STATE_DISCONNECTED = 'disconnected';

// ── Notices (cld-gui T-0039) ─────────────────────────────────

/** The same notice kind for the same target at most once in this window (FR-NTF-003). */
export const NOTICE_COOLDOWN_MS = 5 * 60_000;
/** Web Push: a repeated question or permission ask is never held back for 5 minutes (it replaces the one shown, same tag). */
export const PUSH_ATTENTION_COOLDOWN_MS = 60_000;
/** U-49: a device counts as looking only through a page that reported "showing" this recently (the page repeats it
 *  every LOOKING_BEAT_MS while it is showing; a phone page that was suspended stops, and is no longer looking). */
export const LOOKING_FRESH_MS = 30_000;

// ── Renew (T-0116) ───────────────────────────────────────────

/** After its compactions, a conversation is due for a hand-over once its context is this full
 *  again: below Claude Code's own compaction point, leaving room to finish and write the handoff. */
export const RENEW_FILL_PCT = 85;
