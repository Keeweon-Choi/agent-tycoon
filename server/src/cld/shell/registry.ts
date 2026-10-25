import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ShellNotice } from '../../../../core/src/messages.js';
import {
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
  TERMINAL_KILL_GRACE_MS,
  TERMINAL_SHUTDOWN_SLACK_MS,
} from '../../constants.js';
import { type PtySession, PtySessionManager } from '../../terminal/ptySessionManager.js';
import { LOGIN_ENV } from '../chat.js';
import { readJson, writeJsonAtomic } from '../jsonFile.js';
import { findTmux, Tmux } from './tmux.js';

export const SHELL_IDLE_MS = 30 * 60_000;
/** Said in the terminal when there is no tmux: the shell ends with the daemon. */
export const NO_TMUX_NOTICE = '이 PC에는 tmux가 없어 배포하면 터미널이 끊겨요';
/** Test seam (the browser runner's negative control): `off` runs shells without tmux, as before T-0069. */
export const SHELL_PERSIST_ENV = 'CLD_GUI_SHELL_PERSIST';
/** Our own ids: 18 random bytes, base64url. Anything else in shells.json is not ours. */
const SHELL_ID = /^[A-Za-z0-9_-]{16,64}$/;
/** A re-attach after the tmux client died while its session lives, before giving up. */
const MAX_REATTACH = 3;
/** lastActivity reaches disk this long after it changes. */
const FLUSH_MS = 60_000;

export interface ShellView {
  id: string;
  deviceId: string;
  label: string;
  cwd: string;
  openedAt: number;
}

/** One line of shells.json. */
interface PersistedShell extends ShellView {
  sessionHandle: string;
  lastActivity: number;
}

interface ShellEntry extends PersistedShell {
  /** The daemon's PTY: a tmux client, or the shell itself without tmux. */
  pty: PtySession;
  ptyId: number;
  /** Runs in our tmux server: survives the daemon. */
  backed: boolean;
  reattaches: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface ShellExtras {
  /** Absent: shells are plain PTYs (tests, a machine without tmux). */
  tmux?: Tmux | null;
  /** shells.json (0600): the open shells, to find them after a restart. */
  file?: string;
}

/** Owns only shells created by the shell API; no upstream agent PTY is shared. */
export class ShellRegistry {
  private readonly shells = new Map<string, ShellEntry>();
  private readonly closeListeners = new Map<string, Set<(reason: string) => void>>();
  private nextPtyId = 1;
  private readonly tmux: Tmux | null;
  private readonly file: string | undefined;
  private shuttingDown = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly manager = new PtySessionManager(),
    private readonly broadcast: (notice: ShellNotice) => void = () => undefined,
    private readonly now = Date.now,
    private readonly idleMs = SHELL_IDLE_MS,
    extras: ShellExtras = {},
  ) {
    this.tmux = extras.tmux ?? null;
    this.file = extras.file;
  }

  /** The line a client is told on attach when the shell is not in tmux. */
  noticeFor(id: string): string | undefined {
    const entry = this.shells.get(id);
    return entry && !entry.backed ? NO_TMUX_NOTICE : undefined;
  }

  count(deviceId: string): number {
    return this.list().filter((shell) => shell.deviceId === deviceId).length;
  }

  list(): ShellView[] {
    return [...this.shells.values()].map(({ id, deviceId, label, cwd, openedAt }) => ({
      id,
      deviceId,
      label,
      cwd,
      openedAt,
    }));
  }

  get(id: string): PtySession | undefined {
    return this.shells.get(id)?.pty;
  }

