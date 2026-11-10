/**
 * TERM-P2 (ADR-0018): Windows ConPTY's startup check. The ConPTY that node-pty ships (conpty.dll,
 * spawned with `useConptyDll`) asks DA1 (or CPR) the moment it starts reading keyboard input,
 * before any of the program's output; a terminal that never asks never takes input. The host
 * waits for that question (at most PTYHOST_CONPTY_INPUT_MS) before it hands a terminal out, and
 * starts it again once when the first output rules the question out. Nothing was typed yet, so a
 * second `claude` repeats nothing.
 *
 * Adapted from Orca (src/main/daemon/pty-subprocess/conpty-startup-input-reader.ts: the
 * sequences, the classifier, the one respawn, and turning the check off when no terminal ever
 * asked), Copyright (c) 2026 Lovecast Inc., MIT License: see THIRD_PARTY_NOTICES.md.
 */
import { PTYHOST_CONPTY_INPUT_MS } from '../../constants.js';

// The question ConPTY asks once it reads input: DA1, or CPR when it inherits the cursor.
const ANNOUNCEMENTS = ['\x1b[c', '\x1b[6n'] as const;
// Its pseudo-window may report visibility first.
const VISIBILITY = ['\x1b[1t', '\x1b[2t'] as const;

export type Verdict = 'pending' | 'input-reader' | 'no-input-reader';
export type Outcome = Exclude<Verdict, 'pending'> | 'exited' | 'undecided';

/** What a terminal's output so far says; a chunk may end mid-sequence ('pending'). */
export function classifyConptyStartup(output: string): Verdict {
  let rest = output;
  for (let r = VISIBILITY.find((v) => rest.startsWith(v)); r; r = VISIBILITY.find((v) => rest.startsWith(v)))
    rest = rest.slice(r.length);
  if (ANNOUNCEMENTS.some((a) => rest.startsWith(a))) return 'input-reader';
  return [...ANNOUNCEMENTS, ...VISIBILITY].some((s) => s.startsWith(rest)) ? 'pending' : 'no-input-reader';
}

/** The slice of PtySession the check needs. */
export interface StartingTerminal {
  onData(cb: (d: string) => void): () => void;
  onExit(cb: () => void): () => void;
  dispose(): void;
}

/** The first output that decides, the exit before it, or 'undecided' after `ms`. */
export function conptyStartup(t: StartingTerminal, ms = PTYHOST_CONPTY_INPUT_MS): Promise<Outcome> {
  return new Promise((resolve) => {
    let out = '';
    const done = (o: Outcome) => {
      offData();
      offExit();
      clearTimeout(timer);
      resolve(o);
    };
    const offData = t.onData((d) => {
      out += d;
      const v = classifyConptyStartup(out);
      if (v !== 'pending') done(v);
    });
    const offExit = t.onExit(() => done('exited'));
    const timer = setTimeout(() => done('undecided'), ms);
    timer.unref?.();
  });
}

/** Process-wide, as in Orca: once a terminal asked, a silent one is broken, not a newer ConPTY. */
const trust = { observed: false, off: false };
export const resetConptyTrust = (): void => {
  trust.observed = false;
  trust.off = false;
};

/** `make()` once, again when its ConPTY reads no input; logs what it saw. */
export async function spawnWithInputReader<T extends StartingTerminal>(
  make: () => T,
  log: (line: string) => void,
  ms = PTYHOST_CONPTY_INPUT_MS,
): Promise<T> {
  const first = make();
  if (trust.off) return first;
  let v = await conptyStartup(first, ms);
  if (v === 'input-reader') trust.observed = true;
  if (v !== 'no-input-reader') return first;
  log('ConPTY started without an input reader; starting the terminal again');
  // Gone before its replacement starts: never two programs for one agent (bounded: a kill that
  // never reports its exit still lets the spawn answer).
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    first.onExit(() => {
      clearTimeout(timer);
      resolve();
    });
    first.dispose();
  });
  const again = make();
  v = await conptyStartup(again, ms);
  if (v === 'input-reader') trust.observed = true;
  else if (v === 'no-input-reader' && !trust.observed) {
    trust.off = true;
    log('ConPTY never asked for input on any terminal; startup check off');
  } else if (v === 'no-input-reader') log('ConPTY again started without an input reader: typing may not reach it');
  return again;
}
