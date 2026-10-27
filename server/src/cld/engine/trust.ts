/**
 * AUTO-TRUST: answer Claude Code's folder-trust question for a folder a person chose.
 *
 * Claude Code (2.1.310) has no command that trusts a folder: `--help` lists none, `-p` skips the
 * dialog without recording anything, and `claude --bg` refuses with "Workspace not trusted. Run
 * `claude` in <dir> once and accept the trust prompt, then retry". The answer is kept in Claude's
 * own ~/.claude.json, which Claude rewrites concurrently: never ours to write. So this runs Claude's
 * own dialog: an interactive `claude` in the folder, in our own PTY with the engine's environment
 * (the same command, clean env and PATH as `claude --bg`), reads the screen, and presses keys only
 * after re-reading that the trust question is still what is shown (the PERM-PROMPT way, chat.ts).
 *
 * Claude 2.1.310 draws it as "Accessing workspace:" ... "Quick safety check: ...", then the options
 * without numbers, "No, exit" first and focused, "Yes, I trust this folder" below it. Down, check
 * the pointer is on Yes, Enter, wait until the dialog is gone, then Ctrl+C twice (Claude's own
 * exit). A dialog that also lists what the folder pre-approves (tool rules, extra directories,
 * header helpers: "These will apply without asking") is left to the person, and so is any screen
 * not recognised: nothing is pressed. Bounded: every wait has a limit, and a child that does not
 * exit is killed (it is ours: the PTY's own child, whose exit we have not seen yet).
 */
import { Terminal as HeadlessTerminal } from '@xterm/headless';

import { TERMINAL_TERM_NAME } from '../../constants.js';
import type { IPty, PtyModule } from '../../terminal/ptyModule.js';
import { inputLineEmpty, loadPty, onScreen, screenTail } from '../chat.js';

export const TRUST_TIMING = {
  /** The first screen: Claude Code takes a few seconds to start. */
  appearMs: 20_000,
  /** The dialog stays up this long before a key goes in (Claude may ignore keys right at open). */
  settleMs: 800,
  /** The pointer reaches "Yes" after Down. */
  moveMs: 2_000,
  /** The dialog goes away after Enter. */
  pastMs: 10_000,
  /** The process ends after Ctrl+C twice. */
  exitMs: 5_000,
  ctrlCGapMs: 300,
  pollMs: 100,
};

export type TrustOutcome =
  /** The dialog was answered and Claude moved past it. */
  | 'trusted'
  /** No dialog: Claude's input line came up (the folder is trusted already). */
  | 'alreadyTrusted'
  /** The dialog lists what the folder pre-approves: the person reads that themselves. */
  | 'warnings'
  /** A screen that is not the trust question (nothing pressed). */
  | 'unknownScreen'
  /** Enter went in but the dialog stayed. */
  | 'notMoved'
  /** Claude ended before it moved past the dialog. */
  | 'exited'
  /** Nothing recognisable in time. */
  | 'timeout'
  /** No PTY here (node-pty missing or failing). */
  | 'noPty'
  /** The home folder: Claude keeps no trust answer for it (the engine does not try). */
  | 'homeDir';

/** What happened, in order: the CLI prints one line for each. */
export type TrustStep = 'started' | 'dialog' | 'chose' | 'past' | 'closed' | 'killed';

export interface TrustResult {
  outcome: TrustOutcome;
  steps: TrustStep[];
}

export interface TrustOptions {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  timing?: Partial<typeof TRUST_TIMING>;
  pty?: PtyModule;
  /** Ends our own hung child (tests pass a fake). */
  kill?: (p: IPty) => void;
}

/** For this one run: no hooks (no SessionStart reaching the daemon, no phantom character, none of
 *  the folder's own hooks) and no MCP servers. Claude 2.1.310 still asks and records the answer
 *  with them (checked against the real CLI, 10-25). */
export const TRUST_ARGS = ['--settings', '{"disableAllHooks":true}', '--strict-mcp-config'];

const SIZE = { cols: 160, rows: 60 };
const DOWN = '\x1b[B';
const CTRL_C = '\x03';
/** The dialog's title, as 2.1.310 draws it, and the older one. */
const TITLES = ['Accessing workspace:', 'Do you trust the files in this folder?'];
/** An option row: the box border and the pointer around it, an index in older versions. */
// Claude's pointer: U+276F, or '>' where it falls back to ASCII (a Windows console, 10-28 photo).
const option = (label: string) => new RegExp(`^([❯>]\\s*)?(\\d+\\.\\s*)?${label}$`);
const pointed = (row: string): boolean => row.startsWith('❯') || row.startsWith('>');
const YES = option('Yes, (?:I trust this folder|proceed)');
const NO = option('No, (?:exit|continue without these permissions)');
/** The part a person must read: what the folder's own settings approve without asking. */
const WARNINGS = [
  'These will apply without asking',
  'This folder pre-approves',
  'This folder adds',
  'This folder runs commands',
];

const rowText = (term: HeadlessTerminal, i: number): string => {
  const b = term.buffer.active;
  return (b.getLine(b.viewportY + i)?.translateToString() ?? '').replace(
    /^[\s│┃|]+|[\s│┃|]+$/g,
    '',
  );
};

