import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { configDirectory } from '../configPath.js';
import { codexDir } from '../engine/codex.js';
import { jobsDir } from '../engine/jobs.js';
import { registryPath, saveRegistry } from '../engine/registry.js';
import { DiskUsageSource, walkDiskUsage } from './diskUsage.js';

const homes: string[] = [];
const home = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-disk-card-'));
  homes.push(dir);
  return dir;
};
const write = (file: string, bytes: number) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
};

afterEach(() => {
  vi.useRealTimers();
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('disk card usage', () => {
  it('counts known folders exactly, skips links and unreadable directories', async () => {
    const h = home();
    const project = path.join(h, 'project');
    const unreadable = path.join(h, '.claude', 'projects', 'locked');
    write(path.join(h, '.claude', 'projects', 'conversation.jsonl'), 7);
    write(path.join(project, '.worktrees', 'task', 'file'), 11);
    write(path.join(jobsDir(h), 'job.log'), 13);
    write(path.join(codexDir(h), 'task.jsonl'), 17);
    write(path.join(configDirectory(h), 'office.json'), 19);
    write(path.join(configDirectory(h), 'ptyhost', 'host.log'), 23);
    write(path.join(configDirectory(h), 'ptyhost', 'host.log.1'), 2);
    write(path.join(configDirectory(h), 'ptyhost', 'token'), 5);
    write(path.join(configDirectory(h), 'inbox', 'alpha', 'delivered', '1-a.md'), 29);
    write(path.join(configDirectory(h), 'inbox', 'beta', 'delivered', '2-b.md'), 3);
    write(path.join(configDirectory(h), 'inbox', 'beta', 'waiting.md'), 7);
    write(path.join(configDirectory(h), 'groups', 'room1.2026-10.jsonl'), 31);
    write(path.join(h, 'big'), 97);
    fs.symlinkSync(path.join(h, 'big'), path.join(h, '.claude', 'projects', 'link'));
    fs.mkdirSync(unreadable, { recursive: true, mode: 0o000 });
    saveRegistry(registryPath(h), [{ name: 'project', folder: project, wantRunning: false }]);

    const source = new DiskUsageSource({ home: h });
    const usage = await source.read();
    fs.chmodSync(unreadable, 0o700);

    expect(usage.rows).toEqual([
      { kind: 'claude', bytes: 7, partial: false },
      { kind: 'worktrees', bytes: 11, partial: false },
      { kind: 'logs', bytes: 30, partial: false },
      { kind: 'hostLog', bytes: 25, partial: false },
      { kind: 'delivered', bytes: 32, partial: false },
      { kind: 'roomLogs', bytes: 31, partial: false },
      { kind: 'office', bytes: expect.any(Number), partial: false },
    ]);
    // The office row is the rest of the config folder: the three lines are not counted twice.
    expect(usage.rows[6].bytes).toBeGreaterThanOrEqual(19 + 5 + 7);
    expect(usage.total).toBe(usage.rows.reduce((sum, row) => sum + row.bytes, 0));
  });

  it('marks a timed-out walk partial after counting what completed', async () => {
    let clock = 0;
    const result = await walkDiskUsage(['/first', '/late'], {
      now: () => clock,
      timeoutMs: 10,
      concurrency: 1,
      fs: {
        lstat: async (file) => {
          if (file === '/first') return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true, size: 4 } as fs.Stats;
          clock = 11;
          return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true, size: 100 } as fs.Stats;
        },
        readdir: async () => [],
      },
    });

    expect(result).toEqual({ bytes: 4, partial: true });
  });

  it('counts nested registry worktrees only through their outer project', async () => {
    const h = home();
    const project = path.join(h, 'project');
    const nested = path.join(project, '.worktrees', 'nested-project');
    write(path.join(project, '.worktrees', 'task', 'file'), 11);
    write(path.join(nested, '.worktrees', 'nested-file'), 13);
    saveRegistry(registryPath(h), [
      { name: 'project', folder: project, wantRunning: false },
      { name: 'nested', folder: nested, wantRunning: false },
    ]);

    const usage = await new DiskUsageSource({ home: h }).read();

    expect(usage.rows.find((row) => row.kind === 'worktrees')).toEqual({
      kind: 'worktrees',
      bytes: 24,
      partial: false,
    });
  });

  it('returns a partial result at the cap when a metadata read never settles', async () => {
    vi.useFakeTimers();
    const result = walkDiskUsage(['/hung'], {
      timeoutMs: 120_000,
      fs: {
        lstat: () => new Promise<fs.Stats>(() => {}),
        readdir: async () => [],
      },
    });

    await vi.advanceTimersByTimeAsync(120_000);

    await expect(result).resolves.toEqual({ bytes: 0, partial: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the ten-minute cache with a fake clock', async () => {
    const h = home();
    let clock = 1_000;
    write(path.join(h, '.claude', 'projects', 'first'), 5);
    const source = new DiskUsageSource({ home: h, now: () => clock });

    const first = await source.read();
    write(path.join(h, '.claude', 'projects', 'second'), 8);
    clock += 10 * 60_000 - 1;
    const cached = await source.read();
    clock++;
    const refreshed = await source.read();

    expect(cached).toBe(first);
    expect(first.rows.find((row) => row.kind === 'claude')?.bytes).toBe(5);
    expect(refreshed.rows.find((row) => row.kind === 'claude')?.bytes).toBe(13);
  });
});
