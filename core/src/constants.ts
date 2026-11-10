/**
 * Shared constants used across server, extension, and webview.
 * Only constants needed by core interfaces live here.
 * Server-specific timing constants stay in server/src/constants.ts.
 * Webview-specific rendering constants stay in webview-ui/src/constants.ts.
 * Provider-specific constants stay in their provider directory.
 */

// ── Hook API ─────────────────────────────────────────────────

export const HOOK_API_PREFIX = '/api/hooks';
export const SERVER_JSON_NAME = 'server.json';

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
/** agty chat (T-0014): `/agty/attach/:id` streams `claude attach <id>` of a
 *  Claude background session in the terminal frames above. */
export const CHAT_WS_PREFIX = '/agty/attach';

// ── Transport ────────────────────────────────────────────────
// Connection-state names for the MessageTransport state machine.

export const TRANSPORT_STATE_CONNECTING = 'connecting';
export const TRANSPORT_STATE_CONNECTED = 'connected';
export const TRANSPORT_STATE_RECONNECTING = 'reconnecting';
export const TRANSPORT_STATE_DISCONNECTED = 'disconnected';

// ── Notices (agty T-0039) ─────────────────────────────────

/** The same notice kind for the same target at most once in this window (FR-NTF-003). */
export const NOTICE_COOLDOWN_MS = 5 * 60_000;
/** The longest task title or activity line a turn-end notice names (characters). */
export const NOTICE_WHAT_MAX = 40;
/** Web Push: a repeated question or permission ask is never held back for 5 minutes (it replaces the one shown, same tag). */
export const PUSH_ATTENTION_COOLDOWN_MS = 60_000;
/** U-49: a device counts as looking only through a page that reported "showing" this recently (the page repeats it
 *  every LOOKING_BEAT_MS while it is showing; a phone page that was suspended stops, and is no longer looking). */
export const LOOKING_FRESH_MS = 30_000;

// ── Renew (T-0116) ───────────────────────────────────────────

/** After its compactions, a conversation is due for a hand-over once its context is this full
 *  again: below Claude Code's own compaction point, leaving room to finish and write the handoff. */
export const RENEW_FILL_PCT = 85;

// ── Parties (FEAT-PARTY-V2) ──────────────────────────────────

/** The parties the owner composes (server/src/agent-tycoon/parties.ts keeps them, the webview edits them):
 *  at most this many, an id and a name this long, this many members of look keys this long. */
export const PARTY_MAX = 20;
export const PARTY_ID_MAX = 40;
export const PARTY_NAME_MAX = 40;
export const PARTY_MEMBER_MAX = 200;
export const PARTY_MEMBER_KEY_MAX = 200;
/** The default party (everyone): the screen's own, never stored. */
export const PARTY_DEFAULT_ID = 'all';

// ── The street (MHO §3.4, ADR-0020) ──────────────────────────
// Another PC's daemon reads this host's narrow street summary with a street token; nothing else.

/** The one route a street token opens (ADR-0020). */
export const STREET_SUMMARY_PATH = '/api/street/summary';
/** Where another PC's daemon pairs with a pair code (public in the gate: the code is the credential). */
export const STREET_PAIR_PATH = '/api/street/pair';
/** ADR-0020: the street key is HMAC-SHA256(pairing token, this label), the same on both sides. */
export const STREET_KEY_LABEL = 'agent-tycoon street key v1';
/** The summary's shape version (`v`, and `?v=` on the request). */
export const STREET_SUMMARY_VERSION = 1;
/** At most this many agents in one summary (waiting ones first, so none of them is cut). */
export const STREET_AGENTS_MAX = 200;
/** A host or agent name in a summary: at most this many characters. */
export const STREET_NAME_MAX = 64;
/** A daemon version string in a summary: at most this many characters. */
export const STREET_VERSION_MAX = 32;
/** A summary or pairing reply larger than this is dropped unread. */
export const STREET_REPLY_BYTES = 32 * 1024;
/** Neighbours one host reads, and hosts that may read it: at most this many each. */
export const STREET_PAIRS_MAX = 16;

// ── Webview error reports (T-74, `webviewError`) ──
/** The error's message, at most this many characters. */
export const WEBVIEW_ERROR_MESSAGE_MAX = 500;
/** The top of the stack and of the component stack, each at most this many characters. */
export const WEBVIEW_ERROR_STACK_MAX = 2000;
/** The error boundary's region name. */
export const WEBVIEW_ERROR_REGION_MAX = 64;
/** Lines of a stack kept (its top: where it broke). */
export const WEBVIEW_ERROR_STACK_LINES = 12;
