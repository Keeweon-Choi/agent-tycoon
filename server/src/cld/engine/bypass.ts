/**
 * Answer Claude Code's one-time Bypass Permissions warning after a person selected that mode.
 *
 * Claude records this answer itself. We only run its interactive dialog in our PTY and press keys
 * after recognising the complete warning twice: initially with No focused, then with Yes focused.
 * Any other screen is left entirely untouched (including Ctrl+C); because this is our own PTY
 * child, it is killed after the bounded observation instead of being left behind.
 */
import { Terminal as HeadlessTerminal } from '@xterm/headless';

import { TERMINAL_TERM_NAME } from '../../constants.js';
import type { IPty, PtyModule } from '../../terminal/ptyModule.js';
import { loadPty, onScreen, screenTail } from '../chat.js';

export const BYPASS_TIMING = {
  appearMs: 20_000,
  settleMs: 800,
  moveMs: 2_000,
  pastMs: 10_000,
  exitMs: 5_000,
  ctrlCGapMs: 300,
  pollMs: 100,
};

export type BypassOutcome = 'accepted' | 'unknownScreen' | 'notMoved' | 'exited' | 'timeout' | 'noPty';
export type BypassStep = 'started' | 'dialog' | 'chose' | 'past' | 'closed' | 'killed';

export interface BypassResult {
  outcome: BypassOutcome;
  steps: BypassStep[];
}

export interface BypassOptions {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  timing?: Partial<typeof BYPASS_TIMING>;
  pty?: PtyModule;
  /** Ends our own hung child (tests pass a fake). */
  kill?: (p: IPty) => void;
}

export const BYPASS_ARGS = ['--dangerously-skip-permissions'];

const SIZE = { cols: 160, rows: 60 };
const DOWN = '\x1b[B';
const CTRL_C = '\x03';
const TITLE = 'WARNING: Claude Code running in Bypass Permissions mode';
const RESPONSIBILITY = 'By proceeding, you accept all responsibility';
// Claude's pointer: U+276F, or '>' where it falls back to ASCII (a Windows console, 10-28 photo).
const option = (label: string) => new RegExp(`^([❯>]\\s*)?(\\d+\\.\\s*)?${label}$`);
const pointed = (row: string): boolean => row.startsWith('❯') || row.startsWith('>');
const YES = option('Yes, I accept');
const NO = option('No, exit');

const rowText = (term: HeadlessTerminal, i: number): string => {
  const b = term.buffer.active;
  return (b.getLine(b.viewportY + i)?.translateToString() ?? '').replace(
    /^[\s│┃|]+|[\s│┃|]+$/g,
    '',
  );
};

/** null unless every fixed part of Claude 2.1.311's bypass warning is present as its own row. */
export function bypassDialog(term: HeadlessTerminal): { onYes: boolean; onNo: boolean } | null {
  if (!onScreen(term, TITLE) || !onScreen(term, RESPONSIBILITY)) return null;
  let yes: string | null = null;
  let no: string | null = null;
  for (let i = 0; i < term.rows; i++) {
    const r = rowText(term, i);
    if (YES.test(r)) yes = r;
    else if (NO.test(r)) no = r;
  }
  if (yes === null || no === null) return null;
  return { onYes: pointed(yes), onNo: pointed(no) };
}

export async function acceptBypass(o: BypassOptions): Promise<BypassResult> {
  const t = { ...BYPASS_TIMING, ...o.timing };
  const steps: BypassStep[] = [];
  const done = (outcome: BypassOutcome): BypassResult => {
    o.log(`bypass ${JSON.stringify(o.cwd)}: ${outcome}`);
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
      `bypass ${JSON.stringify(o.cwd)}: no PTY (${err instanceof Error ? err.message : String(err)})`,
    );
    return done('noPty');
  }
  const pid = child.pid;
  steps.push('started');
  o.log(`bypass ${JSON.stringify(o.cwd)}: started claude (pid ${pid})`);
  const screen = new HeadlessTerminal({ ...SIZE, scrollback: 0, allowProposedApi: true });
  let exited = false;
  let accepted = false;
  child.onData((d) => screen.write(d));
  child.onExit(() => (exited = true));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const flushed = () => new Promise<void>((r) => screen.write('', r));
  const until = async (ok: () => boolean, ms: number): Promise<boolean> => {
    for (const end = Date.now() + ms; ;) {
      await flushed();
      if (ok()) return true;
      if (exited || Date.now() >= end) return false;
      await sleep(t.pollMs);
    }
  };
  const answer = async (): Promise<BypassOutcome> => {
    if (!(await until(() => bypassDialog(screen) !== null, t.appearMs))) {
      if (exited) return 'exited';
      o.log(`bypass ${JSON.stringify(o.cwd)}: not the bypass warning: ${screenTail(screen)}`);
      return screenTail(screen) ? 'unknownScreen' : 'timeout';
    }
    steps.push('dialog');
    o.log(`bypass ${JSON.stringify(o.cwd)}: bypass warning shown`);
    await sleep(t.settleMs);
    await flushed();
    const first = bypassDialog(screen);
    // The warning must still be exact and explicitly focused on its safe default, No.
    if (!first) return exited ? 'exited' : 'unknownScreen';
    if (!first.onNo || first.onYes) return 'unknownScreen';
    child.write(DOWN);
    if (!(await until(() => {
      const d = bypassDialog(screen);
      return !!d && d.onYes && !d.onNo;
    }, t.moveMs)))
      return exited ? 'exited' : 'unknownScreen';
    // Same warning, re-read after Down, before sending Enter.
    const now = bypassDialog(screen);
    if (exited || !now || !now.onYes || now.onNo) return 'unknownScreen';
    child.write('\r');
    steps.push('chose');
    o.log(`bypass ${JSON.stringify(o.cwd)}: chose "Yes, I accept"`);
    if (!(await until(() => bypassDialog(screen) === null, t.pastMs)) || exited)
      return exited ? 'exited' : 'notMoved';
    accepted = true;
    steps.push('past');
    o.log(`bypass ${JSON.stringify(o.cwd)}: Claude moved past the warning`);
    await sleep(t.settleMs);
    return 'accepted';
  };
  let outcome: BypassOutcome;
  try {
    outcome = await answer();
  } finally {
    if (accepted && !exited) {
      child.write(CTRL_C);
      await sleep(t.ctrlCGapMs);
      if (!exited) child.write(CTRL_C);
      await until(() => exited, t.exitMs);
    }
    if (exited) {
      steps.push('closed');
    } else if (child.pid === pid) {
      o.log(`bypass ${JSON.stringify(o.cwd)}: claude (pid ${pid}) did not exit; killing it`);
      (o.kill ?? ((p: IPty) => p.kill()))(child);
      steps.push('killed');
    }
    screen.dispose();
  }
  return done(outcome);
}
