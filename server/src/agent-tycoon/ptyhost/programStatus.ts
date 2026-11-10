/**
 * OSC 7501, the Program Status Protocol (https://www.superlogical.com/rex/docs/build/program-status):
 * Claude Code asks `ESC]7501;? BEL` right before DA1 (`ESC[c`), in one write, and reports
 * `state=idle|working|done|blocked:kind=…|clear` only to a terminal that answered the probe
 * first (ADR-0018 P0 c). Root records only; sub-records (`id=`) and `msg`/`title` are ignored.
 *
 * The probe reply is the one Orca sends (src/shared/program-status/protocol.ts,
 * PROGRAM_STATUS_QUERY_REPLY), Copyright (c) 2026 Lovecast Inc., MIT License: see
 * THIRD_PARTY_NOTICES.md.
 */
import type { IDisposable, Terminal } from '@xterm/headless';

export const OSC_PROGRAM_STATUS = 7501;
export const PROBE_REPLY =
  '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\';

const STATES = ['idle', 'working', 'done', 'blocked', 'error', 'clear'] as const;
export type ProgramState = (typeof STATES)[number];
export interface ProgramStatus {
  state: ProgramState;
  /** blocked only: permission | question | auth */
  kind?: string;
}

/** An OSC 7501 body: the probe, a root report, or null (ignored). */
export function parseProgramStatus(body: string): 'query' | ProgramStatus | null {
  if (body.length > 4096) return null;
  if (body.trim() === '?') return 'query';
  const pairs = new Map<string, string>();
  for (const pair of body.split(':')) {
    const eq = pair.indexOf('=');
    if (eq > 0) pairs.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  const state = pairs.get('state') as ProgramState | undefined;
  if (!state || !STATES.includes(state) || pairs.has('id')) return null;
  const kind = pairs.get('kind');
  return state === 'blocked' && kind && /^[a-z]{1,16}$/.test(kind) ? { state, kind } : { state };
}

/** Ready to type: idle or done (a turn ends with done). */
export const readyToType = (s: ProgramStatus | undefined): boolean =>
  s?.state === 'idle' || s?.state === 'done';

/**
 * Watch `term`'s OSC 7501: the probe is answered through `reply` inside the parse pass, so the
 * answer goes out before the DA1 answer the same chunk produces (onData fires later in it).
 */
export function watchProgramStatus(
  term: Terminal,
  reply: (data: string) => void,
  report: (s: ProgramStatus) => void,
): IDisposable {
  return term.parser.registerOscHandler(OSC_PROGRAM_STATUS, (body) => {
    const m = parseProgramStatus(body);
    if (m === 'query') reply(PROBE_REPLY);
    else if (m) report(m);
    return true;
  });
}
