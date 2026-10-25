/**
 * T-0041 bug (10-22): opening the office after hours must show the steady
 * state at once, nobody walking in and straight out again. dist/cli.js with an
 * isolated HOME on a spare port, headless Chromium (no GPU), desktop
 * 1280x800, the page clock fixed at 23:00 host time (the daemon on Seoul
 * time, the page on UTC).
 *
 * The office: the engine project `veteran` (idle, four Codex tasks finished hours ago, one
 * Codex task running), Claude sessions `lead` (mid-tool: working), `helper`,
 * `b1`, `b2` (idle). From the first frame anything is drawn, at +0.5 s and at
 * +25 s (past the old 20 s idle timer):
 * - only the working ones are drawn (lead with 야근, the running Codex worker);
 * - the idle ones are home already, a 퇴근 plate on each desk, never drawn;
 * - nobody moved between the two: the same characters at the same places;
 * - the two screenshots differ only by animation frames.
 * Screenshots go to cld/artifacts/t0041/load-2300-*.png.
 *
 *   npx tsx cld/test/run-load.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import {
  assertPortFree,
  launchBrowser,
  killFakeSessions,
  makeEngineHome,
  openOfficeWindow,
  REPO_ROOT,
  seedCodexTask,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0041');
const NIGHT = new Date('2026-10-21T23:00:00+09:00'); // a Wednesday, host time

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out: ${what}`);
}

/** A live Claude Code session (a `sleep` of ours) named `name`; its transcript holds `records`. */
function session(home: string, k: number, name: string, records: object[]) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = `c0410100-0000-4000-8000-${String(k).padStart(12, '0')}`;
  const cwd = '/work/alpha';
  const dir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    records.map((r) => JSON.stringify(r) + '\n').join(''),
  );
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId,
      cwd,
      startedAt: Date.now() - 600_000,
      procStart,
      version: '2.1.306',
      kind: 'interactive',
      name,
      status: records.length ? 'busy' : 'idle',
    }),
  );
  return proc;
}

interface Seen {
  anchors: string[];
  plates: string[];
  overtime: string[];
}
/** Who is drawn (id, kind, place), whose desk says 퇴근, who has 야근. */
const look = (page: Page): Promise<Seen> =>
  page.evaluate(() => {
    const at = (n: Element) => {
      const r = n.getBoundingClientRect();
      return `${Math.round(r.left)},${Math.round(r.top)}`;
    };
    const all = (sel: string) => [...document.querySelectorAll(sel)];
    return {
      anchors: all('[data-testid="status-icon-anchor"]').map(
        (n) => `${n.getAttribute('data-agent-id')}:${n.getAttribute('data-kind')}@${at(n)}`,
      ),
      plates: all('[data-testid="off-duty-plate"]').map((n) => n.getAttribute('data-agent-id')!),
      overtime: all('[data-testid="overtime-badge"]').map(
        (n) => n.closest('[data-testid="feet-badges"]')?.getAttribute('data-agent-id') ?? '',
      ),
    };
  });
const names = (page: Page): Promise<Record<string, string>> =>
  page.$$eval('[data-testid="agent-card"]', (cards) =>
    Object.fromEntries(
      cards.map((c) => [
        c.getAttribute('data-agent-id')!,
        c.querySelector('[data-testid="card-name"]')?.textContent ?? '',
      ]),
    ),
  );

