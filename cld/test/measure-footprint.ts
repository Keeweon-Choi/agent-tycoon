/**
 * T-0013 footprint measurement. Runs a built cli.js against an isolated HOME
 * with the fake claude (S-8), then measures two phases of the daemon:
 *
 * - no viewer: nothing connected;
 * - viewing: one headless Chromium logged in with a fresh login code.
 *
 * ~/.claude/sessions/ holds a <pid>.json per S-8 interactive session, each
 * backed by a live `sleep` whose start time is its procStart (what Claude Code
 * writes); `--bg` adds the S-8 background job, whose state only
 * `claude agents --json` knows. Older builds ignore the files.
 *
 * Per phase: fake invocations per minute (the FAKE_*_LOG lines), CPU % of one
 * core from /proc/<pid>/stat (utime+stime; reaped children's cutime+cstime
 * separately), the daemon's RSS at the end and its peak (VmHWM, reset at the
 * phase start via clear_refs), the peak of daemon + descendants RSS summed
 * (sampled every 25 ms) and the bytes the daemon wrote to stdout/stderr.
 * A hard deadline and SIGINT/SIGTERM/SIGHUP kill the server and the sleeps.
 *
 *   nice -n 10 taskset -c 4,5 npx tsx cld/test/measure-footprint.ts \
 *     [--cli dist/cli.js] [--port 18256] [--seconds 60] [--bg] [--engine] [--prod-flags]
 *
 * --engine: the daemon also runs the built-in engine (T-0018/T-0019: its
 * registry, sessions watcher, event log, job records and local socket).
 * --prod-flags: node runs with the installer's NODE_FLAGS, as deployed.
 */
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  daemonLoginUrl,
  FAKE_CLAUDE,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
} from '../../server/src/cld/testHome.js';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const CLI = path.resolve(arg('cli', path.join(REPO_ROOT, 'dist/cli.js')));
const PORT = Number(arg('port', '18256'));
const SECONDS = Number(arg('seconds', '60'));
const WITH_BG = process.argv.includes('--bg');
const WITH_ENGINE = process.argv.includes('--engine');
/** cld/install/install.mjs NODE_FLAGS (the deployed daemon's). */
const NODE_FLAGS = process.argv.includes('--prod-flags') ? ['--max-semi-space-size=1'] : [];
const SETTLE_MS = 15_000; // after start / after connecting, before a phase
const DEADLINE_MS = 2 * SECONDS * 1000 + 2 * SETTLE_MS + 90_000;
const CLK_TCK = 100; // Linux USER_HZ
const PAGE_KB = 4; // statm pages

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = (file: string): number => {
  try {
    return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
};
const statFields = (pid: number): string[] => {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' '); // [0] = field 3
};
/** utime+stime and cutime+cstime in ticks (fields 14-17). */
function cpuTicks(pid: number): { self: number; children: number } {
  const f = statFields(pid);
  return { self: Number(f[11]) + Number(f[12]), children: Number(f[13]) + Number(f[14]) };
}
const statusKb = (pid: number, key: string): number =>
  Number(
    new RegExp(`${key}:\\s+(\\d+)`).exec(fs.readFileSync(`/proc/${pid}/status`, 'utf-8'))?.[1],
  );
/** RSS of `pid` and all its descendants, in KB (0 for a process gone meanwhile). */
function treeRssKb(pid: number): number {
  try {
    const rss = Number(fs.readFileSync(`/proc/${pid}/statm`, 'utf-8').split(' ')[1]) * PAGE_KB;
    let sum = rss;
    for (const tid of fs.readdirSync(`/proc/${pid}/task`)) {
      const kids = fs.readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf-8').trim();
      for (const kid of kids ? kids.split(' ') : []) sum += treeRssKb(Number(kid));
    }
    return sum;
  } catch {
    return 0;
  }
}

