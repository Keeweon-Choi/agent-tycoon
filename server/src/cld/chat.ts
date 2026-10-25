/**
 * Chat (T-0014): a Claude background session's real TUI in the browser.
 *
 * `/cld/attach/:id` exists only with --allow-chat and passes the same gate as
 * /ws (same-origin handshake, logged-in browser). It runs exactly
 * [<absolute claude>, 'attach', <id>] in a PTY: no shell, nothing from the
 * client but the id, which must be a background session in a fresh
 * `claude agents --json` whose process is alive here, and whose conversation is
 * not open in a terminal. `claude attach` RESUMES a session that is not
 * running: a stopped one is absent from the list, but one killed by a reboot
 * stays there without a pid, and resuming it could open a conversation that
 * already runs elsewhere (a terminal) a second time.
 *
 * One PTY per session, shared by its viewers: Claude gives every attach of a
 * session one geometry anyway, and each attach costs ~150 MB (spike,
 * cld/tasks/progress/T-0014.md). The upstream PtySession mirror replays the
 * screen to late joiners. The RAM budget (everything cld-gui starts, under
 * 300 MB while watched; the daemon is ~85 MB) allows one attach by default.
 *
 * Input: Ctrl+Z is dropped (it detaches the attach, for every viewer), and so
 * is ← while Claude offers its agent view, which reaches every session on the
 * machine and dispatches new ones; if that view shows anyway, the attach is
 * killed. Lifetime: the child exiting closes the viewers; the last viewer
 * leaving kills the PTY, and so does a safety net when it has no open viewer
 * for 2 minutes; at most `maxPtys` (default 1) at once.
 * Log: one line per attach, detach or refusal, never terminal content.
 */
import type { IBufferLine } from '@xterm/headless';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CHAT_WS_PREFIX } from '../../../core/src/constants.js';
import { encodeTerminalFrame, parseClientFrame } from '../../../core/src/terminalFrames.js';
import {
  PTY_MODULE_CANDIDATES,
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
  TERMINAL_KILL_GRACE_MS,
  TERMINAL_SHUTDOWN_SLACK_MS,
  TERMINAL_TERM_NAME,
  WS_CLOSE_NO_SESSION,
} from '../constants.js';
import type { IPty, PtyModule } from '../terminal/ptyModule.js';
import { PtySession } from '../terminal/ptySessionManager.js';
import { deviceLabel } from './device.js';
import { claudeAttachArgv } from './engine/agents/claude/claude.js';
import type {
  PermissionAnswer,
  PermissionMatch,
  TypeOptions,
  TypeResult,
  Typist,
} from './engine/messenger.js';
import { readJson, writeJsonAtomic } from './jsonFile.js';
import { maskText } from './mask.js';
import type { ClaudeSession } from './providers/claudeProvider.js';
import { CLAUDE_TIMEOUT_MS, parseAgents, processAlive } from './providers/claudeProvider.js';
import { spawnJson } from './spawnJson.js';

/** Default cap on attach processes (`--chat-attaches`): ~150 MB each. */
export const CHAT_MAX_PTYS = 1;
/** The 설정 value's range (T-0078): what a person may choose, however high the flag went. */
export const CHAT_ATTACHES_MIN = 1;
export const CHAT_ATTACHES_MAX = 4;
/** The close reason of a refusal for the cap, so a pane can offer "이 터미널로 바꾸기". */
export const CHAT_CAP_REASON = 'cap';
export const CHAT_IDLE_MS = 2 * 60_000;
/** cld-gui send's typing (T-0019): the attach's first screen takes ~2 s; Enter
 *  waits for the paste to land; the input line clears when it is submitted. */
export const TYPE_TIMING = {
  readyMs: 12_000,
  enterMs: 400,
  /** After enterMs, how long a paste may take to show (a long one renders slowly). */
  showMs: 3_000,
  submitMs: 3_000,
  pollMs: 100,
};

const WS_OPEN = 1;
/** All of our environment the attach gets: a login's basics. Claude's
 *  per-user daemon, which an attach starts when it is not running, keeps the
 *  environment of whoever started it, so nothing of this
 *  service's own may reach it. */
