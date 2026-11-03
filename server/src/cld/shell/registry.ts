/**
 * Trusted-device shells (T-0069, T-0078). Each shell is a terminal of our PTY host (ADR-0018),
 * marked `meta.kind: 'shell'` so the engine never takes it for an agent: it outlives a deploy
 * (the daemon restarting) the way agents do, on every OS, and the daemon finds it again from
 * shells.json joined to the host's terminals.json. The registry keeps one subscription per shell
 * (output is activity, the end is its exit); each viewer gets its own (snapshot, then live).
 * Without a host (a server built by a test, a build with no host script) a shell is a plain PTY
 * in the daemon and ends with it.
 */
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
import { loginEnvFrom } from '../chat.js';
import { configDirectory } from '../configPath.js';
import { readJson, writeJsonAtomic } from '../jsonFile.js';
import { processAlive } from '../providers/claudeProvider.js';
import { listedTerminals, type PtyHostClient, type Subscription } from '../ptyhost/client.js';
import { isShellTerminal, SHELL_KIND } from '../ptyhost/protocol.js';
import { findTmux, Tmux } from './tmux.js';

export const SHELL_IDLE_MS = 30 * 60_000;
/** Our own ids: 18 random bytes, base64url. Anything else in shells.json is not ours. */
const SHELL_ID = /^[A-Za-z0-9_-]{16,64}$/;
/** The host's terminal ids (protocol.ts: 4 random bytes, hex). */
const TERMINAL_ID = /^[0-9a-f]{8}$/;
/** Watching (or a legacy tmux client) again after it dropped while the shell lives, before giving up. */
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

/** One line of shells.json. `terminal`: the host's; absent on a row a tmux version wrote. */
interface PersistedShell extends ShellView {
  sessionHandle: string;
  lastActivity: number;
  terminal?: string;
}

/** host: a host terminal. tmux: a shell an older version left in tmux (one release). plain: a daemon PTY. */
type Backing = 'host' | 'tmux' | 'plain';

interface ShellEntry extends PersistedShell {
  backing: Backing;
  /** tmux and plain: the daemon's PTY (a tmux client, or the shell itself). */
  pty?: PtySession;
  ptyId?: number;
  /** host: the registry's own subscription. */
  watch?: Subscription;
  exitCode?: number;
  reattaches: number;
  timer: ReturnType<typeof setTimeout>;
}

/** A viewer's view of one shell: its screen now, then live output (to the callback given to join). */
export interface ShellStream {
  snapshot: string;
  cols: number;
  rows: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  off(): void;
}

export interface ShellExtras {
  /** Our PTY host. Absent: shells are plain PTYs that end with the daemon. */
  host?: PtyHostClient | null;
  /** shells.json (0600): the open shells, to find them after a restart. */
  file?: string;
  /** ponytail: one release only. The tmux of shells a version before the PTY host left; looked up only at restore. */
  legacyTmux?: () => Tmux | null;
}

