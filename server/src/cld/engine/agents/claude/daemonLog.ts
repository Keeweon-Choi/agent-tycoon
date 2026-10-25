/** Claude Code's daemon records background-session retirement here. */
import * as fs from 'fs';
import * as path from 'path';

/** Never read more than this much of a potentially long-lived daemon log. */
export const DAEMON_LOG_TAIL_BYTES = 256 * 1024;

export interface IdleRetire {
  /** The short hexadecimal id Claude wrote after `bg retire`. */
  id: string;
  reason: string;
  /** How long it sat idle: Claude 2.1.310 writes minutes (`idle 61m`), older builds hours (`idle 8h`). */
  minutes: number;
}

/**
 * The newest idle retirement for one of `ids`, if there is one. A daemon-log
 * line may have a timestamp before `bg retire`; only its end is significant.
 * A partial final line is deliberately not accepted as evidence of retirement.
 */
export function parseIdleRetire(text: string, ids: Array<string | undefined>): IdleRetire | null {
  const known = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (!known.length) return null;
  for (const line of text.split('\n').reverse()) {
    const match = /\bbg retire ([0-9a-f]+): ([^,\r\n]+), idle ([0-9]+)([mh])\r?$/i.exec(line);
    if (!match) continue;
    const [, id, reason, amount, unit] = match;
    if (!known.some((knownId) => knownId.toLowerCase().startsWith(id.toLowerCase()))) continue;
    return { id, reason, minutes: Number(amount) * (unit.toLowerCase() === 'h' ? 60 : 1) };
  }
  return null;
}

/** The tail of ~/.claude/daemon.log, or null when it cannot be inspected. */
export function readDaemonLogTail(home: string): string | null {
  const file = path.join(home, '.claude', 'daemon.log');
  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size;
    const length = Math.min(size, DAEMON_LOG_TAIL_BYTES);
    if (length === 0) return '';
    const buf = Buffer.alloc(length);
    fd = fs.openSync(file, 'r');
    const read = fs.readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf-8', 0, read);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