export const LOGIN_ENV = [
  'HOME',
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'USER',
  'LOGNAME',
  'SHELL',
  'XDG_RUNTIME_DIR',
  'TMPDIR',
] as const;
/** `claude agents --json` background ids: 8 lowercase hex digits. */
const ID = /^[0-9a-f]{8}$/;
/** ← in normal and application cursor mode, with or without modifiers. */
const LEFT = /\x1b\[(?:1;\d+)?D|\x1bOD/g;
/** Claude offers its agent view: the footer's "← 2 agents" while the input
 *  line is empty, then "Press ← again to go back to agents". */
const AGENTS_OFFER = /go back to agents|← \d+ agents?/;
/** The agent view's footer ("enter to return · space to reply · ..."). */
const AGENT_VIEW = 'space to reply';
/** Screens nothing may be typed into: the agent view's new-session input, a turn running. */
const NOT_A_PROMPT = ['describe a task for a new session', AGENT_VIEW];
/** A turn running: the spinner line above the input box ("✻ Working… (esc to interrupt)"). */
const WORKING = 'esc to interrupt';
/** Claude Code's chat:sendNow (ctrl+x ctrl+s): during a turn Enter only queues the input for the
 *  turn's end; this sends it at once, cutting the turn (즉시 보내기, user 10-22 18:33).
 *  ponytail: the default binding; a user who rebinds it in ~/.claude/keybindings.json gets
 *  their own action here, read that file if that ever matters. */
const SEND_NOW = '\x18\x13';
/** Between ctrl+x and ctrl+s of the chord. */
const SEND_NOW_GAP_MS = 40;
/** How long a 즉시 보내기 submitted with Enter watches for Claude Code's "queued" hint. */
const SEND_NOW_HINT_MS = 1_200;

/** PERM-PROMPT: a permission dialog's first option, exactly "1. Yes" (never a "don't ask again"
 *  one), and its question right above the options. */
const PERM_YES = /^\s*(?:❯\s*)?1\.\s*Yes\s*$/;
const PERM_ASK = /^\s*Do you want to /;
/** The words of a call matched against a dialog, whitespace removed: a cut-off line never matches. */
const PERM_MATCH_MAX = 300;
/** An answer's own attach: tall and wide enough for a long command's dialog to fit on its screen. */
const PERM_ATTACH_SIZE = { cols: 160, rows: 60 };

const squash = (t: string) => t.replace(/\s+/g, '');

/** Control characters but newline and tab: nothing typed may leave the paste or press a key. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** From cell `x` on: only blanks (NBSP too), dim text (the suggestion), and
 *  the cursor (inverse) on the suggestion's first letter. A draft's letter
 *  under the cursor is not followed by dim text. */
function blankFrom(row: IBufferLine, x: number, cols: number): boolean {
  for (; x < cols; x++) {
    const cell = row.getCell(x);
    if (!cell || !cell.getChars().trim() || cell.isDim()) continue;
    if (cell.isInverse() && row.getCell(x + 1)?.isDim()) continue;
    return false;
  }
  return true;
}

/**
 * Claude Code's input line on a terminal screen: the row of the last `❯`
 * right under a `─` rule, or -1 when there is none or a screen nothing may be
 * typed into is up. Dialogs (permission, trust, /exit) draw their `❯`
 * elsewhere, so they never have one. A turn running counts as such a screen
 * unless `whileWorking` (a 즉시 보내기: Claude Code queues input typed during
 * a turn). ponytail: Claude Code's screen shape; when it changes this
 * finds nothing, and messages wait.
 */
function inputRow(term: HeadlessTerminal, whileWorking = false): number {
  const b = term.buffer.active;
  const text = (i: number) => b.getLine(b.viewportY + i)?.translateToString() ?? '';
  const refused = whileWorking ? NOT_A_PROMPT : [...NOT_A_PROMPT, WORKING];
  if (refused.some((t) => onScreen(term, t))) return -1;
  for (let i = term.rows - 1; i > 0; i--)
    if (
      text(i).trimStart().startsWith('❯') &&
      text(i - 1)
        .trimStart()
        .startsWith('─')
    )
      return i;
  return -1;
}

/** The screen's last non-blank rows, masked: the log line when a message could not go in shows
 *  what Claude Code was showing (10-22 20:28: messages held while agents ran, cause unseen). */
export function screenTail(term: HeadlessTerminal, rows = 6): string {
  const b = term.buffer.active;
  const out: string[] = [];
  for (let i = term.rows - 1; i >= 0 && out.length < rows; i--) {
    const t =
      b
        .getLine(b.viewportY + i)
        ?.translateToString()
        .trimEnd() ?? '';
    if (t.trim()) out.unshift(maskText(t).slice(0, 120));
  }
  return out.join(' ⏎ ');
}

/** `phrase` is on the screen, also when it wraps onto the next row: a narrow viewer (a phone
 *  attached to the same session) folds Claude Code's "… (esc to interrupt)" line in two, and a
 *  row-by-row look missed the running turn, so 즉시 보내기 pressed Enter (10-22 20:57). */
export function onScreen(term: HeadlessTerminal, phrase: string): boolean {
  const b = term.buffer.active;
  const row = (i: number) => b.getLine(b.viewportY + i)?.translateToString() ?? '';
  for (let i = 0; i < term.rows; i++)
    if (`${row(i)} ${row(i + 1)}`.replace(/\s+/g, ' ').includes(phrase)) return true;
  return false;
}

/** Claude Code's hint for a message queued during a turn ("… ctrl+x ctrl+s …"), any case. */
function sendNowHint(term: HeadlessTerminal): boolean {
  const b = term.buffer.active;
  for (let i = 0; i < term.rows; i++)
    if (
      (b.getLine(b.viewportY + i)?.translateToString() ?? '')
        .toLowerCase()
        .includes('ctrl+x ctrl+s')
    )
      return true;
  return false;
}

/** A turn is running: its spinner line is on the screen. */
function turnRunning(term: HeadlessTerminal): boolean {
  return onScreen(term, WORKING);
}

/**
 * The input line is empty: it holds nothing, or only dim text (the
 * suggestion) and the cursor, down to the rule under it (a draft's later
 * lines count too).
 */
export function inputLineEmpty(term: HeadlessTerminal, whileWorking = false): boolean {
  const i = inputRow(term, whileWorking);
  if (i < 0) return false;
  const b = term.buffer.active;
  const line = (r: number) => b.getLine(b.viewportY + r);
  const row = line(i)!;
  let x = 0;
  while (x < term.cols && row.getCell(x)?.getChars() !== '❯') x++;
  if (!blankFrom(row, x + 1, term.cols)) return false;
  for (let r = i + 1; r < term.rows; r++) {
    if (line(r)?.translateToString().trimStart().startsWith('─')) return true;
    if (!blankFrom(line(r)!, 0, term.cols)) return false;
  }
  return false; // no rule under it: not the shape we know
}

/**
 * PERM-PROMPT: the permission dialog on the screen, as its text from the rule above it (or the
 * screen's top, when it fills the screen) down to its question; null when none is up. A question
 * dialog, the trust dialog or an input line is none.
 */
export function permissionDialog(term: HeadlessTerminal, whole = false): string | null {
  const b = term.buffer.active;
  const row = (i: number) => b.getLine(b.viewportY + i)?.translateToString() ?? '';
  let yes = term.rows - 1;
  while (yes > 0 && !PERM_YES.test(row(yes))) yes--;
  if (yes < 1 || !PERM_ASK.test(row(yes - 1))) return null;
  let top = yes - 1;
  while (top > 0 && !row(top - 1).trimStart().startsWith('─')) top--;
  // `whole`: its rule is on the screen, so nothing of it scrolled off above.
  if (whole && top === 0) return null;
  const out: string[] = [];
  for (let i = top; i < yes; i++) out.push(row(i));
  return out.join('\n');
}

/** PERM-PROMPT: the dialog on screen is `match`: the call's words (dialogMatches), or exactly the
 *  whole dialog read off the screen before (spaces and line wraps aside: another width wraps it
 *  elsewhere). */
function permissionOnScreen(term: HeadlessTerminal, match: PermissionMatch): boolean {
  if (Array.isArray(match)) {
    const d = permissionDialog(term);
    return d !== null && dialogMatches(d, match);
  }
  const d = permissionDialog(term, true);
  return d !== null && squash(d) === squash(match.dialog);
}

/** The dialog is about the call whose words are `match`: every one of them is inside it (spaces and
 *  line wraps aside). Nothing to match is no match. */
export function dialogMatches(dialog: string, match: string[]): boolean {
  const box = squash(dialog);
  return (
    match.length > 0 &&
    match.every((m) => {
      const key = squash(m);
      return key.length > 0 && key.length <= PERM_MATCH_MAX && box.includes(key);
    })
  );
}

/** Claude Code shows a long paste as `[Pasted text #1 +12 lines]` instead of its text. */
const PASTE_PLACEHOLDER = '[Pasted text';
/** Only placeholders in the box (one per paste, `#<n>` counts up, ` +<k> lines` only when multi-line). */
const ONLY_PLACEHOLDERS = /^(\[Pastedtext#\d+[^\]]*\])+$/;
/** A lower bound of what Claude Code folds into a placeholder (it folds from a few lines or
 *  some hundred characters). Under it a placeholder cannot be ours: a short message of ours
 *  is shown as itself, so a placeholder in the box is someone else's paste (U-37). On a
 *  terminal of 10 rows or fewer (a small window, a phone in landscape) Claude Code 2.1.x
 *  folds every multi-line paste, and every message of ours has a header line. */
const FOLDS_MIN_CHARS = 100;
const FOLDS_MIN_LINES = 3;
const FOLDS_SMALL_ROWS = 10;
export function foldsWhenPasted(text: string, rows: number): boolean {
  const lines = text.split('\n').length;
  return text.length >= FOLDS_MIN_CHARS || lines >= (rows <= FOLDS_SMALL_ROWS ? 2 : FOLDS_MIN_LINES);
}
/** Non-space characters of our text that mark a draft as ours. */
const DRAFT_KEY = 24;
/** A message's header line (`[cld-gui · beta에게서 · 10-22 11:57]`, messenger.ts header()),
 *  with or without its C2 mark (` ⟨m:<id>⟩`). */
const HEADER = /^\[[^\n]*\](?: ⟨m:[a-z2-7]{8}⟩)?$/;

/** What marks `text` as ours in an input box: the first DRAFT_KEY non-space
 *  characters of its body (after the header line, when it has one and more). */
function draftKey(text: string): string {
  const lines = text.split('\n');
  const body =
    HEADER.test(lines[0].trim()) && lines.slice(1).some((l) => l.trim()) ? lines.slice(1) : lines;
  return squash(body.join('\n')).slice(0, DRAFT_KEY);
}

/**
 * The input box shows our paste `text`: the box (from the `❯` row down to the
 * rule under it, whitespace removed) holds Claude Code's paste placeholder
 * (only when `text` is long enough to be folded into one, see foldsWhenPasted),
 * or the start of our body (draftKey), or is itself a long enough piece of
 * our text (a long draft scrolled inside the box). Never on a dialog: the box
 * must be the input line inputRow finds. `only`: the box holds the whole of
 * our text and nothing else (or only paste placeholders): a draft someone
 * added to, or a piece of it someone is typing, is left alone.
 */
export function draftShown(
  term: HeadlessTerminal,
  text: string,
  whileWorking = false,
  only = false,
): boolean {
  const i = inputRow(term, whileWorking);
  if (i < 0) return false;
  const b = term.buffer.active;
  const row = (r: number) => b.getLine(b.viewportY + r)?.translateToString() ?? '';
  const first = row(i);
  let shown = first.slice(first.indexOf('❯') + 1);
  for (let r = i + 1; r < term.rows && !row(r).trimStart().startsWith('─'); r++) shown += row(r);
  const box = squash(shown);
  if (!box) return false;
  const folded = foldsWhenPasted(text, term.rows);
  if (only) return box === squash(text) || (folded && ONLY_PLACEHOLDERS.test(box));
  if (folded && box.includes(squash(PASTE_PLACEHOLDER))) return true;
  const key = draftKey(text);
  return (!!key && box.includes(key)) || (box.length >= DRAFT_KEY && squash(text).includes(box));
}

export const CHAT_TEXT = {
  notLive: '지금 열 수 있는 백그라운드 세션이 아니에요.',
  inTerminal: '이 대화는 터미널(tmux)에서 열려 있어 여기서는 볼 수만 있어요.',
  listFailed: 'Claude 세션 목록을 읽지 못했어요. 잠시 뒤 다시 열어 주세요.',
  noPty: '터미널 모듈을 불러오지 못해 대화를 열 수 없어요.',
  agentView: '에이전트 목록은 여기서 열 수 없어 대화를 닫았어요. 대화 버튼으로 다시 열 수 있어요.',
  tooMany: (n: number) =>
    `동시에 열 수 있는 대화는 ${n}개까지예요. 다른 대화를 닫고 다시 열어 주세요.`,
};

/**
 * The row's session process runs here: it has a pid, /proc/<pid> exists, and,
 * when Claude recorded the start time (the row's `procStart`, or
 * `~/.claude/sessions/<pid>.json`), it matches /proc/<pid>/stat's (a reused
 * pid does not). Without /proc (macOS, Windows): signal 0.
 */
export function sessionProcessAlive(s: ClaudeSession, home = os.homedir()): boolean {
  const pid = s.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  let recorded = s.procStart;
  if (recorded === undefined && process.platform === 'linux') {
    try {
      const file = path.join(home, '.claude', 'sessions', `${pid}.json`);
      recorded = (JSON.parse(fs.readFileSync(file, 'utf8')) as ClaudeSession).procStart;
    } catch {
      /* no record: the pid check is all there is */
    }
  }
  return processAlive(pid, recorded === undefined ? undefined : String(recorded));
}

/** The session `id` names in a fresh `claude agents --json`, or why it cannot be attached. */
export function attachable(
  sessions: ClaudeSession[],
  id: string,
  home = os.homedir(),
): ClaudeSession | string {
  const s = ID.test(id) ? sessions.find((x) => x.kind === 'background' && x.id === id) : undefined;
  if (!s || !sessionProcessAlive(s, home)) return CHAT_TEXT.notLive;
  if (sessions.some((x) => x.kind === 'interactive' && x.sessionId === s.sessionId)) {
    return CHAT_TEXT.inTerminal;
  }
  return s;
}

/** Viewer input as it reaches the PTY: no Ctrl+Z, no ← while the agent view is offered. */
export function filterInput(data: string, agentsOffered: boolean): string {
  const out = data.replaceAll('\x1a', '');
  return agentsOffered ? out.replace(LEFT, '') : out;
}

/** The slice of a WebSocket the chat uses (tests pass a fake). */
export interface ChatSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: Buffer | string) => void): void;
  on(event: 'close', listener: () => void): void;
}