/** Owns only shells created by the shell API; agent terminals in the same host are not its. */
export class ShellRegistry {
  private readonly shells = new Map<string, ShellEntry>();
  private readonly closeListeners = new Map<string, Set<(reason: string, exitCode?: number) => void>>();
  private nextPtyId = 1;
  private readonly host: PtyHostClient | null;
  private readonly file: string | undefined;
  private readonly legacyTmux: () => Tmux | null;
  private tmux: Tmux | null = null;
  private shuttingDown = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly manager = new PtySessionManager(),
    private readonly broadcast: (notice: ShellNotice) => void = () => undefined,
    private readonly now = Date.now,
    private readonly idleMs = SHELL_IDLE_MS,
    extras: ShellExtras = {},
  ) {
    this.host = extras.host ?? null;
    this.file = extras.file;
    this.legacyTmux = extras.legacyTmux ?? (() => null);
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

  /** `listener(reason, exitCode)` runs when the shell closes: 'exit' (it ended itself, with its code), 'idle', 'requested', 'revoked'. */
  onClose(id: string, listener: (reason: string, exitCode?: number) => void): () => void {
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

  /** Recorded before anything awaits, so a concurrent open cannot pass the cap. */
  async open(deviceId: string, sessionHandle: string, label: string, cwd: string): Promise<ShellView> {
    const id = crypto.randomBytes(18).toString('base64url');
    const at = this.now();
    const entry = {
      id,
      deviceId,
      sessionHandle,
      label,
      cwd,
      openedAt: at,
      lastActivity: at,
      backing: this.host ? 'host' : 'plain',
      reattaches: 0,
      timer: setTimeout(() => this.close(id, 'idle'), this.idleMs),
    } as ShellEntry;
    entry.timer.unref?.();
    this.shells.set(id, entry);
    try {
      if (this.host) await this.spawnInHost(this.host, entry);
      else this.attachLocal(entry, loginShell());
    } catch (err) {
      clearTimeout(entry.timer);
      if (this.shells.get(id) === entry) this.shells.delete(id);
      throw err;
    }
    // Revoked while the host started it: closed already, its terminal goes too.
    if (this.shells.get(id) !== entry) {
      this.killTerminal(entry);
      throw new Error('closed while opening');
    }
    this.persist();
    this.audit('open', entry);
    return { id, deviceId, label, cwd, openedAt: entry.openedAt };
  }

  private async spawnInHost(host: PtyHostClient, entry: ShellEntry): Promise<void> {
    const shell = loginShell();
    const r = await host.spawn({
      file: shell.file,
      args: shell.args,
      cwd: entry.cwd,
      env: loginEnv(),
      cols: TERMINAL_DEFAULT_COLS,
      rows: TERMINAL_DEFAULT_ROWS,
      meta: { kind: SHELL_KIND, shell: entry.id },
    });
    if (!r.ok || typeof r.id !== 'string') throw new Error(r.error ?? 'the PTY host started no terminal');
    entry.terminal = r.id;
    if (!(await this.watch(entry))) {
      this.killTerminal(entry);
      throw new Error('the PTY host terminal ended at once');
    }
  }

  /** The registry's own subscription to a host shell: output is activity, its end is the shell's. */
  private async watch(entry: ShellEntry): Promise<boolean> {
    const sub = await this.host!.subscribe(
      entry.terminal!,
      () => {
        entry.reattaches = 0;
        this.touch(entry.id);
      },
      (code) => this.watchEnded(entry, code),
    );
    if (!sub) return false;
    if (this.shells.get(entry.id) !== entry) {
      sub.off();
      return false;
    }
    entry.watch = sub;
    return true;
  }

  private watchEnded(entry: ShellEntry, code: number | undefined): void {
    entry.watch = undefined;
    if (this.shuttingDown || this.shells.get(entry.id) !== entry) return;
    if (code !== undefined) {
      entry.exitCode = code;
      this.close(entry.id, 'exit');
      return;
    }
    // The connection to the host went; the shell may still run there.
    if (entry.reattaches++ >= MAX_REATTACH) {
      this.close(entry.id, 'exit');
      return;
    }
    void this.watch(entry).then((ok) => {
      if (!ok && this.shells.get(entry.id) === entry) this.close(entry.id, 'exit');
    });
  }

  /** The daemon's PTY for `entry`: a legacy tmux client, or the shell itself. */
  private attachLocal(entry: ShellEntry, run: { file: string; args: string[] }): void {
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
    // ponytail: legacy tmux. Its client died but the shell is still there (killed from outside): attach again.
    if (
      entry.backing === 'tmux' &&
      entry.reattaches < MAX_REATTACH &&
      this.tmux?.hasSession(entry.id)
    ) {
      entry.reattaches++;
      try {
        this.attachLocal(entry, this.tmux.attachCommand(entry.id));
        return;
      } catch {
        /* closed below */
      }
    }
    entry.exitCode = pty.exitStatus?.exitCode ?? 0;
    this.close(entry.id, 'exit');
  }

  /**
   * A viewer of shell `id`: `data` gets live output after the snapshot (it may run before join
   * resolves: hold it until the snapshot is shown), `end` when the stream ends without the shell
   * closing (the registry's onClose says that). Null when there is no such shell to show.
   */
  async join(id: string, data: (d: string) => void, end: () => void): Promise<ShellStream | null> {
    const entry = this.shells.get(id);
    if (!entry) return null;
    if (entry.backing === 'host') {
      const host = this.host;
      const t = entry.terminal;
      if (!host || !t) return null;
      const sub = await host.subscribe(t, data, () => end());
      if (!sub) return null;
      return {
        snapshot: sub.snapshot,
        cols: sub.cols,
        rows: sub.rows,
        write: (d) => void host.write(t, d),
        resize: (cols, rows) => void host.call('resize', { t, cols, rows }),
        off: () => sub.off(),
      };
    }
    const pty = entry.pty;
    if (!pty) return null;
    const offData = pty.onData(data);
    const offExit = pty.onExit(() => end());
    const snapshot = await pty.snapshot();
    return {
      snapshot,
      cols: pty.cols,
      rows: pty.rows,
      write: (d) => pty.write(d),
      resize: (cols, rows) => pty.resize(cols, rows),
      off: () => {
        offData();
        offExit();
      },
    };
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
    this.killTerminal(entry);
    for (const listener of this.closeListeners.get(id) ?? []) listener(reason, entry.exitCode);
    this.closeListeners.delete(id);
    this.persist();
    this.audit('close', entry, by === undefined ? reason : `${reason} by=${JSON.stringify(by)}`);
    return true;
  }

  /** The shell's process goes (one that already ended is no matter). */
  private killTerminal(entry: ShellEntry): void {
    if (entry.backing === 'host') {
      entry.watch?.off();
      entry.watch = undefined;
      if (entry.terminal && entry.exitCode === undefined)
        void this.host?.call('kill', { t: entry.terminal });
      return;
    }
    if (entry.backing === 'tmux') this.tmux?.killSession(entry.id);
    if (entry.ptyId !== undefined) this.manager.dispose(entry.ptyId);
  }

  closeForRow(rowId: string): void {
    for (const entry of [...this.shells.values()])
      if (entry.deviceId === rowId || entry.sessionHandle === rowId)
        this.close(entry.id, 'revoked');
  }

  /**
   * After a restart: the shells of shells.json still running in the host come back (watched
   * again, ownership as before); a host shell no row names, or one idle past its time, is
   * killed; the other rows are dropped from the file. Returns how many came back.
   */
  restore(): number {
    if (!this.file) return 0;
    let saved: unknown = null;
    try {
      saved = readJson(this.file);
    } catch (err) {
      console.warn(
        `[cld shell] shells.json unreadable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const rows = parseShells(saved).filter((row) => !this.shells.has(row.id));
    let kept = 0;
    const host = this.host;
    if (host) {
      const live = listedTerminals(host.home).filter((t) => isShellTerminal(t) && processAlive(t.pid));
      for (const t of live) {
        const row = rows.find((r) => r.terminal === t.id && r.id === t.meta.shell);
        const left = row ? this.idleMs - (this.now() - row.lastActivity) : 0;
        if (!row || left <= 0) {
          void host.call('kill', { t: t.id });
          if (row) console.log(`[cld shell] close device=${JSON.stringify(row.label)} id=${row.id} reason=idle`);
          continue;
        }
        const entry = {
          ...row,
          backing: 'host',
          reattaches: 0,
          timer: setTimeout(() => this.close(row.id, 'idle'), left),
        } as ShellEntry;
        entry.timer.unref?.();
        this.shells.set(row.id, entry);
        void this.watch(entry).then((ok) => {
          if (!ok && this.shells.get(row.id) === entry) this.close(row.id, 'exit');
        });
        kept++;
        this.restored(row);
      }
    }
    kept += this.restoreLegacy(rows.filter((row) => !row.terminal));
    this.persist();
    return kept;
  }

  /**
   * ponytail: compatibility for one release, delete with tmux.ts in the next. Shells a version
   * before the PTY host left in tmux: attached as before until they close; new ones never go there.
   */
  private restoreLegacy(rows: PersistedShell[]): number {
    if (!rows.length) return 0;
    const tmux = (this.tmux = this.legacyTmux());
    if (!tmux) return 0;
    const live = tmux.sessions();
    let kept = 0;
    for (const row of rows) {
      if (!live.has(row.id)) continue;
      const left = this.idleMs - (this.now() - row.lastActivity);
      if (left <= 0) {
        tmux.killSession(row.id);
        console.log(`[cld shell] close device=${JSON.stringify(row.label)} id=${row.id} reason=idle`);
        continue;
      }
      const entry = {
        ...row,
        backing: 'tmux',
        reattaches: 0,
        timer: setTimeout(() => this.close(row.id, 'idle'), left),
      } as ShellEntry;
      entry.timer.unref?.();
      try {
        this.attachLocal(entry, tmux.attachCommand(row.id));
      } catch (err) {
        clearTimeout(entry.timer);
        console.warn(
          `[cld shell] could not attach ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      this.shells.set(row.id, entry);
      kept++;
      this.restored(row);
    }
    return kept;
  }

  private restored(row: PersistedShell): void {
    console.log(
      `[cld shell] restored device=${JSON.stringify(row.label)} cwd=${JSON.stringify(row.cwd)} id=${row.id}`,
    );
  }

  /**
   * Shutdown. Shells in the host (and legacy tmux) keep running: only the daemon's side goes
   * (viewers' sockets drop, and the panes attach again after the restart). Plain shells end with it.
   */
  async disposeAll(): Promise<void> {
    this.flushNow();
    this.shuttingDown = true;
    const local = [...this.shells.values()].filter((e) => e.pty);
    const exited = local.map(
      (entry) => new Promise<void>((resolve) => entry.pty!.onExit(() => resolve())),
    );
    for (const entry of [...this.shells.values()]) {
      clearTimeout(entry.timer);
      if (entry.backing === 'host') entry.watch?.off();
      else if (entry.backing === 'tmux') this.manager.dispose(entry.ptyId!);
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
      .filter((e) => e.backing === 'tmux' || (e.backing === 'host' && e.terminal))
      .map(({ id, deviceId, sessionHandle, label, cwd, openedAt, lastActivity, terminal }) => ({
        id,
        deviceId,
        sessionHandle,
        label,
        cwd,
        openedAt,
        lastActivity,
        ...(terminal && { terminal }),
      }));
  }

  private persist(): void {
    if (!this.file || this.shuttingDown) return;
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

/** The shell registry of this daemon: in `host` when there is one (else plain PTYs), listed in shells.json. */
export function hostShellRegistry(
  broadcast: (notice: ShellNotice) => void,
  host: PtyHostClient | null,
): ShellRegistry {
  const home = os.homedir();
  if (!host) console.log('[cld shell] no PTY host: shells end with the daemon');
  return new ShellRegistry(undefined, broadcast, Date.now, SHELL_IDLE_MS, {
    host,
    file: path.join(configDirectory(home), 'shells.json'),
    // ponytail: one release only (tmux.ts).
    legacyTmux: () => {
      const bin = findTmux(process.env, home);
      return bin ? new Tmux(bin) : null;
    },
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
      num(r.lastActivity) &&
      (r.terminal === undefined || (typeof r.terminal === 'string' && TERMINAL_ID.test(r.terminal)))
    )
      out.push({
        id: r.id,
        deviceId: r.deviceId,
        sessionHandle: r.sessionHandle,
        label: r.label.slice(0, 200),
        cwd: r.cwd,
        openedAt: r.openedAt,
        lastActivity: r.lastActivity,
        ...(typeof r.terminal === 'string' && { terminal: r.terminal }),
      });
  }
  return out;
}

/** A login's basics only, like `claude attach` (ADR-0009 8, T22): none of
 *  the service's own environment reaches the shell or what it starts. */
function loginEnv(): Record<string, string> {
  return loginEnvFrom(process.env, process.platform);
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
