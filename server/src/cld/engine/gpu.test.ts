/**
 * T-0021 GPU queue: HIF §9's protocol in Node. The cross-process tests run
 * the real wrapper (workerMain.ts, bundled here into a temp file) in a temp
 * HOME and a temp queue folder; their commands are `echo` and `sleep`. No
 * GPU, no nvidia-smi, no other tool: the independent peer is cld/test/gpu-peer/gpu-ticket.py.
 * Signals go only to processes (and process groups) this file spawned.
 */
import type { ChildProcess } from 'child_process';
import { spawn, spawnSync } from 'child_process';
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { readTotalMib } from '../hw/nvidiaSmi.js';
import { REPO_ROOT } from '../testHome.js';
import { waitFor } from '../waitKit.js';
import { EngineEvents, eventsPath } from './events.js';
import type { GpuPolicy } from './gpu.js';
import {
  boardJson,
  flockLocks,
  gpuDir,
  gpuProcessesFromFile,
  GpuQueue,
  noThresholdHolders,
  ownGpuDir,
  parseTicket,
  pidLocks,
  policyOf,
  readGpuConfig,
  readGpuTotalMib,
  ruleLine,
  ticketText,
  unleasedFromProcesses,
  writeCollectorGpuHw,
} from './gpu.js';
import { Jobs } from './jobs.js';

const FLOCK = spawnSync('flock', ['--version']).status === 0 ? 'flock' : null;
const PY = spawnSync('python3', ['--version']).status === 0;
const FIXTURE = path.join(REPO_ROOT, 'cld/test/gpu-peer/gpu-ticket.py');
/** The numbers used to make waiting happen in these tests (the product has none). */
const POLICY = { exclusiveGib: 4.5, sharedBudgetGib: 4.5 };
/** A policy as gpu.json would give it. */
const fromFile = (p: {
  exclusiveGib: number;
  sharedBudgetGib: number;
  liveLimitGib: number | null;
}) => ({ ...p, rule: 'file', totalGib: null }) as GpuPolicy;
let WORKER = '';

beforeAll(() => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-worker-'));
  WORKER = path.join(out, 'cld-worker.js');
  buildSync({
    entryPoints: [path.join(REPO_ROOT, 'server/src/cld/engine/workerMain.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: WORKER,
    logLevel: 'silent',
  });
}, 120_000);

let cleanup: Array<() => void> = [];
/** Pids this file spawned (the only ones it may signal). */
const spawned = new Set<number>();
afterEach(() => {
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});

/** A signal to a process (or, with group, its process group) this file spawned. */
function signalOurs(pid: number, sig: NodeJS.Signals, group = false): void {
  if (!spawned.has(pid) || pid <= 1 || pid === process.pid) throw new Error(`not ours: ${pid}`);
  try {
    process.kill(group ? -pid : pid, sig);
  } catch {
    /* gone */
  }
}

function home(config?: Record<string, unknown>): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-gpu-'));
  cleanup.push(() => fs.rmSync(h, { recursive: true, force: true }));
  if (config) {
    fs.mkdirSync(path.join(h, '.config/agent-tycoon'), { recursive: true });
    fs.writeFileSync(path.join(h, '.config/agent-tycoon/gpu.json'), JSON.stringify(config));
  }
  return h;
}

interface Proc {
  child: ChildProcess;
  out: () => string;
  exit: Promise<number | null>;
  until: (re: RegExp, ms?: number) => Promise<void>;
}

