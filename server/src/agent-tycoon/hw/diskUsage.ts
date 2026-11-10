/**
 * The disk-card reader deliberately counts file metadata itself instead of
 * invoking `du`: this is portable, skips links, and never changes user data.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DISK_USAGE_CACHE_MS,
  DISK_USAGE_TIMEOUT_MS,
  DISK_USAGE_WALK_CONCURRENCY,
  HOST_LOG_KEEP,
} from '../../constants.js';
import { configDirectory } from '../configPath.js';
import { codexDir } from '../engine/codex.js';
import { groupTimelineDir } from '../engine/groups.js';
import { jobsDir } from '../engine/jobs.js';
import { deliveredDirs } from '../engine/logPrune.js';
import { loadRegistry, registryPath } from '../engine/registry.js';
import { ptyhostPaths } from '../ptyhost/protocol.js';

export const DISK_USAGE_KINDS = ['claude', 'worktrees', 'logs', 'hostLog', 'delivered', 'roomLogs', 'office'] as const;
export type DiskUsageKind = (typeof DISK_USAGE_KINDS)[number];

export interface DiskUsageRow {
  kind: DiskUsageKind;
  bytes: number;
  partial: boolean;
}

export interface DiskUsageSnapshot {
  type: 'diskUsage';
  measuredAt: string;
  rows: DiskUsageRow[];
  total: number;
}

export interface DiskUsageFs {
  readdir(dir: string, options: { withFileTypes: true }): Promise<fs.Dirent[]>;
  lstat(file: string): Promise<fs.Stats>;
}

export interface DiskUsageOptions {
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  fs?: DiskUsageFs;
  timeoutMs?: number;
  concurrency?: number;
}

const nativeFs: DiskUsageFs = {
  readdir: (dir, options) => fs.promises.readdir(dir, options),
  lstat: (file) => fs.promises.lstat(file),
};

interface WalkResult {
  bytes: number;
  partial: boolean;
}

type WalkTask = { kind: 'stat' | 'read'; file: string };

/** A parent worktree folder already includes every nested project's worktrees. */
function distinctWorktreeRoots(folders: Iterable<string>): string[] {
  const roots = [...new Set([...folders].map((folder) => path.resolve(folder, '.worktrees')))];
  roots.sort((left, right) => left.length - right.length || left.localeCompare(right));
  return roots.filter(
    (root, index) => !roots.slice(0, index).some((parent) => root.startsWith(`${parent}${path.sep}`)),
  );
}

/** Count ordinary files under roots. Failed metadata reads and links are ignored. */
export async function walkDiskUsage(
  roots: readonly string[],
  options: Pick<DiskUsageOptions, 'fs' | 'now' | 'timeoutMs' | 'concurrency'> = {},
): Promise<WalkResult> {
  const diskFs = options.fs ?? nativeFs;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? DISK_USAGE_TIMEOUT_MS);
  const concurrency = options.concurrency ?? DISK_USAGE_WALK_CONCURRENCY;
  const tasks: WalkTask[] = roots.map((file) => ({ kind: 'stat', file }));
  let bytes = 0;
  let partial = false;
  let running = 0;

  return new Promise((resolve) => {
    let finished = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = () => now() >= deadline;
    const finish = (atDeadline = false) => {
      if (finished || (!atDeadline && (running !== 0 || (tasks.length !== 0 && !partial)))) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      resolve({ bytes, partial });
    };
    const queue = () => {
      if (finished) return;
      if (timedOut()) {
        partial = true;
        tasks.length = 0;
        finish();
        return;
      }
      while (!partial && running < concurrency && tasks.length) {
        const task = tasks.shift()!;
        running++;
        void run(task).finally(() => {
          running--;
          queue();
          finish();
        });
      }
      finish();
    };
    const run = async (task: WalkTask): Promise<void> => {
      try {
        if (task.kind === 'stat') {
          const stat = await diskFs.lstat(task.file);
          if (timedOut()) {
            partial = true;
            tasks.length = 0;
          } else if (stat.isSymbolicLink()) {
            // Links may point anywhere, so they are intentionally never followed.
          } else if (stat.isDirectory()) {
            tasks.push({ kind: 'read', file: task.file });
          } else if (stat.isFile()) {
            bytes += stat.size;
          }
        } else {
          const entries = await diskFs.readdir(task.file, { withFileTypes: true });
          if (timedOut()) {
            partial = true;
            tasks.length = 0;
          } else {
            for (const entry of entries) {
              if (!entry.isSymbolicLink()) tasks.push({ kind: 'stat', file: path.join(task.file, entry.name) });
            }
          }
        }
      } catch {
        // A concurrent deletion or an unreadable directory is absent from this estimate.
      }
    };
    timeout = setTimeout(() => {
      partial = true;
      tasks.length = 0;
      finish(true);
    }, Math.max(0, deadline - now()));
    queue();
  });
}