  /** `listener(reason)` runs when the shell closes: 'exit' (it ended itself), 'idle', 'requested', 'revoked'. */
  onClose(id: string, listener: (reason: string) => void): () => void {
    const listeners = this.closeListeners.get(id) ?? new Set();
    listeners.add(listener);
    this.closeListeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.closeListeners.delete(id);
    };
  }

  ownedBy(id: string, deviceId: string, sessionHandle: string): boolean {
    const entry = this.shells.get(id);
    return !!entry && entry.deviceId === deviceId && entry.sessionHandle === sessionHandle;
  }

  /** Synchronous so a concurrent open cannot pass the cap before it is recorded. */
  open(deviceId: string, sessionHandle: string, label: string, cwd: string): ShellView {
    const id = crypto.randomBytes(18).toString('base64url');
    const command = loginShell();
    const env = loginEnv();
    let backed = false;
    if (this.tmux) {
      backed = this.tmux.newSession(id, {
        cols: TERMINAL_DEFAULT_COLS,
        rows: TERMINAL_DEFAULT_ROWS,
        cwd,
        command: command.file,
        args: command.args,
        env,
      });
      if (!backed) this.tmux.killSession(id); // half made
      if (!backed)
        console.warn('[cld shell] tmux would not start a session: a plain shell instead');
    }
    const at = this.now();
    const entry = {
      id,
      deviceId,
      sessionHandle,
      label,
      cwd,
      openedAt: at,
      lastActivity: at,
      backed,
      reattaches: 0,
      timer: setTimeout(() => this.close(id, 'idle'), this.idleMs),
    } as ShellEntry;
    entry.timer.unref?.();
    try {
      this.attach(entry);
    } catch (err) {
      clearTimeout(entry.timer);
      if (backed) this.tmux?.killSession(id);
      throw err;
    }
    this.shells.set(id, entry);
    this.persist();
    this.audit('open', entry);
    return { id, deviceId, label, cwd, openedAt: entry.openedAt };
  }

  /** The PTY the daemon holds for `entry`: the tmux client, or the shell itself. */
  private attach(entry: ShellEntry): void {
    const login = loginShell();
    const run =
      entry.backed && this.tmux
        ? this.tmux.attachCommand(entry.id)
        : { file: login.file, args: login.args };
    const ptyId = this.nextPtyId++;
    const pty = this.manager.create({
      agentId: ptyId,
      command: run.file,
      args: run.args,
      cwd: entry.cwd,
      env: loginEnv(),
      replaceEnv: true,
    });
    entry.pty = pty;
    entry.ptyId = ptyId;
    pty.onData(() => {
      entry.reattaches = 0;
      this.touch(entry.id);
    });
    pty.onExit(() => this.exited(entry, pty));
  }

  private exited(entry: ShellEntry, pty: PtySession): void {
    if (this.shuttingDown || this.shells.get(entry.id) !== entry || entry.pty !== pty) return;
    // The tmux client died but the shell is still there (the client was killed
    // from outside): attach again before calling the shell ended.
    if (entry.backed && entry.reattaches < MAX_REATTACH && this.tmux?.hasSession(entry.id)) {
      entry.reattaches++;
      try {
        this.attach(entry);
        return;
      } catch {
        /* closed below */
      }
    }
    this.close(entry.id, 'exit');
  }

  touch(id: string): void {
    const entry = this.shells.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.close(id, 'idle'), this.idleMs);
    entry.timer.unref?.();
    entry.lastActivity = this.now();
    this.flushLater();
  }

  /** `by`: the device that pressed 닫기 (audit only). */
  close(id: string, reason = 'requested', by?: string): boolean {
    const entry = this.shells.get(id);
    if (!entry) return false;
    this.shells.delete(id);
    clearTimeout(entry.timer);
    if (entry.backed) this.tmux?.killSession(id);
    for (const listener of this.closeListeners.get(id) ?? []) listener(reason);
    this.closeListeners.delete(id);
    this.manager.dispose(entry.ptyId);
    this.persist();
    this.audit('close', entry, by === undefined ? reason : `${reason} by=${JSON.stringify(by)}`);
    return true;
  }

  closeForRow(rowId: string): void {
    for (const entry of [...this.shells.values()])
      if (entry.deviceId === rowId || entry.sessionHandle === rowId)
        this.close(entry.id, 'revoked');
  }

  /**
   * After a restart: the shells of shells.json whose tmux session is still
   * there come back (the daemon's PTY attaches again, ownership as before);
   * the rest are dropped from the file, and a session idle past its time is
   * killed. Returns how many came back.
   */
  restore(): number {
    if (!this.tmux || !this.file) return 0;
    let saved: unknown = null;
    try {
      saved = readJson(this.file);
    } catch (err) {
      console.warn(
        `[cld shell] shells.json unreadable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const live = this.tmux.sessions();
    let kept = 0;
    for (const row of parseShells(saved)) {
      if (!live.has(row.id) || this.shells.has(row.id)) continue;
      const left = this.idleMs - (this.now() - row.lastActivity);
      if (left <= 0) {
        this.tmux.killSession(row.id);
        console.log(
          `[cld shell] close device=${JSON.stringify(row.label)} id=${row.id} reason=idle`,
        );
        continue;
      }
      const entry = {
        ...row,
        backed: true,
        reattaches: 0,
        timer: setTimeout(() => this.close(row.id, 'idle'), left),
      } as ShellEntry;
      entry.timer.unref?.();
      try {
        this.attach(entry);
      } catch (err) {
        clearTimeout(entry.timer);
        console.warn(
          `[cld shell] could not attach ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      this.shells.set(row.id, entry);
      kept++;
      console.log(
        `[cld shell] restored device=${JSON.stringify(row.label)} cwd=${JSON.stringify(row.cwd)} id=${row.id}`,
      );
    }
    this.persist();
    return kept;
  }

  /**
   * Shutdown. Shells in tmux keep running: only the daemon's attach goes
   * (their sockets just drop, and the clients attach again after the restart).
   * Plain shells end with it.
   */
  async disposeAll(): Promise<void> {
    this.flushNow();
    this.shuttingDown = true;
    const exited = [...this.shells.values()].map(
      (entry) => new Promise<void>((resolve) => entry.pty.onExit(() => resolve())),
    );
    for (const entry of [...this.shells.values()]) {
      clearTimeout(entry.timer);
      if (entry.backed) this.manager.dispose(entry.ptyId);
      else this.close(entry.id, 'shutdown');
    }
    if (!exited.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(exited),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, TERMINAL_KILL_GRACE_MS + TERMINAL_SHUTDOWN_SLACK_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  private snapshot(): PersistedShell[] {
    return [...this.shells.values()]
      .filter((e) => e.backed)
      .map(({ id, deviceId, sessionHandle, label, cwd, openedAt, lastActivity }) => ({
        id,
        deviceId,
        sessionHandle,
        label,
        cwd,
        openedAt,
        lastActivity,
      }));
  }

  private persist(): void {
    if (!this.tmux || !this.file || this.shuttingDown) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    try {
      writeJsonAtomic(this.file, { version: 1, shells: this.snapshot() });
    } catch (err) {
      console.warn(
        `[cld shell] could not write shells.json: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private flushLater(): void {
    if (this.flushTimer || !this.file) return;
    this.flushTimer = setTimeout(() => this.persist(), FLUSH_MS);
    this.flushTimer.unref?.();
  }

  private flushNow(): void {
    if (this.flushTimer) this.persist();
  }

  /**
   * The audit line and the notice. Device label, row, folder and shell id
   * only: never a byte of input or output (T18).
   */
  private audit(action: 'open' | 'close', entry: ShellEntry, reason?: string): void {
    console.log(
      `[cld shell] ${action} device=${JSON.stringify(entry.label)} row=${entry.deviceId} cwd=${JSON.stringify(entry.cwd)} id=${entry.id}${reason ? ` reason=${reason}` : ''}`,
    );
    this.broadcast({
      type: 'shellNotice',
      action,
      id: entry.id,
      deviceId: entry.deviceId,
      label: entry.label,
      at: this.now(),
    });
  }
}

/** The shell registry of this host: tmux when there is one (and persistence is not switched off). */
export function hostShellRegistry(broadcast: (notice: ShellNotice) => void): ShellRegistry {
  const home = os.homedir();
  const bin = process.env[SHELL_PERSIST_ENV] === 'off' ? null : findTmux(process.env, home);
  if (!bin) console.log('[cld shell] no tmux: shells end with the daemon');
  return new ShellRegistry(undefined, broadcast, Date.now, SHELL_IDLE_MS, {
    tmux: bin ? new Tmux(bin) : null,
    file: path.join(home, '.config', 'cld-gui', 'shells.json'),
  });
}

/** shells.json's rows that have every field of one of ours; anything else is dropped. */
function parseShells(value: unknown): PersistedShell[] {
  const rows = (value as { shells?: unknown } | null)?.shells;
  if (!Array.isArray(rows)) return [];
  const text = (v: unknown): v is string =>
    typeof v === 'string' && v.length > 0 && v.length < 4096;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const out: PersistedShell[] = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    if (
      r &&
      typeof r.id === 'string' &&
      SHELL_ID.test(r.id) &&
      text(r.deviceId) &&
      text(r.sessionHandle) &&
      typeof r.label === 'string' &&
      text(r.cwd) &&
      num(r.openedAt) &&
      num(r.lastActivity)
    )
      out.push({
        id: r.id,
        deviceId: r.deviceId,
        sessionHandle: r.sessionHandle,
        label: r.label.slice(0, 200),
        cwd: r.cwd,
        openedAt: r.openedAt,
        lastActivity: r.lastActivity,
      });
  }
  return out;
}

/** A login's basics only, like `claude attach` (ADR-0009 8, T22): none of
 *  the service's own environment reaches the shell or what it starts. */
function loginEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of LOGIN_ENV)
    if (process.env[key] !== undefined) env[key] = process.env[key] as string;
  return env;
}

/** A login shell for the daemon's own OS user; no client-supplied command. */
function loginShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec || 'cmd.exe', args: [] };
  }
  const requested = process.env.SHELL;
  const file =
    requested && requested.startsWith('/') && fs.existsSync(requested) ? requested : '/bin/sh';
  return { file, args: ['-l'] };
}