/** A detached process in its own group (cleanup kills the group: orphans included). */
function run(file: string, args: string[], env: Record<string, string>): Proc {
  const child = spawn(file, args, {
    env: { PATH: process.env.PATH ?? '', ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.add(child.pid!);
  let out = '';
  child.stdout!.on('data', (b: Buffer) => (out += b.toString()));
  child.stderr!.on('data', (b: Buffer) => (out += b.toString()));
  const exit = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  cleanup.push(() => signalOurs(child.pid!, 'SIGKILL', true));
  return {
    child,
    out: () => out,
    exit,
    until: async (re, ms = 60_000) => {
      const end = Date.now() + ms;
      while (!re.test(out)) {
        if (Date.now() > end) throw new Error(`timed out on ${re}: ${out}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    },
  };
}

const gpuRunProc = (h: string, args: string[]) =>
  run(process.execPath, [WORKER, 'gpu', 'run', ...args], { HOME: h, CLD_SOURCE: 'test' });

function board(h: string) {
  const r = spawnSync(process.execPath, [WORKER, 'gpu', '--json'], {
    env: { PATH: process.env.PATH ?? '', HOME: h },
    encoding: 'utf-8',
  });
  return JSON.parse(r.stdout) as {
    dir: string;
    holders: Array<{
      id: string;
      project: string | null;
      exclusive: boolean;
      label: string | null;
    }>;
    queue: Array<{ id: string; position: number; pid: number }>;
  };
}

function cli(h: string, args: string[]) {
  return spawnSync(process.execPath, [WORKER, 'gpu', ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: h, CLD_OUTPUT: 'json' },
    encoding: 'utf-8',
  });
}

const events = (h: string) =>
  fs.existsSync(eventsPath(h))
    ? fs
        .readFileSync(eventsPath(h), 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
const gpuEvents = (h: string) =>
  events(h)
    .filter((e) => String(e.type).startsWith('gpu_'))
    .map((e) => `${String(e.type)}${e.reason ? `:${String(e.reason)}` : ''}`);

describe('queue folder and config', () => {
  it('gpu.json dir > our own folder', () => {
    const h = home();
    expect(gpuDir(h)).toBe(ownGpuDir(h));
    const elsewhere = path.join(h, 'q');
    fs.mkdirSync(path.join(h, '.config/agent-tycoon'), { recursive: true });
    fs.writeFileSync(
      path.join(h, '.config/agent-tycoon/gpu.json'),
      JSON.stringify({ dir: elsewhere, exclusiveGib: 'big', sharedBudgetGib: 3, nvidiaSmi: true }),
    );
    expect(gpuDir(h)).toBe(elsewhere);
    expect(readGpuConfig(h)).toEqual({ dir: elsewhere, sharedBudgetGib: 3, nvidiaSmi: true });
  });

  it('tickets round-trip in the queue’s key order', () => {
    const text = ticketText({
      id: 'g-1022-040000-alpha',
      project: 'alpha',
      pid: 4242,
      label: 'two\nlines',
      vramGib: 2.5,
      exclusive: false,
      requested: '2026-10-22T04:00:00+09:00',
      jobLog: null,
    });
    expect(text).toBe(
      'id=g-1022-040000-alpha\nproject=alpha\npid=4242\nlabel=two lines\nvram=2.5\nexclusive=\nrequested=2026-10-22T04:00:00+09:00\nlog=\n',
    );
    expect(parseTicket(`${text}started=now\n`, '/q/l-g-1022-040000-alpha')).toMatchObject({
      id: 'g-1022-040000-alpha',
      pid: 4242,
      vramGib: 2.5,
      exclusive: false,
      started: 'now',
      jobLog: null,
    });
  });
});

/** In-process queue on the pid backend: liveness by an injected set of fake pids. */
function pidRig(policyLive: number | null = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-gpuq-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const live = new Set<number>();
  const seen: Array<[string, Record<string, unknown>]> = [];
  const q = new GpuQueue({
    dir,
    locks: pidLocks((pid) => live.has(pid)),
    event: (type, fields) => seen.push([type, fields]),
    hwFile: path.join(dir, 'hw.json'),
  });
  const ticket = (
    name: string,
    id: string,
    pid: number,
    o: { vram?: number | null; exclusive?: boolean } = {},
  ) =>
    fs.writeFileSync(
      path.join(dir, name),
      ticketText({
        id,
        project: id.split('-').pop()!,
        pid,
        label: null,
        vramGib: o.vram ?? null,
        exclusive: o.exclusive ?? (o.vram === undefined || o.vram === null),
        requested: 'r',
        jobLog: null,
      }),
    );
  const policy = fromFile({ ...POLICY, liveLimitGib: policyLive });
  return { dir, q, live, seen, ticket, policy };
}

// Fake pids only: above the kernel's pid_max (4194304), so never a real process.
const FAKE = (n: number) => 9_000_000 + n;

describe('admission: strict FIFO under the user’s numbers (pid backend, fake pids)', () => {
  it('writes collector VRAM only for active reservations and defers to a fresh hw.json', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-gpuhw-'));
    cleanup.push(() => fs.rmSync(base, { recursive: true, force: true }));
    const dir = path.join(base, 'gpu');
    fs.mkdirSync(dir);
    const q = new GpuQueue({ dir, locks: pidLocks(() => true), event: () => {} });
    const file = path.join(base, 'hw.json');
    const now = Date.now();
    const sample = {
      ts: new Date(now).toISOString(),
      vramUsedMib: 5120,
      vramTotalMib: 8192,
      gpuProcesses: [{ pid: 456, usedMib: 1000 }],
    };
    expect(writeCollectorGpuHw(q, sample, now)).toBe(false);
    fs.writeFileSync(
      path.join(dir, 'q-00000001-g-a'),
      ticketText({
        id: 'g-a',
        project: 'a',
        pid: FAKE(1),
        label: null,
        vramGib: 2,
        exclusive: false,
        requested: 'r',
        jobLog: null,
      }),
    );
    fs.writeFileSync(
      file,
      JSON.stringify({ ts: new Date(now - 1000).toISOString(), gpu: { vram_used_mib: 1000 } }),
    );
    expect(writeCollectorGpuHw(q, sample, now)).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).gpu.vram_used_mib).toBe(1000);
    expect(
      q.admits('g-a', fromFile({ exclusiveGib: 4, sharedBudgetGib: 4, liveLimitGib: 6 })),
    ).toEqual({
      ok: true,
    });
    fs.writeFileSync(
      file,
      JSON.stringify({ ts: new Date(now - 6000).toISOString(), gpu: { vram_used_mib: 1000 } }),
    );
    expect(writeCollectorGpuHw(q, sample, now)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).gpu.vram_used_mib).toBe(5120);
    expect(gpuProcessesFromFile(dir, now)).toEqual([{ pid: 456, usedMib: 1000 }]);
    expect(
      q.admits('g-a', fromFile({ exclusiveGib: 4, sharedBudgetGib: 4, liveLimitGib: 6 })),
    ).toEqual({
      ok: false,
      position: 1,
    });
  });
  it('matches NVIDIA users to a reservation wrapper by process ancestry', () => {
    const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-gpuproc-'));
    cleanup.push(() => fs.rmSync(proc, { recursive: true, force: true }));
    for (const [pid, parent] of [
      [456, 123],
      [789, 1],
    ] as const) {
      fs.mkdirSync(path.join(proc, String(pid)));
      fs.writeFileSync(path.join(proc, String(pid), 'stat'), `${pid} (python) S ${parent} 0 0`);
    }
    expect(
      unleasedFromProcesses(
        [
          { pid: 456, usedMib: 1000 },
          { pid: 789, usedMib: 500 },
        ],
        new Set([123]),
        proc,
      ),
    ).toEqual([{ pid: 789, usedMib: 500 }]);
  });
  it('only the head enters; an exclusive head holds back a shared one that would fit', () => {
    const { q, live, ticket, policy } = pidRig();
    for (const n of [1, 2, 3]) live.add(FAKE(n));
    ticket('l-g-a', 'g-a', FAKE(1), { vram: 1, exclusive: false });
    ticket('q-00000001-g-b', 'g-b', FAKE(2), { exclusive: true });
    ticket('q-00000002-g-c', 'g-c', FAKE(3), { vram: 1, exclusive: false });
    expect(q.admits('g-c', policy)).toEqual({ ok: false, position: 2 });
    expect(q.admits('g-b', policy)).toEqual({ ok: false, position: 1 });
    fs.rmSync(path.join(q.dir, 'l-g-a'));
    expect(q.admits('g-b', policy)).toEqual({ ok: true });
    expect(q.admits('g-zz', policy)).toEqual({ ok: false, position: null, gone: true });
  });

  it('lets an oversized head take an otherwise empty GPU, so FIFO cannot deadlock', () => {
    const { q, live, ticket } = pidRig();
    live.add(FAKE(1)).add(FAKE(2));
    ticket('q-00000001-g-a', 'g-a', FAKE(1), { vram: 6, exclusive: false });
    ticket('q-00000002-g-b', 'g-b', FAKE(2), { vram: 1, exclusive: false });
    const policy = fromFile({ exclusiveGib: 8, sharedBudgetGib: 4, liveLimitGib: null });
    expect(q.admits('g-a', policy)).toEqual({ ok: true });
    expect(q.admits('g-b', policy)).toEqual({ ok: false, position: 2 });
  });

  it('does not collect GPU hardware for a lease with nobody waiting', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-gpuhw-'));
    cleanup.push(() => fs.rmSync(base, { recursive: true, force: true }));
    const dir = path.join(base, 'gpu');
    fs.mkdirSync(dir);
    const q = new GpuQueue({ dir, locks: pidLocks(() => true), event: () => undefined });
    fs.writeFileSync(
      path.join(dir, 'l-g-a'),
      ticketText({
        id: 'g-a', project: 'a', pid: FAKE(1), label: null, vramGib: 2, exclusive: false,
        requested: 'r', jobLog: null,
      }),
    );
    expect(writeCollectorGpuHw(q, { vramUsedMib: 1, vramTotalMib: 2 })).toBe(false);
  });

  it('shared: within the budget and no exclusive holder; the live VRAM rule with a fresh hw.json', () => {
    const { q, dir, live, ticket, policy } = pidRig(6);
    live.add(FAKE(1)).add(FAKE(2));
    ticket('l-g-a', 'g-a', FAKE(1), { vram: 3, exclusive: false });
    ticket('q-00000001-g-b', 'g-b', FAKE(2), { vram: 1.5, exclusive: false });
    expect(q.admits('g-b', policy)).toEqual({ ok: true });
    fs.writeFileSync(
      path.join(dir, 'hw.json'),
      JSON.stringify({ ts: new Date().toISOString(), gpu: { vram_used_mib: 5000 } }),
    );
    expect(q.admits('g-b', policy)).toEqual({ ok: false, position: 1 }); // 4.9 + 1.5 > 6
    fs.writeFileSync(
      path.join(dir, 'hw.json'),
      JSON.stringify({
        ts: new Date(Date.now() - 60_000).toISOString(),
        gpu: { vram_used_mib: 5000 },
      }),
    );
    expect(q.admits('g-b', policy)).toEqual({ ok: true }); // stale reading: ignored
    ticket('q-00000001-g-b', 'g-b', FAKE(2), { vram: 2, exclusive: false });
    expect(q.admits('g-b', policy)).toEqual({ ok: false, position: 1 }); // 3 + 2 > 4.5
  });

  it('a holder granted before any threshold existed keeps running but counts under today’s policy', () => {
    const { q, live, ticket, policy } = pidRig();
    live.add(FAKE(1)).add(FAKE(2)).add(FAKE(3));
    // two "함께 6GiB" holders, taken when nothing waited (10-22 15:36 on this PC)
    ticket('l-g-a', 'g-a', FAKE(1), { vram: 6, exclusive: false });
    ticket('l-g-b', 'g-b', FAKE(2), { vram: 2, exclusive: false });
    ticket('q-00000001-g-c', 'g-c', FAKE(3), { vram: 6, exclusive: false });
    const { holders } = q.state();
    expect([...noThresholdHolders(holders, policy)]).toEqual(['g-a']); // 6 reaches 4.5; 2 fits the budget
    expect(q.admits('g-c', policy)).toEqual({ ok: false, position: 1 }); // a 6 wants the GPU alone
    fs.rmSync(path.join(q.dir, 'q-00000001-g-c'));
    ticket('q-00000002-g-d', 'g-d', FAKE(3), { vram: 1, exclusive: false });
    expect(q.admits('g-d', policy)).toEqual({ ok: false, position: 1 }); // behind an exclusive one
    expect(fs.existsSync(path.join(q.dir, 'l-g-a'))).toBe(true); // never revoked
    // the lease that overran the budget while shared: every shared holder is marked
    const small = fromFile({ exclusiveGib: 8, sharedBudgetGib: 4, liveLimitGib: null });
    expect([...noThresholdHolders(holders, small)].sort()).toEqual(['g-a', 'g-b']);
  });

  it('fail closed: the same two 6 GiB reservations, the second waits (derived, unknown)', () => {
    for (const total of [8192, null]) {
      const { q, live, ticket } = pidRig();
      const policy = policyOf({}, total);
      live.add(FAKE(1)).add(FAKE(2));
      ticket('l-g-a', 'g-a', FAKE(1), { vram: 6, exclusive: true });
      ticket('q-00000001-g-b', 'g-b', FAKE(2), { vram: 6, exclusive: true });
      expect(q.admits('g-b', policy)).toEqual({ ok: false, position: 1 });
      fs.rmSync(path.join(q.dir, 'l-g-a'));
      expect(q.admits('g-b', policy)).toEqual({ ok: true });
    }
  });

  it('unknown VRAM: even tiny reservations take the GPU one at a time', () => {
    const { q, live, ticket } = pidRig();
    live.add(FAKE(1)).add(FAKE(2));
    ticket('l-g-a', 'g-a', FAKE(1), { vram: 0.5, exclusive: false });
    ticket('q-00000001-g-b', 'g-b', FAKE(2), { vram: 0.5, exclusive: false });
    expect(q.admits('g-b', policyOf({}, null))).toEqual({ ok: false, position: 1 });
    expect(q.admits('g-b', policyOf({}, 8192))).toEqual({ ok: true }); // 1 <= the shared budget
  });
});

describe('the policy in force (T-0094: never fail open)', () => {
  it('no gpu.json: shares of the GPU’s total, rounded to 0.5 GiB (8, 12, 24 GiB)', () => {
    const got = [8192, 12288, 24576].map((m) => {
      const p = policyOf({}, m);
      return [p.rule, p.exclusiveGib, p.sharedBudgetGib, p.liveLimitGib];
    });
    expect(got).toEqual([
      ['derived', 4.5, 4.5, 6],
      ['derived', 6.5, 6.5, 9],
      ['derived', 13, 13, 18],
    ]);
  });

  it('no gpu.json and no total (or none usable): every reservation is exclusive', () => {
    for (const total of [null, 0, -1, Number.NaN]) {
      const p = policyOf({}, total);
      expect(p).toMatchObject({ rule: 'unknown', exclusiveGib: 0, sharedBudgetGib: 0 });
    }
  });

  it('gpu.json wins: both thresholds, a lone field, and no live limit unless it names one', () => {
    expect(policyOf({ exclusiveGib: 3, sharedBudgetGib: 5 }, 8192)).toMatchObject({
      rule: 'file',
      exclusiveGib: 3,
      sharedBudgetGib: 5,
      liveLimitGib: null,
    });
    expect(policyOf({ exclusiveGib: 3, sharedBudgetGib: 5, liveLimitGib: 7 }, null)).toMatchObject({
      rule: 'file',
      liveLimitGib: 7,
    });
    // one field only: it wins, the rest come from the GPU's size; without a size, nothing to trust
    expect(policyOf({ exclusiveGib: 3 }, 8192)).toMatchObject({
      rule: 'derived',
      exclusiveGib: 3,
      sharedBudgetGib: 4.5,
    });
    expect(policyOf({ exclusiveGib: 3 }, null).rule).toBe('unknown');
  });

  it('the board says which rule is in force', () => {
    expect(ruleLine(policyOf({ exclusiveGib: 3, sharedBudgetGib: 5 }, null))).toContain('gpu.json');
    const derived = ruleLine(policyOf({}, 8192));
    expect(derived).toContain('GPU 크기에서 정한 기본값');
    expect(derived).toContain('GPU 8 GiB의 55% · 55% · 75%');
    expect(ruleLine(policyOf({}, null))).toContain('GPU 크기를 몰라 한 번에 하나');
    const empty = { holders: [], queue: [] };
    const json = (c: object, m: number | null) => boardJson('/q', policyOf(c, m), empty);
    expect(json({}, null)).toMatchObject({ rule: 'unknown', exclusive_gib: null });
    expect(json({}, 12288)).toMatchObject({
      rule: 'derived',
      exclusive_gib: 6.5,
      live_limit_gib: 9,
    });
    expect(json({ exclusiveGib: 1, sharedBudgetGib: 2 }, null)).toMatchObject({ rule: 'file' });
  });

  it('the total comes from a hw.json beside the queue (any age), else the opt-in reader', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-gputotal-'));
    cleanup.push(() => fs.rmSync(base, { recursive: true, force: true }));
    const dir = path.join(base, 'gpu');
    expect(await readGpuTotalMib(dir, null)).toBeNull();
    expect(await readGpuTotalMib(dir, async () => 4096)).toBe(4096);
    fs.writeFileSync(
      path.join(base, 'hw.json'),
      JSON.stringify({ ts: '2020-01-01T00:00:00Z', gpu: { vram_total_mib: 8188 } }),
    );
    expect(await readGpuTotalMib(dir, async () => 4096)).toBe(8188);
  });

  it('nvidia-smi’s total: the first GPU, nothing when it fails, hangs, or a query already hangs', async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-fakesmi-'));
    cleanup.push(() => fs.rmSync(bin, { recursive: true, force: true }));
    const smi = (body: string) => {
      // Not named nvidia-smi: a hanging stub with that name, left running after the limit, would read
      // as someone's stuck query (nvidiaSmiStuck) to every other test that looks at the real /proc.
      const f = path.join(bin, 'fake-smi');
      fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return f;
    };
    const noProc = path.join(bin, 'no-proc');
    const opts = { proc: noProc };
    expect(await readTotalMib(smi('echo 5,100,8192,40,20; echo 1,1,4096,1,1'), opts)).toBe(8192);
    expect(await readTotalMib(smi('echo "5, 100, [N/A], 40, 20"'), opts)).toBeNull();
    expect(await readTotalMib(smi('exit 9'), opts)).toBeNull();
    expect(await readTotalMib(null, opts)).toBeNull();
    // a query that will not die (a D-state stand-in: it ignores the kill): back at the limit
    const t0 = Date.now();
    expect(
      await readTotalMib(smi("trap '' TERM; sleep 30; echo 5,100,8192,40,20"), {
        ...opts,
        timeoutMs: 300,
      }),
    ).toBeNull();
    expect(Date.now() - t0).toBeLessThan(15_000); // back at the 0.3 s limit, not after the 30 s hang
    // a stuck nvidia-smi of anyone's (a fake /proc with one running for 10 s): not started
    const proc = path.join(bin, 'proc');
    fs.mkdirSync(path.join(proc, '42'), { recursive: true });
    fs.writeFileSync(path.join(proc, 'uptime'), '100.00 0.00\n');
    fs.writeFileSync(
      path.join(proc, '42', 'stat'),
      `42 (nvidia-smi) S ${Array.from({ length: 18 }, () => '0').join(' ')} 9000 0\n`,
    );
    expect(await readTotalMib(smi('echo 5,100,8192,40,20'), { proc })).toBeNull();
  });
});

describe('dead-owner cleanup (pid backend, fake pids only)', () => {
  it('a dead lease -> gpu_release{dead}, a dead ticket -> gpu_cancel{dead}; live ones stay', () => {
    const { q, dir, live, seen, ticket } = pidRig();
    live.add(FAKE(2)).add(FAKE(4));
    ticket('l-g-dead', 'g-dead', FAKE(1));
    ticket('l-g-live', 'g-live', FAKE(2));
    ticket('q-00000001-g-gone', 'g-gone', FAKE(3));
    ticket('q-00000002-g-wait', 'g-wait', FAKE(4));
    q.withAdmit(() => q.sweep());
    expect(fs.readdirSync(dir).sort()).toEqual(['l-g-live', 'q-00000002-g-wait']);
    expect(seen).toEqual([
      ['gpu_cancel', { id: 'g-gone', project: 'gone', reason: 'dead' }],
      ['gpu_release', { id: 'g-dead', project: 'dead', exit: null, reason: 'dead' }],
    ]);
  });

  it('an admission lock left by a dead pid is taken over; a live one is waited for', () => {
    const { q, dir, live } = pidRig();
    fs.writeFileSync(path.join(dir, '.admit.lock'), String(FAKE(7)));
    expect(q.withAdmit(() => 'in', 1)).toBe('in');
    live.add(FAKE(8));
    fs.writeFileSync(path.join(dir, '.admit.lock'), String(FAKE(8)));
    expect(q.withAdmit(() => 'in', 0.2)).toBeNull();
  });
});

describe.runIf(FLOCK && process.platform === 'linux')(
  'the wrapper across processes (flock)',
  () => {
    it('strict FIFO: A shared holds, B exclusive waits, C shared waits behind B (not past it)', async () => {
      const h = home(POLICY);
      const order = path.join(h, 'order');
      const step = (n: string) => `echo ${n}-start >> ${order}; sleep 1; echo ${n}-end >> ${order}`;
      // A holds its lease until the test says so: with a fixed sleep it could end before B had even
      // started (a worker start takes seconds on a starved CPU), and B would never queue behind it.
      const hold = (n: string) => `echo ${n}-start >> ${order}; ${holdUntil(h)}; echo ${n}-end >> ${order}`;
      const a = gpuRunProc(h, ['--vram', '1', '--label', 'A', '--', hold('A')]);
      await a.until(/예약 g-/);
      const b = gpuRunProc(h, ['--exclusive', '--', step('B')]);
      await b.until(/1번째/);
      const c = gpuRunProc(h, ['--vram', '1', '--', step('C')]);
      await c.until(/2번째/);
      expect(board(h).queue.map((x) => x.position)).toEqual([1, 2]);
      release(h);
      expect(await Promise.all([a.exit, b.exit, c.exit])).toEqual([0, 0, 0]);
      expect(fs.readFileSync(order, 'utf-8').split('\n').filter(Boolean)).toEqual([
        'A-start',
        'A-end',
        'B-start',
        'B-end',
        'C-start',
        'C-end',
      ]);
      const leases = events(h).filter((e) => e.type === 'gpu_lease');
      expect(leases.map((e) => e.exclusive)).toEqual([false, true, false]);
      expect(gpuEvents(h).filter((e) => e === 'gpu_release')).toHaveLength(3);
      expect(events(h).every((e) => e.source === 'test')).toBe(true);
    }, 120_000);

    /** A GPU size for a home with no gpu.json: the hw.json beside the queue folder. */
    const withTotal = (h: string, mib: number) => {
      fs.mkdirSync(path.dirname(ownGpuDir(h)), { recursive: true });
      fs.writeFileSync(
        path.join(path.dirname(ownGpuDir(h)), 'hw.json'),
        JSON.stringify({ gpu: { vram_total_mib: mib } }),
      );
    };
    /** A holder's command that keeps its lease until the test says so (no timing race). */
    const holdUntil = (h: string) => `while [ ! -e ${path.join(h, 'go')} ]; do sleep 0.1; done`;
    const release = (h: string) => fs.writeFileSync(path.join(h, 'go'), '');
    const boardText = (h: string) =>
      spawnSync(process.execPath, [WORKER, 'gpu'], {
        env: { PATH: process.env.PATH ?? '', HOME: h },
        encoding: 'utf-8',
      }).stdout;

    it('no gpu.json, GPU of 8 GiB: a second 6 GiB reservation waits for the first (fail closed)', async () => {
      const h = home();
      withTotal(h, 8192);
      const a = gpuRunProc(h, ['--vram', '6', '--', holdUntil(h)]);
      await a.until(/예약 g-/);
      const b = gpuRunProc(h, ['--vram', '6', '--', 'echo second-ran']);
      await b.until(/1번째/);
      expect(b.out()).not.toContain('second-ran');
      expect(board(h)).toMatchObject({
        rule: 'derived',
        exclusive_gib: 4.5,
        shared_budget_gib: 4.5,
        live_limit_gib: 6,
      });
      expect(boardText(h)).toContain('GPU 크기에서 정한 기본값');
      release(h);
      expect(await a.exit).toBe(0);
      expect(await b.exit).toBe(0);
      expect(b.out()).toContain('second-ran');
      expect(gpuEvents(h)).toEqual([
        'gpu_queue',
        'gpu_lease',
        'gpu_queue',
        'gpu_release',
        'gpu_lease',
        'gpu_release',
      ]);
    }, 120_000);

    it('no gpu.json and no GPU size: one reservation at a time, and the board says so', async () => {
      const h = home();
      const a = gpuRunProc(h, ['--vram', '1', '--', holdUntil(h)]);
      await a.until(/예약 g-/);
      const b = gpuRunProc(h, ['--vram', '1', '--', 'echo second-ran']);
      await b.until(/1번째/);
      expect(b.out()).not.toContain('second-ran');
      expect(board(h)).toMatchObject({ rule: 'unknown', exclusive_gib: null });
      expect(boardText(h)).toContain('GPU 크기를 몰라 한 번에 하나');
      release(h);
      expect(await a.exit).toBe(0);
      expect(await b.exit).toBe(0);
    }, 120_000);

    it('gpu.json wins over the GPU’s size: its larger budget lets two 4 GiB reservations share', async () => {
      const h = home({ exclusiveGib: 10, sharedBudgetGib: 10 });
      withTotal(h, 8192); // alone this would be 4.5: the second 4 GiB would have to wait
      const a = gpuRunProc(h, ['--vram', '4', '--', holdUntil(h)]);
      await a.until(/예약 g-/);
      const b = gpuRunProc(h, ['--vram', '4', '--', 'echo second-ran']);
      await b.until(/second-ran/, 60_000); // while the first still holds its lease
      expect(board(h)).toMatchObject({ rule: 'file', exclusive_gib: 10 });
      expect(boardText(h)).toContain('gpu.json');
      expect(await b.exit).toBe(0);
      release(h);
      expect(await a.exit).toBe(0);
    }, 120_000);

    it('the GPU size from nvidia-smi only when gpu.json opts in, and never a wait past its limit', async () => {
      const bin = path.join(home(), 'bin');
      fs.mkdirSync(bin);
      const called = path.join(bin, 'called');
      const finished = path.join(bin, 'finished');
      // a query that will not die (a D-state stand-in: it ignores the kill)
      fs.writeFileSync(
        path.join(bin, 'nvidia-smi'),
        `#!/bin/sh\ntouch ${called}\ntrap '' TERM\nsleep 8\ntouch ${finished}\necho 5,100,8192,40,20\n`,
        { mode: 0o755 },
      );
      const json = (h: string) => {
        const r = spawnSync(process.execPath, [WORKER, 'gpu', '--json'], {
          env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: h },
          encoding: 'utf-8',
        });
        return { board: JSON.parse(r.stdout) as { rule: string } };
      };
      const off = json(home({}));
      expect(off.board.rule).toBe('unknown');
      expect(fs.existsSync(called)).toBe(false);
      const on = json(home({ nvidiaSmi: true }));
      expect(on.board.rule).toBe('unknown');
      // The query ran (the stub starts when the CPU lets it, which may be after the worker gave up on
      // it: the worker leaves it running) ...
      await waitFor(() => expect(fs.existsSync(called)).toBe(true));
      // ... and the worker answered at its limit (1.5 s after the spawn) instead of waiting out the
      // hang: the stub, which sleeps 8 s after it starts, had not finished when the worker was done.
      // (Anchored to the stub's own clock, not to how long the worker took to start on a busy machine.)
      expect(fs.existsSync(finished)).toBe(false);
    }, 120_000);

    it('the four gpu_cancel reasons and gpu_move; every gpu_queue gets an end', async () => {
      const h = home(POLICY);
      // Holds until the test kills it: a fixed sleep would end on its own while a slow machine is still busy with the steps below.
      const holder = gpuRunProc(h, ['--exclusive', '--', holdUntil(h)]);
      await holder.until(/예약 g-/);
      const stop = gpuRunProc(h, ['--exclusive', '--', 'true']);
      await stop.until(/1번째/);
      const cancel = gpuRunProc(h, ['--exclusive', '--', 'true']);
      await cancel.until(/번째/);
      const dead = gpuRunProc(h, ['--exclusive', '--', 'true']);
      await dead.until(/번째/);
      // ids by role (queue order is arrival order)
      const q = board(h).queue;
      const ids = [stop, cancel, dead].map((p) => q.find((x) => x.pid === p.child.pid)!.id);
      const mv = cli(h, ['move', ids[2], '1']);
      expect(JSON.parse(mv.stdout)).toEqual({ v: 1, ok: true, id: ids[2], position: 1 });
      expect(board(h).queue.map((x) => x.id)).toEqual([
        ids[2],
        ...q.map((x) => x.id).filter((id) => id !== ids[2]),
      ]);
      // cancel: the waiter notices within 2 s and exits 4
      expect(JSON.parse(cli(h, ['cancel', ids[1]]).stdout)).toEqual({ v: 1, ok: true, id: ids[1] });
      expect(await cancel.exit).toBe(4);
      // a holder is refused (code leased), an unknown id too
      const holderId = board(h).holders[0].id;
      const refused = cli(h, ['cancel', holderId]);
      expect([refused.status, JSON.parse(refused.stdout).code]).toEqual([1, 'leased']);
      expect(JSON.parse(cli(h, ['cancel', 'g-nope']).stdout).code).toBe('no_ticket');
      // wait: 6 s, then exit 3. Started only now, behind the steps above: its 6 s window (the shortest
      // `--wait`) runs from its own start, so on a slow machine those steps would have outlasted it.
      const wait = gpuRunProc(h, ['--wait', '0.1', '--exclusive', '--', 'true']);
      await wait.until(/번째/);
      expect(await wait.exit).toBe(3);
      // stop: SIGTERM while queued
      signalOurs(stop.child.pid!, 'SIGTERM');
      expect(await stop.exit).toBe(143);
      // dead: kill -9 while queued; the next sweep records it
      signalOurs(dead.child.pid!, 'SIGKILL');
      await dead.exit;
      expect(board(h).queue).toEqual([]);
      // dead lease: kill -9 the holder's wrapper; its `sleep` child does not keep the lock
      signalOurs(holder.child.pid!, 'SIGKILL');
      await holder.exit;
      expect(board(h).holders).toEqual([]);
      const ev = gpuEvents(h);
      for (const r of ['cancel', 'wait', 'stop', 'dead']) expect(ev).toContain(`gpu_cancel:${r}`);
      expect(ev).toContain('gpu_move');
      expect(ev).toContain('gpu_release:dead');
      const queued = events(h)
        .filter((e) => e.type === 'gpu_queue')
        .map((e) => e.id);
      const ended = events(h)
        .filter((e) => e.type === 'gpu_lease' || e.type === 'gpu_cancel')
        .map((e) => e.id);
      expect(queued.every((id) => ended.includes(id))).toBe(true);
    }, 120_000);

    it('job --gpu: the job record shows queued, then leased with gpu_id, then done', async () => {
      const h = home(POLICY);
      const work = path.join(h, 'work');
      fs.mkdirSync(work);
      const jobs = new Jobs({
        home: h,
        events: new EngineEvents(eventsPath(h)),
        env: () => ({ HOME: h, PATH: process.env.PATH }),
        systemdRun: null,
        worker: WORKER,
      });
      const r = jobs.run({
        cmd: 'echo trained; sleep 1',
        cwd: work,
        project: 'alpha',
        tty: false,
        source: 'test',
        gpu: { vramGib: 2, exclusive: false, label: 'train' },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      spawned.add(r.pid);
      cleanup.push(() => signalOurs(r.pid, 'SIGKILL', true));
      const row = () => jobs.json(true).find((j) => j.id === r.id)!;
      const end = Date.now() + 60_000;
      while (row().gpu !== 'leased' && Date.now() < end)
        await new Promise((x) => setTimeout(x, 50));
      expect(row()).toMatchObject({
        gpu: 'leased',
        gpu_id: expect.stringMatching(/^g-\d{4}-\d{6}-alpha$/),
      });
      while (!row().ended && Date.now() < end) {
        jobs.reconcile();
        await new Promise((x) => setTimeout(x, 100));
      }
      expect(row()).toMatchObject({ gpu: 'done', exit: 0 });
      expect(fs.readFileSync(r.log, 'utf-8')).toContain('trained');
      expect(jobs.officeJobs()[0]).toMatchObject({ gpu: 'done' });
      const lease = events(h).find((e) => e.type === 'gpu_lease')!;
      expect(lease).toMatchObject({ project: 'alpha', vram_gib: 2, exclusive: false });
    }, 120_000);
  },
);

describe.runIf(FLOCK && PY && process.platform === 'linux')(
  'cross-compat with an independent peer',
  () => {
    const fixture = (args: string[]) =>
      run('python3', ['-I', FIXTURE, ...args], { HOME: os.tmpdir() });
    const sweep = (dir: string) =>
      JSON.parse(
        spawnSync('python3', ['-I', FIXTURE, 'sweep', dir], { encoding: 'utf-8' }).stdout,
      ) as { removed: string[]; holders: Array<Record<string, string>>; queue: unknown[] };

    it('a peer’s lease holds us back; its release lets us in; its dead ticket is swept by us', async () => {
      const h = home({ ...POLICY, dir: path.join(os.tmpdir(), `cld-peerq-${process.pid}-a`) });
      const dir = gpuDir(h);
      cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
      const peer = fixture(['hold', dir, 'peer']);
      await peer.until(/LEASED/);
      expect(board(h).holders).toMatchObject([{ project: 'peer', exclusive: true, label: 'peer' }]);
      const ours = gpuRunProc(h, ['--vram', '1', '--', 'echo ours-ran']);
      await ours.until(/1번째/);
      const late = fixture(['hold', dir, 'late']); // a peer’s ticket behind ours
      await late.until(/QUEUED/);
      expect(board(h).queue.map((x) => x.position)).toEqual([1, 2]);
      signalOurs(late.child.pid!, 'SIGKILL'); // dies queued: our sweep records it
      await late.exit;
      signalOurs(peer.child.pid!, 'SIGTERM'); // the peer's wrapper cleans up on SIGTERM
      await peer.exit;
      expect(await ours.exit).toBe(0);
      expect(ours.out()).toContain('ours-ran');
      expect(gpuEvents(h)).toContain('gpu_cancel:dead');
      expect(events(h).find((e) => e.reason === 'dead')).toMatchObject({ project: 'late' });
    }, 120_000);

    it('the reverse: peer code sees our lease as alive, reads its fields, and sweeps it once we die', async () => {
      const h = home({ ...POLICY, dir: path.join(os.tmpdir(), `cld-peerq-${process.pid}-b`) });
      const dir = gpuDir(h);
      cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
      const ours = gpuRunProc(h, ['--vram', '2', '--label', '학습', '--', 'sleep 30']);
      await ours.until(/예약 g-/);
      const peer = fixture(['hold', dir, 'peer']);
      await peer.until(/QUEUED/);
      const s = sweep(dir);
      expect(s.removed).toEqual([]);
      expect(s.holders).toMatchObject([
        { project: '', pid: String(ours.child.pid), label: '학습', vram: '2', exclusive: '' },
      ]);
      signalOurs(ours.child.pid!, 'SIGKILL'); // its `sleep` lives on without the lock
      await ours.exit;
      await peer.until(/LEASED/, 60_000); // peer’s sweep removed our dead lease and let it in
      signalOurs(peer.child.pid!, 'SIGTERM');
      await peer.exit;
      expect(fs.readdirSync(dir).filter((f) => /^[ql]-/.test(f))).toEqual([]);
    }, 120_000);
  },
);

describe('EngineEvents follows lines other processes append', () => {
  it('a line from another writer reaches the feed and the listener once', async () => {
    const h = home();
    const got: string[] = [];
    const ev = new EngineEvents(eventsPath(h), (e) => got.push(e.kind));
    ev.load();
    ev.follow();
    cleanup.push(() => ev.dispose());
    ev.append('job_start', 'cli', {
      id: 'j1',
      pid: 5,
      project: 'a',
      cmd: 'x',
      tab: null,
      log: 'l',
    });
    fs.appendFileSync(
      eventsPath(h),
      `${JSON.stringify({ v: 1, ts: new Date().toISOString(), type: 'codex_end', source: 'codex', id: 'c1', state: 'done', exit: 0 })}\n`,
    );
    const end = Date.now() + 30_000;
    while (got.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual(['job_start', 'codex_end']);
    ev.drain();
    expect(got).toHaveLength(2);
  });
});

describe('the sweep never removes a live owner’s file (negative controls, temp folders only)', () => {
  const ticketFile = (dir: string, name: string, pid: number, extra = '') =>
    fs.writeFileSync(
      path.join(dir, name),
      ticketText({
        id: name.replace(/^(q-\d+-|l-)/, ''),
        project: 'p',
        pid,
        label: null,
        vramGib: null,
        exclusive: true,
        requested: '2099-01-01T00:00:00+09:00', // a skewed clock: never read for liveness
        jobLog: null,
      }) + extra,
    );
  const rig = (locks: ReturnType<typeof flockLocks>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-sweepnc-'));
    cleanup.push(() => {
      for (const f of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, f), 0o644);
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const seen: string[] = [];
    const q = new GpuQueue({ dir, locks, event: (t, f) => seen.push(`${t}:${String(f.id)}`) });
    return { dir, q, seen };
  };
  const notRoot = process.getuid?.() !== 0;

  it.runIf(FLOCK && process.platform === 'linux')(
    'flock: another process’s lock keeps a file whose pid is dead; a live pid with no lock is swept',
    async () => {
      const { dir, q, seen } = rig(flockLocks('flock'));
      // pid field above pid_max (dead), extra fields of a newer writer, the lock held elsewhere.
      ticketFile(dir, 'l-g-held', FAKE(1), 'gpu_index=0\nfuture=1\n');
      const holder = run(
        'flock',
        ['-x', path.join(dir, 'l-g-held'), '-c', 'echo held; sleep 30'],
        {},
      );
      await holder.until(/held/);
      // pid field of a live process (ours: a reused pid), but nobody holds the lock.
      ticketFile(dir, 'q-00000001-g-reused', process.pid);
      q.withAdmit(() => q.sweep());
      expect(fs.readdirSync(dir).filter((f) => !f.startsWith('.'))).toEqual(['l-g-held']);
      expect(seen).toEqual(['gpu_cancel:g-reused']);
      expect(q.state().holders[0]).toMatchObject({ id: 'g-held', pid: FAKE(1) });
    },
    120_000,
  );

  it.runIf(FLOCK && process.platform === 'linux' && notRoot)(
    'flock: a file we cannot open (EACCES) is kept, not taken for dead',
    () => {
      const { dir, q, seen } = rig(flockLocks('flock'));
      ticketFile(dir, 'l-g-locked-out', FAKE(2));
      fs.chmodSync(path.join(dir, 'l-g-locked-out'), 0o000);
      q.withAdmit(() => q.sweep());
      expect(fs.readdirSync(dir)).toContain('l-g-locked-out');
      expect(seen).toEqual([]);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'flock: a probe that fails for any reason (EBADF, ENOLCK, a flock without -E) keeps the file',
    () => {
      const { dir, q, seen } = rig(flockLocks('/bin/false'));
      ticketFile(dir, 'q-00000001-g-unsure', FAKE(3));
      fs.writeFileSync(path.join(dir, '.admit'), '');
      // /bin/false cannot lock .admit either, so sweep straight (as if admitted).
      q.sweep();
      expect(fs.readdirSync(dir)).toContain('q-00000001-g-unsure');
      expect(seen).toEqual([]);
    },
  );

  it.runIf(notRoot && process.platform !== 'win32')(
    'pid backend: an empty (mid-write) or unreadable ticket is kept; a dead pid is swept',
    () => {
      const { dir, q, seen } = rig(pidLocks((pid) => pid === FAKE(9)));
      fs.writeFileSync(path.join(dir, 'q-00000001-g-midwrite'), '');
      ticketFile(dir, 'q-00000002-g-unreadable', FAKE(4));
      fs.chmodSync(path.join(dir, 'q-00000002-g-unreadable'), 0o000);
      ticketFile(dir, 'q-00000003-g-dead', FAKE(5));
      ticketFile(dir, 'l-g-live', FAKE(9));
      q.withAdmit(() => q.sweep());
      expect(
        fs
          .readdirSync(dir)
          .filter((f) => !f.startsWith('.'))
          .sort(),
      ).toEqual(['l-g-live', 'q-00000001-g-midwrite', 'q-00000002-g-unreadable']);
      expect(seen).toEqual(['gpu_cancel:g-dead']);
    },
  );
});

describe('flock backend in-process', () => {
  it.runIf(FLOCK)(
    'holds through our open fd only: closing it frees the file for the next owner',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-flock-'));
      cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
      const locks = flockLocks('flock');
      const file = path.join(dir, 'l-x');
      const fd = locks.hold(file);
      expect(locks.owned(file)).toBe(true);
      fs.closeSync(fd);
      expect(locks.owned(file)).toBe(false);
      const release = locks.admit(dir, 1)!;
      expect(locks.admit(dir, 0.2)).toBeNull();
      release();
      const again = locks.admit(dir, 1);
      expect(again).not.toBeNull();
      again?.();
    },
  );
});
