/**
 * Our PTY host's wire (ADR-0018 decision 1): newline-delimited JSON over a local socket, one
 * object per line. Client -> host: requests `{r, op, ...}`; host -> client: replies
 * `{r, ok, error?, ...}` and events `{ev, ...}` (data per subscription `s`, exit and status per
 * terminal `t`). Where the host keeps its socket, token and terminal list: `ptyhostPaths`.
 */
import { createHash } from 'crypto';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';

import { configDir } from '../engine/events.js';
import type { ProgramStatus } from './programStatus.js';

export const PTYHOST_VERSION = 1;
/** A longer line is a broken or hostile peer: it is dropped. */
export const LINE_MAX = 8 * 1024 * 1024;

export type Op = 'hello' | 'spawn' | 'write' | 'resize' | 'subscribe' | 'unsubscribe' | 'kill' | 'list';

/** One terminal as the host lists it (and writes to terminals.json). */
export interface TerminalInfo {
  id: string;
  pid: number;
  cwd: string;
  startedAt: number;
  /** What the daemon attached at spawn (the assignment id): the host never reads it. */
  meta: Record<string, string>;
  status?: ProgramStatus;
}

export const frame = (o: object): string => `${JSON.stringify(o)}\n`;

/** Feed socket chunks, get whole objects. UTF-8 split across chunks is kept whole. */
export function lineReader(
  onMessage: (msg: Record<string, unknown>) => void,
  onTooLong: () => void,
): (chunk: Buffer) => void {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  return (chunk) => {
    buf += decoder.write(chunk);
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && typeof msg === 'object' && !Array.isArray(msg)) onMessage(msg as Record<string, unknown>);
    }
    if (buf.length > LINE_MAX) {
      buf = '';
      onTooLong();
    }
  };
}

/**
 * Where the host listens for the host folder `dir`: a socket file in it (Linux, macOS), or on
 * Windows a named pipe. A pipe has no folder to keep other users out, and anyone may create one
 * first under a name they can guess, then take the daemon's hello (its token) and spawns (agent
 * tokens in their env). So its name hashes the folder (case-insensitive, a temp HOME gets its own)
 * with the token, which lives in the user's profile: no other user can know it. The token is
 * also the host's gate, as for the socket.
 */
export function endpointFor(dir: string, token: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return path.join(dir, 'host.sock');
  const id = createHash('sha256').update(`${path.win32.resolve(dir).toLowerCase()}\n${token}`).digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\cld-gui-ptyhost-${id}`;
}

/** The host's folder (0700): its token (0600, the endpoint comes from it: endpointFor), terminal list and log. */
export function ptyhostPaths(home: string) {
  const dir = path.join(configDir(home), 'ptyhost');
  return {
    dir,
    token: path.join(dir, 'token'),
    terminals: path.join(dir, 'terminals.json'),
    log: path.join(dir, 'host.log'),
  };
}
