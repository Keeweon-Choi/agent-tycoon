/**
 * STAT-2 check: dist/cli.js, isolated HOME, headless Chromium (--disable-gpu via launchBrowser).
 * Phone 390x844: the summary popover keeps a capped width and a 2-line activity for a long
 * description (and a fixed 100 px fatigue bar, rank chip under the face, rebirth mark beside the
 * ring); after hours an off orchestrator's card opens the 스탯 view (provider, room, folder,
 * session in the list, the wake-up line, 켜기), never the old off-duty sheet. Desktop 1280x800:
 * the same from a card, and the panel's button reads 스탯.
 * `before` runs only the popover shots against another build's cli.js (the main checkout's dist).
 * Screenshots: cld/artifacts/stat-2/.
 *
 *   npx tsx cld/test/run-stat-2.ts <port 18260-18269> [before]
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
  startDaemon,
} from '../../server/src/cld/testHome.js';

const BEFORE = process.argv[3] === 'before';
// This runner's own range (the gate's install harness holds 18256-18259).
const port = Number(process.argv[2]);
if (!(port >= 18260 && port <= 18269)) throw new Error('port must be 18260-18269');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/stat-2');
const P = BEFORE ? 'before-' : '';
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__st/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const BASELINE_CLI = '/tmp/example-home/projects/cld-gui/dist/cli.js';
const SHORT_NOTE = '진행 메모';
const LONG_NOTE = '묶음에 라이선스 파일 넣고 main 에 올려 배포 검사 띄우기';
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


const toolUse = (id: string, description: string) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-haiku-4-5',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ln -s node_modules x', description } }],
      usage: { input_tokens: 10, cache_read_input_tokens: 49_890, output_tokens: 100 },
    },
  }) + '\n';

async function main() {
  await assertPortFree(port);
  if (!BEFORE) fs.rmSync(OUT, { recursive: true, force: true });
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
    { name: 'sleeper', folder: '/work/sleeper', room: 'orch-2', wantRunning: false, model: 'claude-opus-5-5', effort: 'high' } as never,
  ]);
  const lead = session(home, 'lead', folder);
  const started = startDaemon(
    { home, claudePath },
    port,
    ['--no-terminal', '--engine', 'on', '--allow-chat', '--allow-actions'],
    {},
    false,
    BEFORE ? BASELINE_CLI : undefined,
  );
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
  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${P}${name}.png`) });
  try {
    // ── Phone: the summary popover with a short and a long activity ──
    const { ctx: phoneCtx, page: phone } = await open({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    await phone.goto(await started.loginUrl());
    await phone.waitForURL(`http://127.0.0.1:${port}/`);
    await phone.addStyleTag({ content: FONT_CSS });
    const leadCard = phone.locator('[data-testid="agent-card"]').filter({ hasText: 'lead' }).first();
    await leadCard.waitFor({ timeout: 30_000 });
    await until('the summary shows after a card tap', async () => {
      await leadCard.tap();
      return (await phone.locator('[data-testid="agent-overlay"] [data-testid="agent-details"]').count()) > 0;
    });
    const overlay = phone.locator('[data-testid="agent-overlay"]').filter({ has: phone.locator('[data-testid="agent-details"]') });
    const plate = overlay.locator('[data-nameplate]');
    const activity = overlay.locator('[data-testid="activity-text"]');
    fs.appendFileSync(lead.transcript, toolUse('tu-1', SHORT_NOTE));
    await until('the short note shows', async () => ((await activity.textContent()) ?? '').includes(SHORT_NOTE), 20_000);
    await phone.waitForTimeout(800);
    const shortBox = (await plate.boundingBox())!;
    console.log(`short popover: ${Math.round(shortBox.width)}x${Math.round(shortBox.height)}`);
    await shot(phone, 'popover-short');

    fs.appendFileSync(lead.transcript, toolUse('tu-2', LONG_NOTE));
    await until('the long note shows', async () => ((await activity.textContent()) ?? '').includes('라이선스'), 20_000);
    await phone.waitForTimeout(800);
    const longBox = (await plate.boundingBox())!;
    console.log(`long popover: ${Math.round(longBox.width)}x${Math.round(longBox.height)}`);
    await shot(phone, 'popover-long');
    if (BEFORE) {
      await phoneCtx.close();
      return;
    }
    check(longBox.width <= 300 + 1, `a long activity does not stretch the popover (${Math.round(longBox.width)} px, cap 300)`);
    check(longBox.width < 390 * 0.85, 'the popover stays well under the screen width');
    const lines = await activity.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
    check(lines <= 2, `the activity wraps to at most 2 lines (${lines})`);
    const bar = (await overlay.locator('[data-testid="fatigue"] > span').nth(1).boundingBox())!;
    check(Math.abs(bar.width - 100) <= 1, `the fatigue bar is 100 px (${bar.width})`);
    const face = (await overlay.locator('[data-testid="stat-face"]').boundingBox())!;
    const rank = (await overlay.locator('[data-testid="rank-text"]').boundingBox())!;
    check(rank.y >= face.y + face.height - 1 && Math.abs(rank.x - face.x) < 6, 'the rank chip sits under the face');
    const ring = (await overlay.locator('[data-testid="level-ring"]').boundingBox())!;
    const reb = (await overlay.locator('[data-testid="rebirth-chip"]').boundingBox())!;
    check(reb.x >= ring.x + ring.width - 1 && Math.abs(reb.y + reb.height / 2 - (ring.y + ring.height / 2)) < 14, 'the rebirth mark is right of the level ring');
    check(/환생 4회/.test((await overlay.textContent()) ?? ''), 'the rebirth text 환생 4회 is still readable');
    check((await overlay.locator('[data-testid="rebirth-chip"]').getAttribute('aria-label')) === '환생 4회', 'the rebirth mark has an aria-label');
    // The sparkle and flicker are stepped animations that stop under prefers-reduced-motion.
    const anim = () =>
      phone.evaluate(() => getComputedStyle(document.querySelector('.rebirth-flame-b') as HTMLElement).animationName);
    check((await anim()) === 'rebirth-b', 'the flame flickers with a stepped animation');
    await phone.emulateMedia({ reducedMotion: 'reduce' });
    check((await anim()) === 'none', 'no animation under prefers-reduced-motion');
    await phone.emulateMedia({ reducedMotion: 'no-preference' });
    await phoneCtx.close();

    // ── Phone, after hours: an off orchestrator's card opens the 스탯 view ──
    const { ctx: nightCtx, page: night } = await open({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    await night.addInitScript(() => localStorage.setItem('cld.office-hours', '{"on":true}'));
    await night.goto(await started.loginUrl());
    await night.waitForURL(`http://127.0.0.1:${port}/`);
    await night.addStyleTag({ content: FONT_CSS });
    const sleeper = night.locator('[data-testid="agent-card"]').filter({ hasText: 'sleeper' }).first();
    await sleeper.waitFor({ timeout: 30_000 });
    const detail = night.locator('[data-testid="stat-detail"]');
    // A card tap focuses the resting character and opens its menu (owner 11-01 04:37); 스탯 is there.
    const menuStat = night.locator('[role="menu"] [data-testid="stat-open"]');
    await until('a tap on the card opens the character menu, not the stats view', async () => {
      await sleeper.tap();
      return (await menuStat.count()) > 0 && (await detail.count()) === 0;
    }, 15_000);
    await until('its 스탯 item opens the stats view', async () => {
      await menuStat.first().tap();
      return (await detail.count()) > 0;
    }, 15_000);
    check((await night.getByTestId('off-duty-sheet').count()) === 0, 'no old off-duty sheet');
    check((await night.getByTestId('off-duty-open').count()) === 0, 'no old info button');
    check(/스탯/.test((await night.locator('[data-modal-title]').first().textContent()) ?? ''), 'the view is titled 스탯');
    const start = detail.getByTestId('stat-start');
    if (process.env.DEBUG_STAT) console.log('detail text:', ((await detail.innerText()) ?? '').replace(/\s+/g, ' ').slice(0, 300), 'start:', await start.count());
    check((await start.count()) === 1 && (await start.textContent()) === '켜기', 'a 켜기 button for the sleeping agent');
    check(((await detail.getByTestId('stat-wake-hint').count()) === 0) === !(await detail.getByRole('button', { name: '대화 열기' }).count()), 'the wake-up line shows with the chat button');
    await night.waitForTimeout(500);
    await shot(night, 'off-stat-tiles');
    await detail.getByTestId('stat-toggle').tap();
    await detail.getByTestId('stat-list').waitFor();
    const listText = (await detail.getByTestId('stat-list').innerText()).replace(/\s+/g, ' ');
    check(/제공자/.test(listText) && /엔진/.test(listText), `the list names the provider (${listText.slice(0, 120)})`);
    check(/방/.test(listText) && /orch-2/.test(listText), 'the list names the room');
    check(/폴더/.test(listText) && /\/work\/sleeper/.test(listText), 'the list names the folder');
    check(/상태/.test(listText) && /꺼져 있어요|퇴근했어요/.test(listText), 'the list says why it is not working');
    await night.waitForTimeout(300);
    await shot(night, 'off-stat-list');
    await start.tap();
    await night.getByRole('button', { name: '켜기' }).last().waitFor({ timeout: 5_000 });
    check(true, '켜기 asks the same confirmation as the card');
    await shot(night, 'off-stat-start-confirm');
    await night.getByRole('button', { name: '취소' }).tap();
    await detail.getByTestId('stat-toggle').tap();
    await night.getByRole('button', { name: 'x', exact: true }).first().tap();
    await detail.waitFor({ state: 'detached' });
    await night.waitForTimeout(600);
    await shot(night, 'off-summary');
    check((await night.getByTestId('off-duty-open').count()) === 0, 'the off agent summary has no info button');
    await nightCtx.close();

    // ── Desktop: a card tap and the panel button open the same view ──
    const { page: desk } = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await desk.addInitScript(() => localStorage.setItem('cld.office-hours', '{"on":true}'));
    await desk.goto(await started.loginUrl());
    await desk.waitForURL(`http://127.0.0.1:${port}/`);
    await desk.addStyleTag({ content: FONT_CSS });
    const dCard = desk.locator('[data-testid="agent-card"]').filter({ hasText: 'sleeper' }).first();
    await dCard.waitFor({ timeout: 30_000 });
    const dd = desk.locator('[data-testid="stat-detail"]');
    const dMenuStat = desk.locator('[role="menu"] [data-testid="stat-open"]');
    await until('a card click opens the character menu, not the stats view', async () => {
      await dCard.click();
      return (await dMenuStat.count()) > 0 && (await dd.count()) === 0;
    }, 15_000);
    await until('its 스탯 item opens the stats view', async () => {
      await dMenuStat.first().click();
      return (await dd.count()) > 0;
    }, 15_000);
    await desk.waitForTimeout(500);
    await shot(desk, 'desktop-card-path');
    await desk.getByRole('button', { name: 'x', exact: true }).first().click();
    await openOfficeWindow(desk);
    const win = desk.locator('[data-hud-window="office"]');
    const open1 = win.locator('[data-testid="stat-open"]');
    await until('the panel card opens', async () => {
      if ((await open1.count()) === 0) {
        const head = win.locator('article h3 button').first();
        if (await head.count()) await head.click();
      }
      return (await open1.count()) > 0;
    });
    check(((await open1.first().textContent()) ?? '').trim() === '스탯', 'the panel button reads 스탯');
    await shot(desk, 'desktop-panel-card');
    await open1.first().click();
    await dd.waitFor({ timeout: 5_000 });
    check(true, 'the panel button opens the stats view');
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
