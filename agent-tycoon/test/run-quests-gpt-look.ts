/**
 * The quest board (dock 퀘스트 -> the Task board), GPT mockup look: pictures and checks. dist/cli.js in an
 * isolated HOME on a spare port, headless Chromium without a GPU, no model. The seed is the repo's board fixture
 * (server/src/agent-tycoon/fixtures/dev-board-seed.json) with its owners renamed to five fake agents (a `sleep` pid and a
 * transcript each) so the cards carry faces. Pictures go to agent-tycoon/artifacts/feat-quests-gpt-look/<PREFIX>-*.png.
 *
 *   PREFIX=after npx tsx agent-tycoon/test/run-quests-gpt-look.ts <port 18820-18829>
 */
import type { Page } from '@playwright/test';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openWorkbenchTab,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';
import { outDir, themePort, UI_THEME_INIT } from './uiTheme.js';

const port = Number(process.argv[2]);
if (!((port >= 18820 && port <= 18829) || themePort(port))) throw new Error('port must be 18820-18829');
const PREFIX = process.env.PREFIX ?? 'after';
const OUT = outDir(path.join(REPO_ROOT, 'agent-tycoon/artifacts/feat-quests-gpt-look'));
const SEED = path.join(REPO_ROOT, 'server/src/agent-tycoon/fixtures/dev-board-seed.json');
const CLI = path.join(REPO_ROOT, 'agent-tycoon/bin/agty');
const INIT = `globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;`;
const STORE: Record<string, string> = { 'agty.title-scene': 'off', 'agty.office-iso': 'on', 'agty.floor': '1', 'agty.floor-view': 'one' };
const CREW = ['agent-tycoon', 'pearl', 'harvester', 'postbox', 'iris'];
const RENAME: Record<string, string> = { '워커 A': 'harvester', '워커 B': 'pearl', 'Codex 워커': 'postbox', 'agent-tycoon-orchestrator': 'agent-tycoon' };

function session(home: string, n: number, name: string) {
  const cwd = `/work/${name}`;
  const proc = spawn('sleep', ['1800'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = `b1106100-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), '');
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now() - 3_600_000, procStart, version: '2.1.306', kind: 'interactive', name, status: 'idle' }),
  );
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  CREW.forEach((name, i) => session(home, i + 1, name));
  const folder = path.join(home, 'work', 'agent-tycoon');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(configDirectory(home), 'projects.json'), JSON.stringify([{ name: 'agent-tycoon', folder, wantRunning: false }]));
  fs.writeFileSync(path.join(configDirectory(home), 'building.json'), JSON.stringify({ version: 1, perProject: false, floors: [{ id: '1', name: '1F', rooms: [], characters: [] }] }));
  const seed = JSON.parse(fs.readFileSync(SEED, 'utf-8')) as { tasks: Array<{ owner?: { name: string } }> };
  for (const t of seed.tasks) if (t.owner && RENAME[t.owner.name]) t.owner.name = RENAME[t.owner.name];
  const seedFile = path.join(home, 'seed.json');
  fs.writeFileSync(seedFile, JSON.stringify(seed));
  const daemon = startDaemon({ home, claudePath }, port, ['--no-terminal', '--allow-chat'], {});
  const browser = await launchBrowser({ partyFrame: true });
  const failures: string[] = [];
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) failures.push(what);
  };
  try {
    const login = await browser.newContext();
    const lp = await login.newPage();
    await lp.goto(await daemon.loginUrl());
    await lp.waitForURL(`http://127.0.0.1:${port}/`);
    const cookies = await login.cookies();
    await login.close();
    const cli = spawnSync(process.execPath, [CLI, 'task', 'import', seedFile], { env: { PATH: process.env.PATH, HOME: home }, cwd: home, encoding: 'utf-8' });
    check(cli.status === 0, `the seed imports: ${cli.stdout.trim()} ${cli.stderr.trim()}`);
    const top = (page: Page) =>
      page.evaluate(() => {
        for (let e: Element | null = document.querySelector('[data-testid="task-board"]'); e; e = e.parentElement) e.scrollTop = 0;
      });
    const shot = async (page: Page, name: string) => {
      await top(page);
      await page.screenshot({ path: path.join(OUT, `${PREFIX}-${name}.png`) });
    };
    const open = async (viewport: { width: number; height: number }, touch = false) => {
      const ctx = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch, deviceScaleFactor: touch ? 2 : 1 });
      await ctx.addInitScript(INIT + UI_THEME_INIT);
      await ctx.addInitScript((pairs) => { for (const [k, v] of pairs) try { localStorage.setItem(k, v); } catch { /* about:blank */ } }, Object.entries(STORE));
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => failures.push(`pageerror ${e}`));
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.getByTestId('office-canvas').waitFor({ timeout: 60_000 });
      await page.waitForTimeout(4000);
      return { ctx, page };
    };
    const openBoard = async (page: Page, tap = false) => {
      const dock = page.locator('[data-hud-id="icon:quests"] button').first();
      await (tap ? dock.tap() : dock.click());
      await page.getByTestId('task-board').waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1500);
    };
    for (const [w, h] of [[1600, 1000], [1024, 700]]) {
      const { ctx, page } = await open({ width: w, height: h });
      await openBoard(page);
      check((await page.getByTestId('task-card').count()) > 0, `${w}: cards show`);
      await shot(page, `board-${w}x${h}`);
      const first = page.getByTestId('task-card').first();
      await first.locator('button').first().click();
      await page.waitForTimeout(600);
      await shot(page, `detail-${w}x${h}`);
      // The window maximized: the columns (and, wide enough, the side panel).
      await first.locator('button').first().click();
      await page.getByRole('button', { name: '최대화' }).first().click();
      await page.waitForTimeout(1200);
      await shot(page, `max-${w}x${h}`);
      await page.locator('.quest-filters').evaluate((e) => e.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: path.join(OUT, `${PREFIX}-max-board-${w}x${h}.png`) });
      check((await page.getByTestId('task-board').getAttribute('data-layout')) !== 'list', `${w}: maximized, the board has columns`);
      await page.getByTestId('task-card').first().locator('button').first().click();
      await page.waitForTimeout(800);
      await page.locator('.quest-filters').evaluate((e) => e.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: path.join(OUT, `${PREFIX}-max-detail-${w}x${h}.png`) });
      const sw = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(sw <= 0, `${w}: no horizontal page scroll`);
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ width: 390, height: 844 }, true);
      await openWorkbenchTab(page, '이슈', { project: 'agent-tycoon', tap: true });
      await page.getByTestId('task-board').waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1500);
      await shot(page, 'phone-board');
      await page.locator('.quest-filters').evaluate((e) => e.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: path.join(OUT, `${PREFIX}-phone-cards.png`) });
      await page.getByTestId('task-card').first().locator('button').first().tap();
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(OUT, `${PREFIX}-phone-detail.png`) });
      check((await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0, 'phone: no horizontal page scroll');
      await ctx.close();
    }
  } finally {
    killFakeSessions(home);
    daemon.child.kill('SIGKILL');
    await browser.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`FAILED: ${failures.join('; ')}`);
    process.exit(1);
  }
  process.exit(0);
}
void main();