/** The trust question on the screen: whether the pointer is on its "Yes" and whether it lists
 *  pre-approvals; null when the screen is anything else. */
export function trustDialog(term: HeadlessTerminal): { onYes: boolean; warnings: boolean } | null {
  if (!TITLES.some((t) => onScreen(term, t))) return null;
  let yes: string | null = null;
  let no = false;
  for (let i = 0; i < term.rows; i++) {
    const r = rowText(term, i);
    if (YES.test(r)) yes = r;
    else if (NO.test(r)) no = true;
  }
  if (yes === null || !no) return null;
  return { onYes: pointed(yes), warnings: WARNINGS.some((w) => onScreen(term, w)) };
}

export async function trustFolder(o: TrustOptions): Promise<TrustResult> {
  const t = { ...TRUST_TIMING, ...o.timing };
  const steps: TrustStep[] = [];
  const done = (outcome: TrustOutcome): TrustResult => {
    o.log(`trust ${JSON.stringify(o.cwd)}: ${outcome}`);
    return { outcome, steps };
  };
  let child: IPty;
  try {
    const env: Record<string, string> = { TERM: TERMINAL_TERM_NAME };
    for (const [k, v] of Object.entries(o.env)) if (v !== undefined) env[k] = v;
    child = (o.pty ?? loadPty()).spawn(o.file, o.args, {
      name: TERMINAL_TERM_NAME,
      ...SIZE,
      cwd: o.cwd,
      env,
    });
  } catch (err) {
    o.log(
      `trust ${JSON.stringify(o.cwd)}: no PTY (${err instanceof Error ? err.message : String(err)})`,
    );
    return done('noPty');
  }
  const pid = child.pid;
  steps.push('started');
  o.log(`trust ${JSON.stringify(o.cwd)}: started claude (pid ${pid})`);
  const screen = new HeadlessTerminal({ ...SIZE, scrollback: 0, allowProposedApi: true });
  let exited = false;
  child.onData((d) => screen.write(d));
  child.onExit(() => (exited = true));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // The screen is read after xterm has parsed what came in so far.
  const flushed = () => new Promise<void>((r) => screen.write('', r));
  const until = async (ok: () => boolean, ms: number): Promise<boolean> => {
    for (const end = Date.now() + ms; ;) {
      await flushed();
      if (ok()) return true;
      if (exited || Date.now() >= end) return false;
      await sleep(t.pollMs);
    }
  };
  const answer = async (): Promise<TrustOutcome> => {
    const prompt = () => inputLineEmpty(screen, true);
    if (!(await until(() => trustDialog(screen) !== null || prompt(), t.appearMs))) {
      if (exited) return 'exited';
      o.log(`trust ${JSON.stringify(o.cwd)}: not the trust question: ${screenTail(screen)}`);
      return screenTail(screen) ? 'unknownScreen' : 'timeout';
    }
    if (!trustDialog(screen)) return 'alreadyTrusted';
    steps.push('dialog');
    o.log(`trust ${JSON.stringify(o.cwd)}: trust question shown`);
    await sleep(t.settleMs);
    await flushed();
    const d = trustDialog(screen);
    if (!d) return exited ? 'exited' : 'unknownScreen';
    if (d.warnings) return 'warnings';
    if (!d.onYes) {
      child.write(DOWN);
      if (!(await until(() => trustDialog(screen)?.onYes === true, t.moveMs)))
        return exited ? 'exited' : 'unknownScreen';
    }
    // Checked and pressed in one synchronous step: the same question, the pointer on Yes.
    const now = trustDialog(screen);
    if (exited || !now || !now.onYes || now.warnings) return 'unknownScreen';
    child.write('\r');
    steps.push('chose');
    o.log(`trust ${JSON.stringify(o.cwd)}: chose "Yes, I trust this folder"`);
    if (!(await until(() => trustDialog(screen) === null, t.pastMs)) || exited)
      return exited ? 'exited' : 'notMoved';
    steps.push('past');
    o.log(`trust ${JSON.stringify(o.cwd)}: Claude moved past the question`);
    // Claude records the answer before it draws the next screen; a moment more costs nothing.
    await sleep(t.settleMs);
    return 'trusted';
  };
  let outcome: TrustOutcome;
  try {
    outcome = await answer();
  } finally {
    // End it: Claude's own exit (Ctrl+C twice) first; our own child killed only if it hangs.
    if (!exited) {
      child.write(CTRL_C);
      await sleep(t.ctrlCGapMs);
      if (!exited) child.write(CTRL_C);
      await until(() => exited, t.exitMs);
    }
    if (exited) {
      steps.push('closed');
    } else if (child.pid === pid) {
      // Ours: the PTY's own child, whose exit node-pty has not reported, so its pid is not reused.
      o.log(`trust ${JSON.stringify(o.cwd)}: claude (pid ${pid}) did not exit; killing it`);
      (o.kill ?? ((p: IPty) => p.kill()))(child);
      steps.push('killed');
    }
    screen.dispose();
  }
  return done(outcome);
}