/** A sessions file per S-8 session (the background job only with --bg). */
function writeSessions(home: string, sleeps: ChildProcess[]): void {
  const dir = path.join(home, '.claude/sessions');
  fs.mkdirSync(dir, { recursive: true });
  const rows = JSON.parse(
    fs.readFileSync(path.join(FAKE_CLAUDE, 'S-8/agents.json'), 'utf-8').replaceAll('@HOME@', home),
  ) as Array<Record<string, unknown>>;
  for (const r of rows) {
    const bg = r.kind === 'background';
    if (bg && !WITH_BG) continue;
    const proc = spawn('sleep', [String(DEADLINE_MS / 1000)], { stdio: 'ignore' });
    sleeps.push(proc);
    const pid = proc.pid!;
    fs.writeFileSync(
      path.join(dir, `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId: r.sessionId,
        cwd: r.cwd,
        startedAt: r.startedAt,
        procStart: statFields(pid)[19],
        version: '2.1.306',
        kind: bg ? 'bg' : 'interactive',
        entrypoint: 'cli',
        // Claude Code names every session (a derived name when not given one).
        name: r.name ?? `${path.basename(String(r.cwd))}-${String(r.sessionId).slice(0, 2)}`,
        status: bg ? 'idle' : r.status,
        ...(bg && { jobId: r.id }),
      }),
    );
  }
}

interface Row {
  phase: string;
  claudePerMin: number;
  cpuPct: number;
  childCpuPct: number;
  rssMb: number;
  peakRssMb: number;
  peakSumMb: number;
  logBytes: number;
}

async function main(): Promise<void> {
  const fake = makeFakeHome({ claude: 'S-8', agentsJson: true });
  const sleeps: ChildProcess[] = [];
  writeSessions(fake.home, sleeps);
  const env = {
    ...process.env,
    ...fake.env,
    // The fake claude first: the real one must never run here.
    PATH: `${path.dirname(fake.claudePath)}${path.delimiter}${process.env.PATH}`,
  };
  const daemon = spawn(
    process.execPath,
    [
      ...NODE_FLAGS,
      CLI,
      '--port',
      String(PORT),
      '--no-terminal',
      '--read-only',
      ...(WITH_ENGINE ? ['--engine', 'on'] : []),
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  daemon.stdout.on('data', (b: Buffer) => (log += b.toString()));
  daemon.stderr.on('data', (b: Buffer) => (log += b.toString()));
  const pid = daemon.pid!;
  const exited = new Promise((r) => daemon.once('exit', r));
  console.log(
    `cli ${CLI}\nHOME ${fake.home}\ndaemon pid ${pid} port ${PORT}${WITH_BG ? ' (--bg)' : ''}`,
  );

  // Never outlive the measurement: past the deadline or on a signal, kill the
  // server and the sleeps (the HOME is a temp dir, nothing to save).
  const killAll = () => {
    for (const p of [daemon, ...sleeps])
      if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  };
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    killAll();
    fs.rmSync(fake.home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  async function phase(name: string): Promise<Row> {
    const c0 = count(fake.claudeLog);
    const t0 = cpuTicks(pid);
    const l0 = log.length;
    fs.writeFileSync(`/proc/${pid}/clear_refs`, '5'); // reset VmHWM
    let peakSumKb = 0;
    const sampler = setInterval(() => (peakSumKb = Math.max(peakSumKb, treeRssKb(pid))), 25);
    const start = Date.now();
    await sleep(SECONDS * 1000);
    clearInterval(sampler);
    const secs = (Date.now() - start) / 1000;
    const t1 = cpuTicks(pid);
    return {
      phase: name,
      claudePerMin: ((count(fake.claudeLog) - c0) * 60) / secs,
      cpuPct: ((t1.self - t0.self) / CLK_TCK / secs) * 100,
      childCpuPct: ((t1.children - t0.children) / CLK_TCK / secs) * 100,
      rssMb: statusKb(pid, 'VmRSS') / 1024,
      peakRssMb: statusKb(pid, 'VmHWM') / 1024,
      peakSumMb: peakSumKb / 1024,
      logBytes: Buffer.byteLength(log.slice(l0)),
    };
  }

  const browser = await launchBrowser();
  const rows: Row[] = [];
  let frames = 0;
  let wake = '';
  try {
    await Promise.race([
      daemonLoginUrl(fake.home, PORT, pid),
      exited.then(() => Promise.reject(new Error(`daemon exited\n${log}`))),
    ]);
    await sleep(SETTLE_MS);
    rows.push(await phase('no viewer'));

    const page = await (await browser.newContext()).newPage();
    const opened = new Promise<void>((resolve) =>
      page.on('websocket', (ws) => {
        resolve();
        ws.on('framereceived', () => frames++);
      }),
    );
    const c0 = count(fake.claudeLog);
    const l0 = log.length;
    await page.goto(await daemonLoginUrl(fake.home, PORT, pid));
    await opened;
    await sleep(SETTLE_MS);
    wake =
      `connect + ${SETTLE_MS / 1000} s: claude ${count(fake.claudeLog) - c0}, ` +
      `log ${Buffer.byteLength(log.slice(l0))} B`;
    rows.push(await phase('viewing'));
  } finally {
    await browser.close();
    daemon.kill('SIGTERM');
    await Promise.race([exited, sleep(5_000)]);
    killAll();
    clearTimeout(deadline);
  }

  console.log(`\nwake (first viewer): ${wake}; ws frames while viewing: ${frames}`);
  console.log(`daemon log lines with a login code: ${(log.match(/code=/g) ?? []).length}`);
  console.log(
    '\n| phase | claude/min | daemon CPU % | children CPU % | daemon RSS MB | daemon peak RSS MB | peak sum with children MB | log bytes |',
  );
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(
      `| ${r.phase} | ${r.claudePerMin.toFixed(1)} | ${r.cpuPct.toFixed(2)} | ${r.childCpuPct.toFixed(2)} | ${r.rssMb.toFixed(0)} | ${r.peakRssMb.toFixed(0)} | ${r.peakSumMb.toFixed(0)} | ${r.logBytes} |`,
    );
  }
  fs.rmSync(fake.home, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