function notice(socket: ChatSocket, text: string): void {
  const data = `\r\n\x1b[33m${text}\x1b[0m\r\n`;
  if (socket.readyState === WS_OPEN) socket.send(encodeTerminalFrame({ type: 'output', data }));
}

/** One `claude attach` and its viewers. */
class ChatPty {
  private readonly viewers = new Set<ChatSocket>();
  /** Screen-only copy of the terminal, to read Claude's hints off it. */
  private readonly screen: HeadlessTerminal;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private ended = false;
  /** cld-gui sends typing through this attach right now (it outlives its viewers until done). */
  private sending = 0;
  /** PERM-PROMPT: an answer to a permission dialog is in flight. */
  private answering = false;
  /** Viewer input held while a send types (null: none is). */
  private held: string[] | null = null;

  constructor(
    readonly session: PtySession,
    private readonly name: string,
    private readonly idleMs: number,
    private readonly log: (line: string) => void,
    private readonly gone: () => void,
  ) {
    this.screen = new HeadlessTerminal({
      cols: session.cols,
      rows: session.rows,
      scrollback: 0,
      allowProposedApi: true, // buffer access
    });
    session.onData((chunk) =>
      this.screen.write(chunk, () => {
        if (!this.ended && this.row(-1).includes(AGENT_VIEW)) this.end(CHAT_TEXT.agentView);
      }),
    );
    session.onExit(() => {
      this.ended = true;
      clearTimeout(this.idleTimer);
      this.screen.dispose();
      this.gone();
    });
    this.touch();
  }

