/**
 * P4 개발실 (dev room): who has it open, its footer stats and the owner's dev room settings.
 *
 *   devroomView {on}          -> every project's repoState (RepoManager.devroomView), devroomSettings
 *                                once, devroomStats now and every 10 s; with nobody looking nothing runs
 *   devroomSettingsSet {...}  -> devroomSettings to every dev room viewer (persisted in devroom.json)
 *   previewAsk {project, task, url} -> one previewOpen to every screen and a Web Push (a phone asks the
 *                                PC to open the 미리보기); the url must be empty or loopback (core/cld/devUrl)
 *
 * Privileged like every message but webviewReady (clientMessageHandler's gate); a read-only daemon
 * refuses the settings write and answers with the settings as they are.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { loopbackUrl } from '../../../core/src/cld/devUrl.js';
import type { DevroomSettings, DevroomStats, PreviewOpen } from '../../../core/src/messages.js';
import { DEVROOM_STATS_MS } from '../constants.js';
import type { RepoManager } from './engine/git/repoManager.js';
import type { WsSend } from './hooks.js';
import { readJson, writeJsonAtomic } from './jsonFile.js';

const MIB = 1024 * 1024;
const PS_TIMEOUT_MS = 2_000;
/** A project or worktree folder name as a notice and its url may carry it. */
const SAFE_NAME = /^[^\p{C}<>"'`&\\/]{1,80}$/u;

export interface DevroomOptions {
  /** ~/.config/agent-tycoon/devroom.json */
  file: string;
  repos: Pick<RepoManager, 'devroomView'>;
  readOnly: boolean;
  /** Our PTY host's agent terminals now (0 when no host runs). */
  terminals: () => Promise<number>;
  /** The PTY host's pid, when known. */
  hostPid: () => number | undefined;
  /** previewAsk, once it passed the rules: the office sends the notice (screens and push). */
  previewOpen: (msg: PreviewOpen) => void;
  pollMs?: number;
  log?: (line: string) => void;
}

/** A process's resident memory in MiB: /proc on Linux, `ps` elsewhere; undefined when unknown. */
export async function rssMibOf(pid: number): Promise<number | undefined> {
  try {
    const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(await fs.promises.readFile(`/proc/${pid}/status`, 'utf-8'));
    if (m) return Math.round(Number(m[1]) / 1024);
  } catch {
    /* not Linux, or gone */
  }
  return new Promise((resolve) =>
    execFile('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: PS_TIMEOUT_MS }, (err, out) => {
      const kb = Number(String(out).trim());
      resolve(err || !Number.isFinite(kb) || kb <= 0 ? undefined : Math.round(kb / 1024));
    }),
  );
}

export class Devroom {
  private readonly viewers = new Set<WsSend>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private auto: boolean;

  constructor(private readonly o: DevroomOptions) {
    const v = (readJson(o.file) as { autoCleanupAfterMerge?: unknown } | null)?.autoCleanupAfterMerge;
    this.auto = typeof v === 'boolean' ? v : true;
  }

  /** The owner's `autoCleanupAfterMerge` (default on). */
  get autoCleanupAfterMerge(): boolean {
    return this.auto;
  }

  /** True when `msg` was a dev room message (also a malformed one, which is dropped). */
  onClientMessage(msg: Record<string, unknown>, send: WsSend, privileged: boolean): boolean {
    if (msg.type === 'devroomView') {
      if (typeof msg.on !== 'boolean') console.warn('[agty devroom] malformed devroomView dropped');
      else if (privileged) this.view(send, msg.on);
      return true;
    }
    if (msg.type === 'devroomSettingsSet') {
      if (typeof msg.autoCleanupAfterMerge !== 'boolean') console.warn('[agty devroom] malformed devroomSettingsSet dropped');
      else if (!privileged || this.o.readOnly) send({ ...this.settings() });
      else this.set(msg.autoCleanupAfterMerge, send);
      return true;
    }
    if (msg.type === 'previewAsk') {
      const { project, task, url } = msg;
      const open = typeof url === 'string' && (url === '' ? '' : loopbackUrl(url));
      if (typeof project !== 'string' || typeof task !== 'string' || !SAFE_NAME.test(project) || !SAFE_NAME.test(task) || open === false || open === null)
        console.warn('[agty devroom] malformed or non-loopback previewAsk dropped');
      else if (privileged) this.o.previewOpen({ type: 'previewOpen', project, task, url: open });
      return true;
    }
    return false;
  }

  onClientClosed(send: WsSend): void {
    this.view(send, false);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.viewers.clear();
  }

  private settings(): DevroomSettings {
    return { type: 'devroomSettings', autoCleanupAfterMerge: this.auto };
  }

  private set(on: boolean, send: WsSend): void {
    try {
      fs.mkdirSync(path.dirname(this.o.file), { recursive: true, mode: 0o700 });
      writeJsonAtomic(this.o.file, { autoCleanupAfterMerge: on });
      this.auto = on;
      (this.o.log ?? console.log)(`[agty devroom] autoCleanupAfterMerge ${on ? 'on' : 'off'}`);
    } catch (err) {
      console.warn(`[agty devroom] settings not written: ${String(err)}`);
    }
    const m = this.settings();
    send({ ...m });
    for (const v of this.viewers) if (v !== send) v({ ...m });
  }

  private view(send: WsSend, on: boolean): void {
    this.o.repos.devroomView(send, on);
    if (!on) {
      this.viewers.delete(send);
      if (!this.viewers.size && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      return;
    }
    this.viewers.add(send);
    send({ ...this.settings() });
    void this.stats().then((m) => send({ ...m }));
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), this.o.pollMs ?? DEVROOM_STATS_MS);
      this.timer.unref();
    }
  }

  private async tick(): Promise<void> {
    const m = await this.stats();
    for (const v of this.viewers) v({ ...m });
  }

  async stats(): Promise<DevroomStats> {
    const pid = this.o.hostPid();
    const [terminals, hostRssMib] = await Promise.all([
      this.o.terminals().catch(() => 0),
      pid ? rssMibOf(pid) : Promise.resolve(undefined),
    ]);
    return {
      type: 'devroomStats',
      terminals,
      rssMib: Math.round(process.memoryUsage().rss / MIB),
      ...(hostRssMib !== undefined && { hostRssMib }),
    };
  }
}
