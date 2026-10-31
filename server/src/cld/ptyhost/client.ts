/**
 * The daemon's side of our PTY host (ADR-0018): connect with the token, launch the host when
 * nobody listens and a terminal is to be spawned, requests and replies, subscriptions (snapshot,
 * then live), and the hosts' status and exit events. A lost connection fails what was pending
 * and ends the subscriptions (their viewers reconnect); the next request connects again, so a
 * daemon restart or a new host needs nothing else.
 */
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';

import { PTYHOST_CONNECT_MS, PTYHOST_REQUEST_MS, PTYHOST_SPAWN_MS } from '../../constants.js';
import type { ProgramStatus } from './programStatus.js';
import type { Op, TerminalInfo } from './protocol.js';
import { endpointFor, frame, lineReader, PTYHOST_VERSION, ptyhostPaths } from './protocol.js';

type Reply = Record<string, unknown> & { ok: boolean; error?: string };

export interface Subscription {
  snapshot: string;
  cols: number;
  rows: number;
  off(): void;
}

/** The host's folder (0700) and its token (0600), made when missing; returns the token. */
export function ensureToken(home: string): string {
  const p = ptyhostPaths(home);
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(p.dir, 0o700);
  try {
    return fs.readFileSync(p.token, 'utf-8').trim();
  } catch {
    const token = randomBytes(32).toString('hex');
    fs.writeFileSync(p.token, `${token}\n`, { mode: 0o600, flag: 'wx' });
    return token;
  }
}

export class PtyHostClient {
  private sock: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private serial = 0;
  private readonly pending = new Map<number, { done: (r: Reply) => void; timer: NodeJS.Timeout }>();
  private readonly subs = new Map<string, { data: (d: string) => void; end: () => void }>();
  /** OSC 7501 per terminal, as the host last reported it. */
  readonly status = new Map<string, ProgramStatus>();
  private readonly listeners = new Set<() => void>();
  /** The host process's pid, from its hello (the dev room's memory line). */
  pid: number | undefined;

  constructor(
    private readonly o: {
      home: string;
      /** Start a host process (detached); the client then waits for it to listen. */
      launch: () => void;
      log: (line: string) => void;
      connectMs?: number;
    },
  ) {}

