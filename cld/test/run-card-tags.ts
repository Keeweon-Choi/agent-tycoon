/**
 * CARD-TAGS check: dist/cli.js with an isolated HOME on a spare port, headless Chromium (no GPU),
 * desktop 1280x800, the page clock fixed at 22:00 host time (after hours).
 *
 * Two floors: i1 (idle) on floor 1, `lead` and idle i2, i3 on floor 2. The page shows floor 1.
 * - the idle cards say the same before and after a click on a card (a click goes to its floor):
 *   a card's tag is its own orchestrator's state and the office hours, not which floor is shown;
 * - a lead that ended its turn while its sub-agent works on shows 야근 and "+1" together.
 * Screenshots go to cld/artifacts/card-tags/.
 *
 *   npx tsx cld/test/run-card-tags.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/card-tags');
const FONTS = {
  malgun: '/mnt/c/Windows/Fonts/malgun.ttf',
  emoji: '/mnt/c/Windows/Fonts/seguiemj.ttf',
};
const FONT_CSS = `
@font-face { font-family: 'FS Pixel Sans'; src: url('/__ct/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }
@font-face { font-family: 'FS Pixel Sans'; src: url('/__ct/emoji.ttf');
  unicode-range: U+2300-23FF, U+2600-27BF, U+FE0F, U+1F000-1FAFF; }`;
const KST = (day: number, hh: number, mm = 0) =>
  new Date(`2026-10-${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+09:00`);

type Rec = Record<string, unknown>;
const call = (id: string, name: string, input: Rec) => ({ type: 'tool_use', id, name, input });
const said = (content: Rec[]): Rec => ({
  type: 'assistant',
  message: { model: 'claude-opus-4-5', content },
});
const userResult = (id: string, text: string): Rec => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
});
const sub = (parent: string, msg: Rec): Rec => ({
  type: 'progress',
  parentToolUseID: parent,
  data: { type: 'agent_progress', message: msg },
});
const turnEnd: Rec = { type: 'system', subtype: 'turn_duration', durationMs: 1000 };

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
}

function session(home: string, k: number, name: string, cwd: string) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = `c0420000-0000-4000-8000-${String(k).padStart(12, '0')}`;
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  const transcript = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(transcript, '');
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
      status: 'idle',
    }),
  );
  const subDir = path.join(projectDir, sessionId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  return { proc, transcript, subDir };
}

const cardFor = (page: Page, name: string) =>
  page.locator('[data-testid="agent-card"]').filter({
    has: page.locator('[data-testid="card-name"]', { hasText: new RegExp(`^${name}$`) }),
  });
/** Each card's name:tag(:+n) as the bar draws it now. */
const tags = (page: Page): Promise<string[]> =>
  page.$$eval('[data-testid="agent-card"]', (cards) =>
    cards.map(
      (c) =>
        `${c.querySelector('[data-testid="card-name"]')?.textContent}:${
          c.querySelector('[data-testid="duty-mark"]')?.textContent ?? ''
        }:${c.querySelector('[data-testid="temp-chip"]')?.textContent ?? ''}`,
    ),
  );

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/building.json'),
    JSON.stringify({
      version: 1,
      perProject: false,
      floors: [
        { id: '1', name: 'F1', rooms: ['alpha'], characters: [] },
        { id: '2', name: 'F2', rooms: ['beta'], characters: [] },
      ],
    }),
  );
  const sessions = [
    session(home, 1, 'lead', '/work/beta'),
    session(home, 11, 'i1', '/work/alpha'),
    ...[2, 3].map((k) => session(home, 10 + k, `i${k}`, '/work/beta')),
  ];
  const lead = sessions[0];
  const started = startDaemon({ home, claudePath }, port, ['--no-terminal'], { TZ: 'Asia/Seoul' });
  const daemon = started.child;
  const pageErrors: string[] = [];
  const fonts = { malgun: fs.readFileSync(FONTS.malgun), emoji: fs.readFileSync(FONTS.emoji) };
  const browser = await launchBrowser({ officeHours: true });
  const append = (records: Rec[]) => {
    for (const r of records) fs.appendFileSync(lead.transcript, JSON.stringify(r) + '\n');
  };
  try {
    const loginUrl = await started.loginUrl();
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      timezoneId: 'UTC',
    });
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true;');
    await ctx.route('**/__ct/*.ttf', (route) =>
      route.fulfill({
        body: route.request().url().endsWith('emoji.ttf') ? fonts.emoji : fonts.malgun,
        contentType: 'font/ttf',
      }),
    );
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await page.clock.setFixedTime(KST(21, 22));
    await page.goto(loginUrl);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가📖'));
    await until('the four cards', async () => (await tags(page)).length >= 4);
    await page.waitForTimeout(6_000); // past the director's start-up window
    const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

    // The lead's turn ended with a background sub-agent still at work (its own transcript grows).
    fs.writeFileSync(path.join(lead.subDir, 'agent-a1e3f0c1d2b4.jsonl'), '');
    fs.writeFileSync(
      path.join(lead.subDir, 'agent-a1e3f0c1d2b4.meta.json'),
      JSON.stringify({ agentType: 'general-purpose', description: 'scan logs', toolUseId: 'tu-bg1' }),
    );
    append([
      said([call('tu-bg1', 'Agent', { description: 'scan logs', prompt: 'y', run_in_background: true })]),
      userResult('tu-bg1', 'Async agent launched successfully.\nagentId: a1e3f0c1d2b4'),
      turnEnd,
    ]);
    await new Promise((r) => setTimeout(r, 1500));
    fs.appendFileSync(
      path.join(lead.subDir, 'agent-a1e3f0c1d2b4.jsonl'),
      JSON.stringify({ ...said([call('tu-bg1-1', 'Read', { file_path: '/work/alpha/app.log' })]), isSidechain: true }) + '\n',
    );
    await until('the lead card says +1', async () => (await tags(page)).some((t) => t.startsWith('lead:') && t.endsWith(':+1'))).catch(async (err) => {
      console.error(JSON.stringify(await tags(page)));
      await page.screenshot({ path: path.join(OUT, 'debug.png') });
      throw err;
    });
    await page.waitForTimeout(2_000);
    const before = await tags(page);
    console.log('before click', JSON.stringify(before));
    await shot('1-before-click');
    const mark = (list: string[], name: string) => list.find((t) => t.startsWith(`${name}:`))?.split(':')[1];
    check(mark(before, 'lead') === '야근', `a lead with a sub-agent at work has 야근 and +1 (${before.find((t) => t.startsWith('lead:'))})`);
    for (const n of ['i1', 'i2', 'i3'])
      check(mark(before, n) !== '야근', `idle ${n} is not on overtime before the click (${mark(before, n) || 'none'})`);

    // A click on each card (the camera goes to its floor): no other card's tag changes.
    for (const name of ['i1', 'lead', 'i2']) {
      await cardFor(page, name).click();
      await page.waitForTimeout(2_500);
      const sheet = page.getByTestId('off-duty-sheet');
      if (await sheet.count()) {
        await page.getByRole('button', { name: 'x', exact: true }).click();
        await sheet.waitFor({ state: 'detached' });
      }
      const after = await tags(page);
      await shot(`2-after-click-${name}`);
      console.log(`after ${name}`, JSON.stringify(after));
      check(
        JSON.stringify(after) === JSON.stringify(before),
        `a click on ${name} changes no card's tag (${after.join(' ')})`,
      );
    }
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ') || 'none'})`);
  } finally {
    await browser.close();
    await started.stop();
    for (const s of sessions) s.proc.kill('SIGKILL');
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
  console.log('all checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
