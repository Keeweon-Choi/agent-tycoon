/**
 * T-0042: every Playwright runner (cld/test/run-*.ts), one after another on one
 * spare port pair, with a pass/fail summary (checks = lines starting `ok`).
 * Exits 1 when any runner fails. Each runner starts its own daemon in an
 * isolated HOME and talks only to the pid it started.
 *
 *   npx tsx cld/test/run-all.ts [<port> <port>] [--only run-chat,run-vanilla] [--lhm-port N]
 *
 * Without ports it waits (up to 15 min) for two free ones in 18256-18259: other
 * agents use them too. Skipped (listed as such):
 *   run-hw      needs a running LibreHardwareMonitor on the Windows host (--lhm-port N)
 *   (run-office, a screenshot tool, runs here in its `fake` mode.)
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  assertPortFree,
  launchBrowser,
  REPO_ROOT,
  SPARE_PORTS,
} from '../../server/src/cld/testHome.js';

const RUNNER_TIMEOUT_MS = 600_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

async function isFree(port: number): Promise<boolean> {
  try {
    await assertPortFree(port);
    return true;
  } catch {
    return false;
  }
}

/** Two free spare ports (waits: the range is shared with other runs). */
async function pickPorts(): Promise<[number, number]> {
  const given = process.argv
    .slice(2)
    .filter((a) => /^\d+$/.test(a))
    .map(Number);
  if (given.length >= 2) {
    if (!given.slice(0, 2).every((p) => SPARE_PORTS.includes(p)) || given[0] === given[1])
      throw new Error('ports must be two different ones of 18256-18259');
    await assertPortFree(given[0], given[1]);
    return [given[0], given[1]];
  }
  for (const deadline = Date.now() + 15 * 60_000; Date.now() < deadline; await sleep(5_000)) {
    const free: number[] = [];
    for (const p of SPARE_PORTS) if (await isFree(p)) free.push(p);
    if (free.length >= 2) return [free[0], free[1]];
  }
  throw new Error('no two free ports in 18256-18259 after 15 min');
}

/** Another agent may have taken one of our ports between runners: wait for both (10 min). */
async function waitPorts(ports: number[]): Promise<void> {
  for (const deadline = Date.now() + 10 * 60_000; ; await sleep(5_000)) {
    if ((await Promise.all(ports.map(isFree))).every(Boolean)) return;
    if (Date.now() > deadline) throw new Error(`ports ${ports.join(', ')} stayed taken for 10 min`);
  }
}

interface Result {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  checks: number;
  /** Checks the runner reports as known product bugs (not failures, but listed). */
  known: string[];
  seconds: number;
  note?: string;
}

/** Run one runner as a child process; its output goes to `logFile`. */
function runOne(file: string, args: string[], logFile: string): Promise<Result> {
  const name = path.basename(file, '.ts');
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', file, ...args], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    child.stderr.on('data', (b: Buffer) => (out += b.toString()));
    // Only the child we started; the runner's own handlers stop its daemon.
    const timer = setTimeout(() => {
      out += `\nrun-all: timed out after ${RUNNER_TIMEOUT_MS / 1000} s\n`;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, RUNNER_TIMEOUT_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      fs.writeFileSync(logFile, out);
      const checks = (out.match(/^ok\b/gm) ?? []).length;
      const failed = code !== 0 || signal !== null;
      resolve({
        name,
        status: failed ? 'fail' : 'pass',
        checks,
        known: out.match(/^KNOWN PRODUCT BUG.*$/gm) ?? [],
        seconds: Math.round((Date.now() - started) / 1000),
        note: failed
          ? out
              .split('\n')
              .filter((l) => l.trim() && !/AssetLoader|^\s+✓|📦/.test(l))
              .slice(-8)
              .join('\n')
          : undefined,
      });
    });
  });
}

async function main() {
  const [a, b] = await pickPorts();
  const only = flag('--only')?.split(',');
  const lhm = flag('--lhm-port');
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-run-all-'));
  console.log(`run-all: ports ${a} and ${b}, logs in ${logDir}`);

  // No real GPU: every launch is checked by launchBrowser; prove it once up front.
  const browser = await launchBrowser();
  await browser.close();
  console.log('ok - Chromium launches with --disable-gpu and renders in software only');

  const dir = path.join(REPO_ROOT, 'cld/test');
  const runners = fs
    .readdirSync(dir)
    // T-0090's remote setup runner has its own fixed 18256/18257 port pair.
    .filter((f) => /^run-.*\.ts$/.test(f) && f !== 'run-all.ts' && f !== 'run-remote-setup.ts')
    .sort();
  const results: Result[] = [];
  for (const f of runners) {
    const name = f.replace(/\.ts$/, '');
    if (only && !only.includes(name)) continue;
    let args = [String(a)];
    if (['run-access', 'run-device-login', 'run-hw-panel', 'run-notices', 'run-t0021', 'run-terminal'].includes(name))
      args = [String(a), String(b)];
    if (name === 'run-office') args = ['fake', String(a), 'S-8', 'S-8', 'on', 't0042-all'];
    if (name === 'run-hw') {
      if (!lhm) {
        results.push({
          name,
          status: 'skip',
          checks: 0,
          known: [],
          seconds: 0,
          note: 'needs --lhm-port',
        });
        continue;
      }
      args = [String(a), lhm];
    }
    console.log(`run-all: ${name} ...`);
    let r: Result;
    // A port another agent took between our check and the runner's start is no failure of the runner: wait, retry.
    for (let tries = 0; ; tries++) {
      await waitPorts([a, b]);
      r = await runOne(path.join('cld/test', f), args, path.join(logDir, `${name}.log`));
      if (r.status === 'pass' || tries >= 5 || !/^Error: port \d+ is taken/m.test(r.note ?? ''))
        break;
    }
    results.push(r);
    console.log(
      `run-all: ${name} ${r.status.toUpperCase()} (${r.checks} checks, ${r.seconds} s)${r.note ? `\n${r.note}` : ''}`,
    );
  }

  console.log('\nrun-all summary');
  for (const r of results)
    console.log(
      `${r.status.toUpperCase().padEnd(5)} ${r.name.padEnd(20)} ${String(r.checks).padStart(4)} checks ${String(r.seconds).padStart(4)} s${r.status === 'skip' ? `  (${r.note})` : ''}${r.known.length ? `  [${r.known.length} known product bug(s)]` : ''}`,
    );
  const bad = results.filter((r) => r.status === 'fail');
  const total = results.reduce((n, r) => n + r.checks, 0);
  console.log(
    `${results.length - bad.length - results.filter((r) => r.status === 'skip').length} passed, ${bad.length} failed, ${total} checks`,
  );
  const known = results.flatMap((r) => r.known.map((k) => `${r.name}: ${k}`));
  if (known.length)
    console.log(`known product bugs (reported, not failures):\n  ${known.join('\n  ')}`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