  /** A screen row as text; negative counts from the bottom. */
  private row(i: number): string {
    const b = this.screen.buffer.active;
    return b.getLine(b.viewportY + (i < 0 ? this.screen.rows + i : i))?.translateToString() ?? '';
  }

  private agentsOffered(): boolean {
    for (let i = 0; i < this.screen.rows; i++) if (AGENTS_OFFER.test(this.row(i))) return true;
    return false;
  }

  /** Input (or a new viewer) restarts the safety net's clock. When it runs
   *  out, an open viewer keeps the attach, even an idle or forgotten one; with
   *  none (a departure we never heard about) it ends. */
  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.sending || [...this.viewers].some((s) => s.readyState === WS_OPEN)) this.touch();
      else this.end();
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  /** Kill the attach (the session keeps running); `text` tells the viewers why. */
  end(text?: string): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.idleTimer);
    if (text) for (const socket of this.viewers) notice(socket, text);
    this.session.dispose();
    this.gone();
  }

  /**
   * cld-gui send (T-0019): when the input line is empty, `text` as a
   * bracketed paste (newlines as Enter keys inside it, as tmux pastes), then
   * Enter. An attach no viewer holds ends after. `whileWorking`: a running
   * turn's screen counts too (everything else is checked the same).
   */
  async typeText(
    text: string,
    t: typeof TYPE_TIMING,
    whileWorking = false,
    o: TypeOptions = {},
  ): Promise<TypeResult> {
    if (this.ended) return 'failed';
    this.sending++;
    try {
      const clean = text.replace(/\r\n?/g, '\n').replace(CONTROL, '');
      const ours = () => draftShown(this.screen, clean, whileWorking);
      const oursOnly = () => draftShown(this.screen, clean, whileWorking, true);
      const earlier = () =>
        !oursOnly() &&
        (o.earlier ?? []).some((e) =>
          draftShown(this.screen, e.replace(CONTROL, ''), whileWorking, true),
        );
      const ready = await this.until(
        () => inputLineEmpty(this.screen, whileWorking) || oursOnly() || earlier(),
        t.readyMs,
        t.pollMs,
      );
      if (this.ended) return 'failed';
      if (!ready) {
        this.log(`not ready in ${JSON.stringify(this.name)}: ${screenTail(this.screen)}`);
        return 'notReady';
      }
      // Seen before the paste: a tall draft may push the spinner line off the screen.
      const running = whileWorking && (!!o.busy || turnRunning(this.screen));
      this.touch();
      // Viewers' keys wait until the Enter is in: none lands inside this message.
      this.held = [];
      // A different message of ours can be left by a previous send whose
      // paste was accepted but whose submit timed out. Submit precisely that
      // draft, then leave this message queued for the next try.
      if (earlier()) {
        this.session.write('\r');
        this.release();
        const cleared = await this.until(
          () => inputLineEmpty(this.screen, true),
          t.submitMs,
          t.pollMs,
        );
        if (cleared) this.log(`submitted an earlier message's draft in ${this.name}`);
        return 'notReady';
      }
      // This message's own draft, left by an earlier try whose paste showed too
      // late: submit it rather than wait behind it forever. Anything else in
      // the box was never ready (someone may be typing).
      const healed = oursOnly();
      if (!healed && !inputLineEmpty(this.screen, whileWorking)) return 'notReady';
      if (!healed) {
        o.onTyped?.();
        this.session.write(`\x1b[200~${clean.replaceAll('\n', '\r')}\x1b[201~`);
        await new Promise((r) => setTimeout(r, t.enterMs));
        // Enter only into the input line showing our paste, never into a dialog
        // (a turn or a dialog may come up meanwhile). The paste stays a draft,
        // which the next try submits.
        if (!(await this.until(ours, t.showMs, t.pollMs))) {
          if (this.ended) return 'failed';
          this.log(
            `not submitted into ${JSON.stringify(this.name)}: our paste did not show: ${screenTail(this.screen)}`,
          );
          return 'notReady';
        }
      }
      if (running || (whileWorking && (!!o.busy || turnRunning(this.screen)))) {
        // The chord as two key presses: in one chunk Claude Code's input may not see ctrl+x, ctrl+s.
        this.session.write(SEND_NOW[0]);
        await new Promise((r) => setTimeout(r, SEND_NOW_GAP_MS));
        this.session.write(SEND_NOW[1]);
      } else {
        // 즉시 보내기 with no running turn seen: Enter. If a turn was running after all, Claude Code only
        // queues it (U-31), so leave the screen in the log to see what the turn check missed.
        if (whileWorking)
          this.log(
            `즉시 보내기 into ${JSON.stringify(this.name)}: no running turn seen, pressed Enter: ${screenTail(this.screen)}`,
          );
        this.session.write('\r');
        // Enter only queued it: Claude Code then shows its ctrl+x ctrl+s hint. Send it now after all.
        if (
          whileWorking &&
          (await this.until(() => sendNowHint(this.screen), SEND_NOW_HINT_MS, t.pollMs))
        ) {
          this.session.write(SEND_NOW[0]);
          await new Promise((r) => setTimeout(r, SEND_NOW_GAP_MS));
          this.session.write(SEND_NOW[1]);
          this.log(
            `즉시 보내기 into ${JSON.stringify(this.name)}: queued by Enter, sent with ctrl+x ctrl+s`,
          );
        }
      }
      this.release();
      // Submitted, the turn starts (or goes on): its working screen is expected here.
      const cleared = await this.until(
        () => inputLineEmpty(this.screen, true),
        t.submitMs,
        t.pollMs,
      );
      if (healed) {
        this.log(
          `${cleared ? 'submitted' : 'could not submit'} our earlier draft in ${JSON.stringify(this.name)}`,
        );
        return cleared ? 'typed' : 'notReady';
      }
      if (!cleared)
        this.log(`typed into ${JSON.stringify(this.name)}; its input line did not clear`);
      return 'typed';
    } finally {
      this.release();
      this.sending--;
      if (!this.ended && this.viewers.size === 0 && !this.sending) this.end();
    }
  }

  /**
   * PERM-PROMPT: answer the permission dialog about the call whose words are `match`: "1. Yes"
   * (`allow`) or Esc, only when that dialog is on the screen right now (checked and pressed in one
   * synchronous step), then wait for it to go away. Anything else on the screen sends nothing.
   */
  async answerPermission(
    match: PermissionMatch,
    allow: boolean,
    t: typeof TYPE_TIMING,
  ): Promise<PermissionAnswer> {
    // A second answer while one is in flight (a double press, two devices) presses nothing: the
    // screen it reads may still show the answered dialog while Claude already shows the next one.
    if (this.ended || this.answering) return 'failed';
    this.answering = true;
    this.sending++;
    try {
      const ours = () => permissionOnScreen(this.screen, match);
      await this.settled(t);
      if (this.ended) return 'failed';
      if (!ours()) return permissionDialog(this.screen) === null ? 'noDialog' : 'otherDialog';
      this.session.write(allow ? '1' : '\x1b');
      return (await this.until(() => !ours(), t.submitMs, t.pollMs)) ? 'answered' : 'notCleared';
    } finally {
      this.answering = false;
      this.sending--;
      if (!this.ended && this.viewers.size === 0 && !this.sending) this.end();
    }
  }

  /** A fresh attach's first screen takes a moment: wait for a dialog or an input line. */
  private settled(t: typeof TYPE_TIMING): Promise<boolean> {
    return this.until(
      () => permissionDialog(this.screen) !== null || inputRow(this.screen, true) >= 0,
      t.readyMs,
      t.pollMs,
    );
  }

  /** PERM-PROMPT: the whole permission dialog on the screen now, or null (none, or taller than the
   *  screen). Nothing is written. */
  async readPermissionDialog(t: typeof TYPE_TIMING): Promise<string | null> {
    if (this.ended) return null;
    this.sending++;
    try {
      await this.settled(t);
      return this.ended ? null : permissionDialog(this.screen, true);
    } finally {
      this.sending--;
      if (!this.ended && this.viewers.size === 0 && !this.sending) this.end();
    }
  }

  /** Viewer input held during a send, now in. */
  private release(): void {
    const held = this.held ?? [];
    this.held = null;
    if (!this.ended) for (const data of held) this.session.write(data);
  }

  private async until(ok: () => boolean, ms: number, pollMs: number): Promise<boolean> {
    for (const end = Date.now() + ms; ;) {
      if (this.ended) return false;
      if (ok()) return true;
      if (Date.now() >= end) return false;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /** Attach a viewer: replay, then live output. Returns its input handler. */
  add(socket: ChatSocket, device: string): (raw: string) => void {
    const since = Date.now();
    this.viewers.add(socket);
    this.touch();
    this.log(`attach ${JSON.stringify(this.name)} gui:${device}`);
    const send = (frame: string) => {
      if (socket.readyState === WS_OPEN) socket.send(frame);
    };
    // Snapshot-then-live, as in upstream terminalRoutes: output arriving while
    // the snapshot is taken waits behind it, so nothing is dropped or doubled.
    let queue: string[] | null = [];
    const offData = this.session.onData((data) => {
      const frame = encodeTerminalFrame({ type: 'output', data });
      if (queue) queue.push(frame);
      else send(frame);
    });
    const replayed = this.session.snapshot().then((data) => {
      const { cols, rows } = this.session;
      send(encodeTerminalFrame({ type: 'replay', data, cols, rows }));
      for (const frame of queue ?? []) send(frame);
      queue = null;
    });
    const offExit = this.session.onExit(({ exitCode, signal }) => {
      void replayed.then(() => {
        send(encodeTerminalFrame({ type: 'exit', exitCode, signal }));
        socket.close(WS_CLOSE_NO_SESSION, 'exited');
      });
    });
    socket.on('close', () => {
      offData();
      offExit();
      this.viewers.delete(socket);
      const secs = Math.round((Date.now() - since) / 1000);
      this.log(`detach ${JSON.stringify(this.name)} gui:${device} after ${secs}s`);
      if (this.viewers.size === 0 && !this.sending) this.end();
    });
    return (raw) => {
      const frame = parseClientFrame(raw);
      if (!frame || this.ended) return;
      if (frame.type === 'resize') {
        this.session.resize(frame.cols, frame.rows);
        this.screen.resize(this.session.cols, this.session.rows);
        return;
      }
      const data = filterInput(frame.data, this.agentsOffered());
      if (!data) return;
      this.touch();
      if (this.held) this.held.push(data);
      else this.session.write(data);
    };
  }
}

export interface ChatOptions {
  /** Absolute path of `claude`. */
  claudePath: string;
  /** A fresh `claude agents --json` (tests inject one). */
  list?: () => Promise<ClaudeSession[]>;
  /** node-pty; required on first use when absent (tests inject a fake). */
  pty?: PtyModule;
  idleMs?: number;
  /** Attach processes at once (`--chat-attaches`, default CHAT_MAX_PTYS); the 설정 value, once chosen, replaces it. */
  maxPtys?: number;
  /** Where the chosen cap is kept (`terminal.json`, 0600); absent: not kept. */
  settingsFile?: string;
  /** Home whose ~/.claude/sessions records process start times (tests). */
  home?: string;
  /** Extra environment for the attach (tests: the fake claude's log). */
  env?: Record<string, string>;
  log?: (line: string) => void;
  /** cld-gui send's waits (tests shorten them). */
  typeTiming?: Partial<typeof TYPE_TIMING>;
}

export class ChatManager implements Typist {
  private readonly ptys = new Map<string, ChatPty>();
  private serial = 0;
  /** The cap now: the chosen value if there is one, else the flag's. */
  private max: number;

  constructor(private readonly opts: ChatOptions) {
    this.max = this.stored() ?? opts.maxPtys ?? CHAT_MAX_PTYS;
  }

  private stored(): number | null {
    if (!this.opts.settingsFile) return null;
    try {
      const n = (readJson(this.opts.settingsFile) as { chatAttaches?: unknown } | null)
        ?.chatAttaches;
      return validAttaches(n) ? n : null;
    } catch {
      return null;
    }
  }

  /** What `--chat-attaches` (or the built-in default) says: the value before anyone chose. */
  get defaultAttaches(): number {
    return this.opts.maxPtys ?? CHAT_MAX_PTYS;
  }

  /** Attach processes allowed at once. */
  get maxAttaches(): number {
    return this.max;
  }

  /**
   * Choose the cap (1 to 4), kept and applied at once: an attach already open
   * stays until its last viewer leaves, new ones count against the new cap.
   * False for anything else.
   */
  setMaxAttaches(n: unknown): boolean {
    if (!validAttaches(n)) return false;
    this.max = n;
    if (this.opts.settingsFile) {
      try {
        const old = readJson(this.opts.settingsFile);
        writeJsonAtomic(this.opts.settingsFile, {
          ...(old && typeof old === 'object' ? old : {}),
          chatAttaches: n,
        });
      } catch (err) {
        this.log(
          `could not keep the attach cap: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.log(`attach cap is now ${n}`);
    return true;
  }

  /** Live attach PTYs. */
  get size(): number {
    return this.ptys.size;
  }

  private log(line: string): void {
    (this.opts.log ?? ((l: string) => console.log(`[cld] chat: ${l}`)))(line);
  }

  private list(): Promise<ClaudeSession[]> {
    if (this.opts.list) return this.opts.list();
    // Our own call, never the office poller's in-flight one: it must not
    // predate the request.
    return spawnJson(this.opts.claudePath, ['agents', '--json'], {
      timeoutMs: CLAUDE_TIMEOUT_MS,
    }).then(parseAgents);
  }

  /**
   * cld-gui send (T-0019): type into background session `id`, which the
   * engine just found live in ~/.claude/sessions (a stopped session is never
   * attached: `claude attach` would resume it). Through its open chat, else
   * an attach of its own that ends after; sends are one at a time and do not
   * count against `maxPtys` (~150 MB for a few seconds).
   */
  async type(id: string, text: string, o: TypeOptions = {}): Promise<TypeResult> {
    if (!ID.test(id)) return 'failed';
    let pty = this.ptys.get(id);
    if (!pty) {
      pty = this.spawn(id, id);
      if (!pty) return 'failed';
      this.ptys.set(id, pty);
    }
    const r = await pty.typeText(
      text,
      { ...TYPE_TIMING, ...this.opts.typeTiming },
      o.whileWorking,
      o,
    );
    this.log(`send to ${id}: ${r}`);
    return r;
  }

  /** PERM-PROMPT: answer session `id`'s permission dialog about the call whose words are `match`
   *  (ChatPty.answerPermission). Like a send, through its open chat or an attach of its own. */
  async answerPermission(
    id: string,
    match: PermissionMatch,
    allow: boolean,
  ): Promise<PermissionAnswer> {
    // Nothing to match: no attach at all.
    if (!ID.test(id) || (Array.isArray(match) ? !match.length : !match.dialog.trim())) return 'failed';
    const pty = this.permissionPty(id);
    if (!pty) return 'failed';
    const r = await pty.answerPermission(match, allow, { ...TYPE_TIMING, ...this.opts.typeTiming });
    this.log(`permission ${allow ? 'allow' : 'deny'} in ${id}: ${r}`);
    return r;
  }

  /** PERM-PROMPT: the whole permission dialog on session `id`'s screen (ChatPty.readPermissionDialog),
   *  through its open chat or an attach of its own that ends after (~150 MB for a few seconds). */
  async readPermissionDialog(id: string): Promise<string | null> {
    if (!ID.test(id)) return null;
    const pty = this.permissionPty(id);
    const d = pty ? await pty.readPermissionDialog({ ...TYPE_TIMING, ...this.opts.typeTiming }) : null;
    this.log(`permission dialog in ${id}: ${d === null ? 'not read' : 'read'}`);
    return d;
  }

  private permissionPty(id: string): ChatPty | undefined {
    let pty = this.ptys.get(id);
    if (!pty) {
      pty = this.spawn(id, id, PERM_ATTACH_SIZE);
      if (pty) this.ptys.set(id, pty);
    }
    return pty;
  }

  /** A socket that passed the /ws gate asks for session `id`. */
  async join(id: string, socket: ChatSocket, device = 'web'): Promise<void> {
    // Hold input that arrives while the session is checked (the client sizes
    // the terminal right after the handshake).
    const early: string[] = [];
    let input: ((raw: string) => void) | null = null;
    socket.on('message', (raw) => (input ? input(raw.toString()) : early.push(raw.toString())));
    const refuse = (text: string, reason = 'refused') => {
      this.log(`refused ${JSON.stringify(id.slice(0, 64))} gui:${device}: ${text}`);
      notice(socket, text);
      socket.close(WS_CLOSE_NO_SESSION, reason);
    };
    const max = this.max;
    // Every request checks a fresh list, also to join an attach already open.
    // The cap is checked after it: a client switching chats closes the old
    // socket just before opening the new one.
    let found: ClaudeSession | string;
    try {
      found = attachable(ID.test(id) ? await this.list() : [], id, this.opts.home);
    } catch {
      found = CHAT_TEXT.listFailed;
    }
    if (socket.readyState !== WS_OPEN) return; // left while we looked
    if (typeof found === 'string') return refuse(found);
    let pty = this.ptys.get(id);
    if (!pty) {
      if (this.ptys.size >= max) return refuse(CHAT_TEXT.tooMany(max), CHAT_CAP_REASON);
      pty = this.spawn(id, found.name || id);
      if (!pty) return refuse(CHAT_TEXT.noPty);
      this.ptys.set(id, pty);
    }
    input = pty.add(socket, device);
    for (const raw of early) input(raw);
  }

  private spawn(
    id: string,
    name: string,
    size = { cols: TERMINAL_DEFAULT_COLS, rows: TERMINAL_DEFAULT_ROWS },
  ): ChatPty | undefined {
    let pty: IPty;
    try {
      this.opts.pty ??= loadPty();
      const env: Record<string, string> = { TERM: TERMINAL_TERM_NAME };
      for (const k of LOGIN_ENV) {
        const v = process.env[k];
        if (v !== undefined) env[k] = v;
      }
      // The provider's attach program (D4: Claude's `claude attach <id>`).
      const [file, ...args] = claudeAttachArgv(this.opts.claudePath, id);
      pty = this.opts.pty.spawn(file, args, {
        name: TERMINAL_TERM_NAME,
        cols: size.cols,
        rows: size.rows,
        cwd: os.homedir(),
        env: { ...env, ...this.opts.env },
      });
    } catch (err) {
      console.warn(`[cld] chat: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    const session = new PtySession(++this.serial, pty, size.cols, size.rows);
    const chat: ChatPty = new ChatPty(
      session,
      name,
      this.opts.idleMs ?? CHAT_IDLE_MS,
      (line) => this.log(line),
      () => {
        if (this.ptys.get(id) === chat) this.ptys.delete(id);
      },
    );
    return chat;
  }

  /** Shutdown: end every attach and give them the kill grace to exit. */
  async disposeAll(): Promise<void> {
    const chats = [...this.ptys.values()];
    if (!chats.length) return;
    const exited = chats.map((c) => new Promise<void>((r) => c.session.onExit(() => r())));
    for (const c of chats) c.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(exited),
      new Promise(
        (r) => (timer = setTimeout(r, TERMINAL_KILL_GRACE_MS + TERMINAL_SHUTDOWN_SLACK_MS)),
      ),
    ]);
    clearTimeout(timer);
  }
}

function validAttaches(n: unknown): n is number {
  return (
    typeof n === 'number' && Number.isInteger(n) && n >= CHAT_ATTACHES_MIN && n <= CHAT_ATTACHES_MAX
  );
}

/** node-pty, required at runtime: a native module esbuild must leave alone (see
 *  terminal/ptyModule.ts). No probe spawn: the daemon runs only `claude` here. */
export function loadPty(): PtyModule {
  const req: NodeRequire = require;
  return req(PTY_MODULE_CANDIDATES[0]) as PtyModule;
}

type RouteAuth = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * 설정's "동시에 붙일 에이전트 터미널" (T-0078): GET the cap and its range, PUT a
 * new one (1 to 4) that applies at once. Behind the same login as the chat
 * socket; a PUT also needs the page's own origin.
 */
export function registerChatSettingsRoutes(
  app: FastifyInstance,
  chat: ChatManager,
  auth: RouteAuth,
  sameOrigin: (request: FastifyRequest) => boolean,
): void {
  app.get('/api/chat-attaches', { preHandler: auth }, async () => ({
    attaches: chat.maxAttaches,
    default: chat.defaultAttaches,
    min: CHAT_ATTACHES_MIN,
    max: CHAT_ATTACHES_MAX,
    live: chat.size,
  }));
  app.put<{ Body: { attaches?: unknown } | undefined }>(
    '/api/chat-attaches',
    { preHandler: auth },
    async (request, reply) => {
      if (!sameOrigin(request)) return reply.code(403).send({ error: 'origin' });
      if (!chat.setMaxAttaches(request.body?.attaches))
        return reply
          .code(400)
          .send({ error: `${CHAT_ATTACHES_MIN}에서 ${CHAT_ATTACHES_MAX} 사이의 정수여야 해요` });
      return { attaches: chat.maxAttaches };
    },
  );
}

/** `/cld/attach/:id`. `reject` is the /ws gate: a close code and reason, or null.
 *  `bind` closes the socket when its login session is signed out (T-0022). */
export function registerChatRoute(
  app: FastifyInstance,
  chat: ChatManager,
  reject: (request: FastifyRequest) => readonly [number, string] | null,
  bind: (request: FastifyRequest, socket: ChatSocket) => () => void = () => () => undefined,
): void {
  app.get<{ Params: { id: string } }>(
    `${CHAT_WS_PREFIX}/:id`,
    { websocket: true },
    (socket: ChatSocket, request) => {
      const rejection = reject(request);
      if (rejection) {
        socket.close(rejection[0], rejection[1]);
        return;
      }
      const unbind = bind(request, socket);
      socket.on('close', unbind);
      chat
        .join(request.params.id, socket, deviceLabel(request.headers['user-agent']))
        .catch((err: unknown) => {
          console.warn(`[cld] chat: ${err instanceof Error ? err.message : String(err)}`);
          socket.close(WS_CLOSE_NO_SESSION, 'error');
        });
    },
  );
}