/** One ten-minute, in-memory snapshot for hardware-page viewers. */
export class DiskUsageSource {
  private cached: { at: number; value: DiskUsageSnapshot } | null = null;
  private pending: Promise<DiskUsageSnapshot> | null = null;
  private readonly home: string;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly diskFs: DiskUsageFs;
  private readonly timeoutMs: number;
  private readonly concurrency: number;

  constructor(options: DiskUsageOptions = {}) {
    this.home = options.home ?? os.homedir();
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.diskFs = options.fs ?? nativeFs;
    this.timeoutMs = options.timeoutMs ?? DISK_USAGE_TIMEOUT_MS;
    this.concurrency = options.concurrency ?? DISK_USAGE_WALK_CONCURRENCY;
  }

  async read(): Promise<DiskUsageSnapshot> {
    const current = this.now();
    if (this.cached && current < this.cached.at + DISK_USAGE_CACHE_MS) return this.cached.value;
    if (!this.pending) {
      this.pending = this.measure().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  private async measure(): Promise<DiskUsageSnapshot> {
    const started = this.now();
    const deadline = started + this.timeoutMs;
    const walk = (roots: readonly string[]) =>
      walkDiskUsage(roots, {
        fs: this.diskFs,
        now: this.now,
        timeoutMs: Math.max(0, deadline - this.now()),
        concurrency: this.concurrency,
      });
    const folders = new Set<string>();
    try {
      for (const project of loadRegistry(registryPath(this.home)).projects) folders.add(project.folder);
    } catch {
      // A damaged registry simply contributes no worktree folders.
    }
    const hostLog = ptyhostPaths(this.home).log;
    const hostLogs = [hostLog, ...Array.from({ length: HOST_LOG_KEEP }, (_, n) => `${hostLog}.${n + 1}`)];
    const rows: DiskUsageRow[] = [
      { kind: 'claude', ...(await walk([path.join(this.home, '.claude', 'projects')])) },
      {
        kind: 'worktrees',
        ...(await walk(distinctWorktreeRoots(folders))),
      },
      { kind: 'logs', ...(await walk([jobsDir(this.home, this.platform, this.env), codexDir(this.home, this.platform, this.env)])) },
      { kind: 'hostLog', ...(await walk(hostLogs)) },
      { kind: 'delivered', ...(await walk(deliveredDirs(this.home))) },
      { kind: 'roomLogs', ...(await walk([groupTimelineDir(this.home)])) },
    ];
    // The office row is the rest of the config folder: the three above live inside it.
    const office = await walk([configDirectory(this.home)]);
    const inside = rows.slice(3).reduce((sum, row) => sum + row.bytes, 0);
    rows.push({ kind: 'office', bytes: Math.max(0, office.bytes - inside), partial: office.partial });
    const value: DiskUsageSnapshot = {
      type: 'diskUsage',
      measuredAt: new Date(started).toISOString(),
      rows,
      total: rows.reduce((sum, row) => sum + row.bytes, 0),
    };
    this.cached = { at: this.now(), value };
    return value;
  }
}