/** The share of pixels that differ between two PNG screenshots. */
function pixelDiff(a: Buffer, b: Buffer): number {
  const [x, y] = [PNG.sync.read(a), PNG.sync.read(b)];
  let diff = 0;
  for (let i = 0; i < x.data.length; i += 4)
    if (
      x.data[i] !== y.data[i] ||
      x.data[i + 1] !== y.data[i + 1] ||
      x.data[i + 2] !== y.data[i + 2]
    )
      diff++;
  return diff / (x.data.length / 4);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  // The engine: `veteran` (a project the engine revives: idle, four Codex tasks finished hours ago,
  // one running) and `sleeper`, a project that is off (after hours it is home, never on overtime).
  const { home, claudePath } = makeEngineHome();
  const fake = { home };
  const folders = Object.fromEntries(
    ['veteran', 'sleeper'].map((n) => [n, path.join(home, 'work', n)]),
  );
  for (const f of Object.values(folders)) fs.mkdirSync(f, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/projects.json'),
    JSON.stringify([
      { name: 'veteran', folder: folders.veteran, wantRunning: true },
      { name: 'sleeper', folder: folders.sleeper, wantRunning: false },
    ]),
  );
  for (const k of [1, 2, 3, 4])
    seedCodexTask(home, {
      id: `1021-10000${k}-veteran`,
      project: 'veteran',
      state: 'done',
      started: '2026-10-21T10:00:00+09:00',
      ended: '2026-10-21T11:00:00+09:00',
      exit: 0,
    });
  const worker = spawn('sleep', ['900'], { stdio: 'ignore' });
  seedCodexTask(home, {
    id: '1021-230000-alpha',
    project: 'alpha',
    state: 'running',
    started: new Date(Date.now() - 600_000).toISOString(),
    pid: worker.pid!,
  });
  const working = [
    {
      type: 'assistant',
      message: {
        model: 'claude-opus-4-5',
        content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'npm test' } }],
      },
    },
  ];
  const sessions = [
    session(fake.home, 1, 'lead', working),
    session(fake.home, 2, 'helper', []),
    session(fake.home, 3, 'b1', []),
    session(fake.home, 4, 'b2', []),
  ];
  const started = startDaemon({ home, claudePath }, port, ['--no-terminal', '--engine', 'on'], {
    TZ: 'Asia/Seoul',
  });
  const daemon = started.child;
  const pageErrors: string[] = [];
  // Office hours are what this runner tests, on a fixed page clock: left on.
  const browser = await launchBrowser({ officeHours: true });
  try {
    const loginUrl = await started.loginUrl();
    // Log in once (the cookie), then open the office cold in a new page.
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      timezoneId: 'UTC',
    });
    await ctx.addInitScript('globalThis.__name = (fn) => fn;');
    const login = await ctx.newPage();
    await login.goto(loginUrl);
    await login.waitForURL(`http://127.0.0.1:${port}/`);
    await login.close();
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await page.clock.setFixedTime(NIGHT);
    // Every frame from the start: who is drawn, until the office is up.
    await page.goto(`http://127.0.0.1:${port}/`);
    const frames: Seen[] = [];
    await until('the first character is drawn', async () => {
      const seen = await look(page);
      frames.push(seen);
      return seen.anchors.length > 0;
    });
    const t0 = Date.now();
    const first = frames.at(-1)!;
    await page.waitForTimeout(Math.max(0, 500 - (Date.now() - t0)));
    const a = await look(page);
    const shotA = await page.screenshot({ path: path.join(OUT, 'load-2300-0.5s.png') });
    // Watch every 250 ms until +25 s: nobody may appear, leave or move.
    const during: Seen[] = [];
    while (Date.now() - t0 < 25_000) {
      during.push(await look(page));
      await page.waitForTimeout(250);
    }
    const b = await look(page);
    const shotB = await page.screenshot({ path: path.join(OUT, 'load-2300-25s.png') });

    const cards = await names(page);
    const who = (s: string) => cards[s.split(':')[0]] ?? s;
    const drawn = (s: Seen) => s.anchors.map(who).sort();
    console.log(`drawn at the first frame: ${drawn(first).join(', ')}`);
    check(
      frames.every((f) => f.anchors.length === 0 || f.anchors.length === first.anchors.length),
      `the first frame drawn is already the whole office (${frames.length} looks before it)`,
    );
    const lead = Object.keys(cards).find((id) => cards[id] === 'lead')!;
    const kinds = a.anchors.map((x) => x.split('@')[0].split(':')[1]).sort();
    check(
      a.anchors.length === 2 &&
        a.anchors.some((x) => x.startsWith(`${lead}:`)) &&
        kinds.join() === 'codex,orchestrator',
      `at +0.5 s only the working ones are drawn (${a.anchors.join(' ')})`,
    );
    const idle = ['veteran', 'sleeper', 'helper', 'b1', 'b2'].map((n) =>
      Object.keys(cards).find((id) => cards[id] === n)!,
    );
    check(
      idle.every((id) => a.plates.includes(id)) && a.plates.length === 5,
      `the idle and off ones are home already, a 퇴근 plate on each desk (${a.plates.join(', ')})`,
    );
    check(
      a.overtime.includes(lead) && !a.overtime.some((id) => idle.includes(id)),
      `only the working ones have 야근 (${a.overtime.join(', ')})`,
    );
    // The cards and the 현황판 rows say the same: 야근 for the lead only, 퇴근 for the rest.
    const marks = await page.$$eval('[data-testid="agent-card"]', (cards) =>
      cards.map(
        (c) =>
          `${c.querySelector('[data-testid="card-name"]')?.textContent}:${c.querySelector('[data-testid="duty-mark"]')?.textContent ?? ''}`,
      ),
    );
    check(
      marks.includes('lead:야근') &&
        ['veteran', 'sleeper', 'helper', 'b1', 'b2'].every((n) => marks.includes(`${n}:퇴근`)),
      `cards: ${marks.join(', ')}`,
    );
    await openOfficeWindow(page); // T-0108: a desktop starts with icons only; the rows are in its window
    const rows = await page.$$eval('article', (articles) =>
      articles
        .map(
          (a) =>
            `${a.querySelector('h3')?.textContent ?? ''}:${a.querySelector('[data-testid="duty-mark"]')?.textContent ?? ''}`,
        )
        .filter((x) => x.length > 1),
    );
    check(
      rows.some((r) => r.startsWith('sleeper') && r.endsWith(':퇴근')) &&
        !rows.some((r) => !r.startsWith('lead') && r.endsWith(':야근')),
      `현황판 rows: ${rows.join(', ')}`,
    );
    check(
      [first, ...during, b].every((s) => JSON.stringify(s) === JSON.stringify(a)),
      'from the first frame to +25 s nobody appeared, left or moved',
    );
    check(
      !during.some((s) => idle.some((id) => s.anchors.some((x) => x.startsWith(`${id}:`)))),
      'the idle ones were never drawn (no walk out)',
    );
    const diff = pixelDiff(shotA, shotB);
    check(
      diff < 0.01,
      `the screenshots differ only by animation frames (${(diff * 100).toFixed(3)}% of pixels)`,
    );
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ') || 'none'})`);
  } finally {
    await browser.close();
    if (daemon.exitCode === null) {
      const exited = new Promise((r) => daemon.once('exit', r));
      daemon.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      if (daemon.exitCode === null) daemon.kill('SIGKILL');
    }
    for (const s of [...sessions, worker]) s.kill('SIGKILL');
    killFakeSessions(fake.home);
    fs.rmSync(fake.home, { recursive: true, force: true });
  }
  console.log('all checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
