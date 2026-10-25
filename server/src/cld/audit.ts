/**
 * O3: the security record. One JSON line per security event -- a device came
 * in, an invitation was made or used, a device was signed out, a step-up
 * passed or failed, an exposure widened, a lockout -- appended to
 * `<config dir>/audit.jsonl` (0600) and never rewritten. At AUDIT_MAX_BYTES
 * the file moves to `audit.jsonl.1` (one old file kept) and a new one starts.
 *
 * Never a secret: callers hand over ids, labels and fixed words only; labels
 * are masked and cut to 60 characters here, and nothing else a client sent
 * gets in. A write that fails is logged once and never fails the request
 * that caused it.
 */
import * as fs from 'fs';
import * as path from 'path';

import { maskText } from './mask.js';

export const AUDIT_FILE = 'audit.jsonl';
export const AUDIT_MAX_BYTES = 1024 * 1024;
/** Failed step-ups of one device inside this window are one line with a count. */
export const AUDIT_STEPUP_WINDOW_MS = 60_000;
/** Lines the security panel shows per page. */
export const AUDIT_PAGE = 50;
const LABEL_MAX = 60;

export type AuditKind =
  | 'deviceRegistered' // detail: new | replaced | passkey | unknown
  | 'inviteCreated'
  | 'inviteUsed' // detail: qr | short
  | 'inviteRefused' // detail: expired | cancelled
  | 'deviceRevoked'
  | 'revokeOthers' // detail: how many
  | 'passkeyRemoved'
  | 'passkeyRequired' // detail: on | off (by: host -- the host token's last-resort turn-off)
  | 'loginCodeCreated' // the host's login code; detail: link | qr | short
  | 'loginCodeUsed' // detail: link | qr | short | move
  | 'moveCodeCreated' // O5; detail: manual | auto
  | 'moveRefused' // O5, an automatic move; detail: target | changed | key
  | 'handoffCodeCreated' // S3/O5: a Home-Screen app code; detail: the issuing page's origin
  | 'approvalAnswered' // detail: approved | refused
  | 'stepUpPassed' // detail: key | passkey
  | 'stepUpFailed' // detail: how many in the window
  | 'exposure' // detail: "<what> on|off"
  | 'connector' // detail: "<from>><to>"
  | 'allowedHosts' // detail: how many names are allowed now
  | 'tokenRotated' // detail: host | path
  | 'lockout'; // detail: short | direct

export type Via = 'local' | 'lan' | 'remote';

/** The device an event is about. */
export interface AuditDevice {
  id: string;
  label: string;
  kind?: string;
}

/** Who did it and how the request came in. */
export interface AuditContext {
  /** The acting device's label, or `host` (the local CLI / the host token). */
  by?: string;
  via?: Via;
  peer?: string;
}

export interface AuditLine {
  v: 1;
  at: number;
  kind: AuditKind;
  device?: AuditDevice;
  by?: string;
  via?: Via;
  peer?: string;
  detail?: string | number;
}

export type AuditEvent = AuditContext & {
  kind: AuditKind;
  device?: AuditDevice;
  detail?: string | number;
  at?: number;
};

/** A name a client or owner chose, as the record keeps it: masked, one line, at most 60 characters. */
export function cleanAuditText(raw: string): string {
  return [...maskText(raw).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim()]
    .slice(0, LABEL_MAX)
    .join('');
}

const VIAS = new Set<string>(['local', 'lan', 'remote']);

function clean(event: AuditEvent): AuditLine {
  const { kind, device, detail, by, via, peer, at } = event;
  return {
    v: 1,
    at: at ?? Date.now(),
    kind,
    ...(device
      ? {
          device: {
            id: cleanAuditText(device.id),
            label: cleanAuditText(device.label),
            ...(device.kind ? { kind: cleanAuditText(device.kind) } : {}),
          },
        }
      : {}),
    ...(by ? { by: cleanAuditText(by) } : {}),
    ...(via && VIAS.has(via) ? { via } : {}),
    ...(peer ? { peer: cleanAuditText(peer.replace(/^listener:/, '')) } : {}),
    ...(detail !== undefined
      ? { detail: typeof detail === 'number' ? detail : cleanAuditText(detail) }
      : {}),
  };
}

