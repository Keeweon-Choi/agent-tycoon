/**
 * STAT-CARD check: dist/cli.js, isolated HOME, headless Chromium (--disable-gpu via launchBrowser).
 * One Claude session "lead" (Lv 21, 4 rebirths, 25% context) seated at an engine project that
 * names its model and effort. Phone 390x844: the summary popover with its 3-button menu, the
 * detail view (big tiles), the same with the full list open (the choice is remembered). Desktop
 * 1280x800: the orchestrator panel's card opens the same detail view.
 * Screenshots: cld/artifacts/stat-card/.
 *
 *   npx tsx cld/test/run-stat-card.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { configDirectory } from '../../server/src/cld/configPath.js';
import { registryPath, saveRegistry } from '../../server/src/cld/engine/registry.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openOfficeWindow,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/stat-card');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__st/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 240_000;
const xpOf = (level: number) => 50 * level * (level - 1);

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

function session(home: string, name: string, cwd: string) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = 'c1024000-0000-4000-8000-000000000003';
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  const transcript = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(path.join(projectDir, sessionId, 'subagents'), { recursive: true });
  fs.writeFileSync(transcript, '');
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now() - 600_000, procStart, version: '2.1.306', kind: 'interactive', name, status: 'busy' }),
  );
  return { proc, transcript };
}

async function main() {
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const cfg = configDirectory(home);
  fs.writeFileSync(
    path.join(cfg, 'levels.json'),
    JSON.stringify({ levels: { 'name:lead': { xp: xpOf(21) + 800, rebirths: 4 } } }),
  );
  const folder = '/work/alpha';
  saveRegistry(registryPath(home), [
    { name: 'lead', folder, room: 'orch-1', wantRunning: false, model: 'claude-opus-5-5', effort: 'max' } as never,
  ]);
  const lead = session(home, 'lead', folder);
  // 25% of a 200k window, and a tool running now.
  fs.appendFileSync(
    lead.transcript,
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-haiku-4-5',
        content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ln -s node_modules x' } }],
        usage: { input_tokens: 10, cache_read_input_tokens: 49_890, output_tokens: 100 },
      },
    }) + '\n',
  );
  const started = startDaemon({ home, claudePath }, port, ['--no-terminal', '--engine', 'on', '--allow-chat'], {});
  const deadline = setTimeout(() => {
    console.error('deadline: stopping');
    started.child.kill('SIGTERM');
    process.exit(2);
  }, DEADLINE_MS);
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;');
    await ctx.addInitScript(() => localStorage.setItem('cld.office-hours', '{"on":false}'));
    await ctx.route('**/__st/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    return { ctx, page };
  };
  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  try {
    const loginUrl = await started.loginUrl();
    // ── Phone ──
    const { ctx: phoneCtx, page: phone } = await open({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    await phone.goto(loginUrl);
    await phone.waitForURL(`http://127.0.0.1:${port}/`);
    await phone.addStyleTag({ content: FONT_CSS });
    const card = phone.locator('[data-testid="agent-card"]').first();
    await card.waitFor({ timeout: 30_000 });
    await until('the summary shows after a card tap', async () => {
      await card.tap();
      return (await phone.locator('[data-testid="agent-overlay"] [data-testid="agent-details"]').count()) > 0;
    });
    const overlay = phone.locator('[data-testid="agent-overlay"]').filter({ has: phone.locator('[data-testid="agent-details"]') });
    await until('the menu is up', async () => (await phone.getByRole('menuitem').count()) >= 3, 5_000);
    await phone.waitForTimeout(800);
    const box = (await overlay.boundingBox())!;
    console.log(`popover: ${Math.round(box.width)}x${Math.round(box.height)}`);
    check(box.height < 844 * 0.25, `the summary popover is short (${Math.round(box.height)} px of 844)`);
    check((await phone.getByRole('menuitem').count()) === 3, 'the menu has 3 buttons');
    const text = (await overlay.textContent()) ?? '';
    check(!/엔진이 관리|이어 붙일/.test(text), 'no internal wording in the summary');
    check(/환생 4회/.test(text) && /25%/.test(text), `rebirths and fatigue read in the summary (${text.slice(0, 80)})`);
    await shot(phone, 'phone-summary-menu');

    await phone.locator('[data-testid="stat-open"]').tap();
    const detail = phone.locator('[data-testid="stat-detail"]');
    await detail.waitFor({ timeout: 5_000 });
    check(await detail.locator('[data-testid="stat-tiles"]').isVisible(), 'the detail opens as big tiles');
    const dText = (await detail.textContent()) ?? '';
    check(/피로도 25% \(50k \/ 200k\)/.test(dText), `fatigue and context are one line (${dText.slice(0, 200)})`);
    check(!/엔진이 관리|이어 붙일/.test(dText), 'no internal wording in the detail');
    await phone.waitForTimeout(500);
    await shot(phone, 'phone-detail-tiles');
    await detail.locator('[data-testid="stat-toggle"]').tap();
    await detail.locator('[data-testid="stat-list"]').waitFor();
    check(/Lv 21/.test(await detail.innerText()), 'the full list reads Lv 21');
    await phone.waitForTimeout(300);
    await shot(phone, 'phone-detail-list');
    check(
      (await phone.evaluate(() => localStorage.getItem('cld.stat-detail-full'))) === '1',
      'the toggle is remembered in localStorage',
    );
    await phoneCtx.close();

    // ── Desktop ──
    const { page: desk } = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await desk.goto(await started.loginUrl());
    await desk.waitForURL(`http://127.0.0.1:${port}/`);
    await desk.addStyleTag({ content: FONT_CSS });
    await openOfficeWindow(desk);
    const win = desk.locator('[data-hud-window="office"]');
    const open1 = win.locator('[data-testid="stat-open"]');
    await until('the lead card opens', async () => {
      if ((await open1.count()) === 0) {
        const head = win.locator('article h3 button').first();
        if (await head.count()) await head.click();
      }
      return (await open1.count()) > 0;
    });
    await shot(desk, 'desktop-panel-card');
    await open1.first().click();
    const dd = desk.locator('[data-testid="stat-detail"]');
    await dd.waitFor({ timeout: 5_000 });
    await desk.waitForTimeout(500);
    check(await dd.locator('[data-testid="stat-tiles"]').isVisible(), 'desktop: a fresh viewer starts with the big tiles');
    await shot(desk, 'desktop-panel-detail-tiles');
    await dd.locator('[data-testid="stat-toggle"]').click();
    await dd.locator('[data-testid="stat-list"]').waitFor();
    await shot(desk, 'desktop-panel-detail-list');
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
  } finally {
    clearTimeout(deadline);
    await browser.close();
    killFakeSessions(home);
    lead.proc.kill();
    await started.stop();
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