  /** `cb` on a status change or a terminal's exit; returns the unsubscribe. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get connected(): boolean {
    return !!this.sock && !this.sock.destroyed;
  }

  /** Connected, launching a host first when `launch` and nobody listens. */
  connect(launch = false): Promise<void> {
    if (this.connected) return Promise.resolve();
    this.connecting ??= this.open(launch).finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async open(launch: boolean): Promise<void> {
    const p = ptyhostPaths(this.o.home);
    const token = ensureToken(this.o.home);
    const end = Date.now() + (this.o.connectMs ?? PTYHOST_CONNECT_MS);
    let launched = false;
    for (;;) {
      try {
        await this.attach(endpointFor(p.dir, token), token);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const absent = code === 'ENOENT' || code === 'ECONNREFUSED';
        if (!absent || !launch || Date.now() >= end) throw err;
        if (!launched) {
          launched = true;
          this.o.log('no PTY host listening; starting one');
          this.o.launch();
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    // After a daemon restart: what each terminal last reported.
    const r = await this.request('list');
    for (const t of (r.terminals as TerminalInfo[] | undefined) ?? [])
      if (t.status) this.status.set(t.id, t.status);
  }

  private attach(sockPath: string, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(sockPath);
      sock.once('error', reject);
      sock.once('connect', () => {
        sock.removeListener('error', reject);
        sock.on('error', () => undefined);
        this.sock = sock;
        sock.unref(); // never what keeps a daemon (or a test) from exiting
        sock.on('data', lineReader((m) => this.onMessage(m), () => sock.destroy()));
        sock.on('close', () => this.closed(sock));
        this.request('hello', { token, version: PTYHOST_VERSION }).then((r) => {
          if (typeof r.pid === 'number') this.pid = r.pid;
          return r.ok ? resolve() : reject(new Error(`PTY host: ${r.error ?? 'refused'}`));
        });
      });
    });
  }

  private closed(sock: net.Socket): void {
    if (this.sock !== sock) return;
    this.sock = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.done({ ok: false, error: 'PTY host connection closed' });
    }
    this.pending.clear();
    for (const s of this.subs.values()) s.end();
    this.subs.clear();
  }

  private onMessage(m: Record<string, unknown>): void {
    if (typeof m.r === 'number') {
      const p = this.pending.get(m.r);
      if (!p) return;
      this.pending.delete(m.r);
      clearTimeout(p.timer);
      p.done(m as Reply);
      return;
    }
    if (m.ev === 'data' && typeof m.s === 'string' && typeof m.d === 'string') this.subs.get(m.s)?.data(m.d);
    else if (m.ev === 'status' && typeof m.t === 'string') {
      this.status.set(m.t, { state: m.state as ProgramStatus['state'], ...(typeof m.kind === 'string' && { kind: m.kind }) });
      for (const cb of this.listeners) cb();
    } else if (m.ev === 'exit' && typeof m.t === 'string') {
      this.status.delete(m.t);
      for (const [s, sub] of this.subs)
        if (s.startsWith(`${m.t}.`)) {
          this.subs.delete(s);
          sub.end();
        }
      for (const cb of this.listeners) cb();
    }
  }

  /** One request on the open connection (connect() first); a failure is a reply with ok false. */
  request(op: Op, fields: Record<string, unknown> = {}, ms = PTYHOST_REQUEST_MS): Promise<Reply> {
    const sock = this.sock;
    if (!sock || sock.destroyed) return Promise.resolve({ ok: false, error: 'PTY host not connected' });
    const r = ++this.serial;
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.pending.delete(r);
        done({ ok: false, error: `PTY host: no answer to ${op}` });
      }, ms);
      timer.unref();
      this.pending.set(r, { done, timer });
      sock.write(frame({ r, op, ...fields }));
    });
  }

  /** Connect (never launching), then request. */
  async call(op: Op, fields: Record<string, unknown> = {}): Promise<Reply> {
    try {
      await this.connect(false);
    } catch {
      return { ok: false, error: 'PTY host not running' };
    }
    return this.request(op, fields);
  }

  async spawn(spec: {
    file: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    cols?: number;
    rows?: number;
    meta: Record<string, string>;
  }): Promise<Reply> {
    try {
      await this.connect(true);
    } catch (err) {
      return { ok: false, error: `PTY host: ${err instanceof Error ? err.message : String(err)}` };
    }
    // Windows: the host answers once ConPTY's input check decided (conpty.ts), not at once.
    return this.request('spawn', spec, PTYHOST_SPAWN_MS);
  }

  write(t: string, data: string): Promise<Reply> {
    return this.call('write', { t, data });
  }

  /** Output of terminal `t`: its screen now, then each chunk; `end` when it exits or the host goes. */
  async subscribe(t: string, data: (d: string) => void, end: () => void): Promise<Subscription | null> {
    try {
      await this.connect(false);
    } catch {
      return null;
    }
    // Listening before asking: the host's first output may come in the same read as its answer.
    const s = `${t}.${++this.serial}`;
    this.subs.set(s, { data, end });
    const r = await this.request('subscribe', { t, s });
    if (!r.ok) {
      this.subs.delete(s);
      return null;
    }
    return {
      snapshot: typeof r.snapshot === 'string' ? r.snapshot : '',
      cols: Number(r.cols),
      rows: Number(r.rows),
      off: () => {
        if (this.subs.delete(s)) void this.request('unsubscribe', { s });
      },
    };
  }

  /** How many of this daemon's subscriptions watch terminal `t` (its viewers). */
  viewers(t: string): number {
    let n = 0;
    for (const s of this.subs.keys()) if (s.startsWith(`${t}.`)) n++;
    return n;
  }

  dispose(): void {
    this.sock?.destroy();
  }
}