interface FailedStepUps {
  event: AuditEvent;
  count: number;
  timer: NodeJS.Timeout;
}

/** Logs with failed step-ups still counting; flushed once at exit so a count is not lost. */
const pending = new Set<AuditLog>();
process.once('exit', () => {
  for (const log of pending) log.flush();
});

export class AuditLog {
  readonly file: string | undefined;
  private warned = false;
  /** Both files are 0600 (a file made by an earlier version or by hand may not be): checked once per process. */
  private modeChecked = false;
  private readonly failed = new Map<string, FailedStepUps>();

  /** No directory: nothing is written or read (a daemon without a config dir). */
  constructor(dir?: string) {
    this.file = dir ? path.join(dir, AUDIT_FILE) : undefined;
  }

  write(event: AuditEvent): void {
    if (!this.file) return;
    const text = `${JSON.stringify(clean(event))}\n`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      this.rotate(Buffer.byteLength(text));
      fs.appendFileSync(this.file, text, { mode: 0o600 });
      if (!this.modeChecked) {
        this.modeChecked = true;
        for (const file of [this.file, `${this.file}.1`])
          try {
            fs.chmodSync(file, 0o600);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }
      }
    } catch (err) {
      if (this.warned) return;
      this.warned = true;
      console.warn(`[cld audit] could not write ${this.file}: ${String(err)}`);
    }
  }

  /**
   * A failed step-up: the first of a window starts it, the rest only count;
   * one line per device per window, written when the window ends (or at flush).
   */
  stepUpFailed(device: AuditDevice, context: AuditContext): void {
    if (!this.file) return;
    const open = this.failed.get(device.id);
    if (open) {
      open.count++;
      return;
    }
    const timer = setTimeout(() => this.flushOne(device.id), AUDIT_STEPUP_WINDOW_MS);
    timer.unref();
    this.failed.set(device.id, {
      event: { kind: 'stepUpFailed', device, ...context },
      count: 1,
      timer,
    });
    pending.add(this);
  }

  /** Write the failed step-ups still counting. */
  flush(): void {
    for (const id of [...this.failed.keys()]) this.flushOne(id);
  }

  private flushOne(id: string): void {
    const open = this.failed.get(id);
    if (!open) return;
    clearTimeout(open.timer);
    this.failed.delete(id);
    if (this.failed.size === 0) pending.delete(this);
    this.write({ ...open.event, detail: open.count });
  }

  private rotate(incoming: number): void {
    const file = this.file!;
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // none yet
    }
    if (size + incoming <= AUDIT_MAX_BYTES) return;
    fs.rmSync(`${file}.1`, { force: true });
    fs.renameSync(file, `${file}.1`);
    fs.chmodSync(`${file}.1`, 0o600);
  }

  /**
   * The newest lines first: `skip` lines from the newest, at most `limit`.
   * A line that does not parse is skipped. `total` counts the good ones.
   * `since`: the total a first page saw; lines written after it are skipped
   * over too, so the next page continues where the first one ended.
   */
  read(skip: number, limit: number, since?: number): { lines: AuditLine[]; total: number } {
    if (!this.file) return { lines: [], total: 0 };
    const all: AuditLine[] = [];
    for (const file of [`${this.file}.1`, this.file]) {
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        const parsed = parseLine(line);
        if (parsed) all.push(parsed);
      }
    }
    const newest = all.reverse();
    const from = skip + (since === undefined ? 0 : Math.max(0, all.length - since));
    return { lines: newest.slice(from, from + limit), total: all.length };
  }
}

function parseLine(line: string): AuditLine | null {
  if (!line) return null;
  try {
    const value = JSON.parse(line) as Partial<AuditLine> | null;
    return value && value.v === 1 && Number.isFinite(value.at) && typeof value.kind === 'string'
      ? (value as AuditLine)
      : null;
  } catch {
    return null;
  }
}

const logs = new Map<string, AuditLog>();
/** The one log of a config dir (the daemon writes from several places). */
export function auditLog(dir: string | undefined): AuditLog {
  if (!dir) return new AuditLog();
  let log = logs.get(dir);
  if (!log) logs.set(dir, (log = new AuditLog(dir)));
  return log;
}
