/**
 * UX-POLISH (owner 11-03 12:18), end to end: dist/cli.js in a temp HOME on a spare port, a temp
 * repository `shop-web` whose Task T-1 worktree holds one modified file and one new file (the engine's
 * fake claude as Lead/Worker, never a real claude). Desktop (Chromium --disable-gpu, 1280x800):
 *  - the dev room's diff gutter: a new file shows one number column, a modified file two, each only as
 *    wide as its largest number; the text zoom (−, %, +, Ctrl+wheel) scales the diff and is remembered;
 *  - the 파일 window: 최근 산출물 folds (count, remembered over a reload), long lists end in 더 보기;
 *    a file's preview and the CodeMirror editor zoom; 메신저로 보내기 leaves the file open.
 * Screenshots in agent-tycoon/artifacts/ux-polish/.
 *
 *   nice -n 10 npx tsx agent-tycoon/test/run-ux-polish.ts <port 18268|18269>
 */
import type { Browser, Page } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { makeTempRepo } from '../../server/src/agent-tycoon/engine/git/testRepo.js';
import type { WorktreeRecord } from '../../server/src/agent-tycoon/engine/git/worktrees.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (port !== 18268 && port !== 18269) throw new Error('port: 18268 or 18269');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/ux-polish');
const DEADLINE_MS = 300_000;
let oks = 0;

const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  oks++;
  console.log(`ok - ${text}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(what: string, test: () => boolean, timeout = 30_000): Promise<void> {
  for (const end = Date.now() + timeout; ; await wait(200)) {
    if (test()) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}

const CART_BASE = ['export function Cart() {', '  const total = 0', '  return total', '}', ''].join('\n');
const CART_NEW = ['export function Cart() {', '  const total = sumPrice(items)', '  const label = formatWon(total)', '  return label', '}', ''].join('\n');
const TOTALS = Array.from({ length: 120 }, (_, i) => `export const total${i + 1} = ${i + 1};`).join('\n') + '\n';
const REPORT = ['# Report', '', 'Some **bold** words and `code`.', '', ...Array.from({ length: 12 }, (_, i) => `- item ${i + 1}`), ''].join('\n');

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const repo = makeTempRepo();
  const folder = repo.folder;
  repo.write('src/Cart.tsx', CART_BASE);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'base']);
  // An image wider than the preview pane (written first: older than the reports, so not among the 8 newest).
  repo.write('pics/wide.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="400"><rect width="1600" height="400" fill="#3a6"/><rect x="40" y="40" width="200" height="100" fill="#fff"/></svg>');
  for (let i = 1; i <= 12; i++) repo.write(`out/report-${String(i).padStart(2, '0')}.md`, REPORT);
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify({ v: 2, projects: [{ projectId: 'p_aaaaaaaaaa', name: 'shop-web', folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }] }),
  );
  fs.writeFileSync(
    path.join(cfg, 'assignments.json'),
    JSON.stringify({ v: 1, assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true }] }),
  );
  const PATH = [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    { PATH, FAKE_TURN_MS: '400', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C.UTF-8' },
    true,
  );
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL');
  }, DEADLINE_MS);
  try {
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [path.join(REPO_ROOT, 'agent-tycoon/bin/agty'), ...args], {
        env: { PATH, HOME: home, AGTY_OUTPUT: 'json' },
        encoding: 'utf8',
        timeout: 60_000,
      });
    const json = (r: ReturnType<typeof cli>) => JSON.parse(r.stdout || '{}') as Record<string, any>;
    const session = (name: string) =>
      fs.readdirSync(path.join(home, '.claude/sessions')).some((file) => {
        try {
          return (JSON.parse(fs.readFileSync(path.join(home, '.claude/sessions', file), 'utf8')) as { name: string }).name === name;
        } catch {
          return false;
        }
      });
    await daemon.loginUrl();
    await eventually('the Lead revived', () => session('shop-web'));
    check(json(cli('worker', 'add', 'shop-web', 'web-worker')).ok === true, 'Worker web-worker added');
    check(json(cli('task', 'add', 'cart total', '--project', 'shop-web', '--assignee', 'web-worker', '--status', 'review')).task?.id === 'T-1', 'Task T-1');
    check(json(cli('worktree', 'new', '--task', 'T-1', '--assign', 'web-worker')).ok === true, 'T-1 gets a worktree');
    const wt = (JSON.parse(fs.readFileSync(path.join(cfg, 'worktrees.json'), 'utf8')) as WorktreeRecord[])[0];
    fs.writeFileSync(path.join(wt.path, 'src/Cart.tsx'), CART_NEW);
    fs.writeFileSync(path.join(wt.path, 'src/Totals.ts'), TOTALS);
    repo.git(['add', '-A'], wt.path);
    repo.git(['commit', '-q', '-m', 'cart total'], wt.path);

    browser = await launchBrowser();
    const seen = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript((v) => localStorage.setItem('agty.changelogSeen', v), seen);
    const desk = await ctx.newPage();
    const open = async () => {
      await desk.goto(await daemon.loginUrl());
      await desk.waitForURL(`http://127.0.0.1:${port}/`);
    };
    await open();
    const shot = async (name: string) => {
      await desk.evaluate(() => {
        for (const b of document.querySelectorAll('button')) {
          if (b.textContent?.trim() === '×' && /업데이트됐어요|새 기기 로그인/.test(b.parentElement?.textContent ?? '')) b.click();
        }
      });
      await desk.waitForTimeout(300);
      await desk.screenshot({ path: path.join(OUT, `${name}.png`) });
    };
    const fontPx = (sel: string) => desk.locator(sel).first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));

    // ── Dev room diff: compact gutter and zoom ──
    await desk.locator('[data-hud-id="icon:devroom"] button').click();
    const win = desk.locator('[data-hud-window="devroom"]');
    await win.waitFor({ timeout: 20_000 });
    await win.getByTestId('hud-title-devroom').dblclick();
    const card = win.locator(`[data-testid="devroom-card"][data-task="${wt.task}"]`);
    await card.waitFor({ timeout: 20_000 });
    await card.click();
    await win.locator('[role="tab"][data-tab="changes"]').click();
    const review = win.getByTestId('task-review');
    await review.waitFor({ timeout: 20_000 });
    const fileBox = (file: string) => review.locator(`[data-testid="review-file"][data-file="${file}"]`);
    await fileBox('src/Totals.ts').locator('[data-testid="review-row"][data-new="120"]').waitFor({ timeout: 20_000 });
    await fileBox('src/Cart.tsx').locator('[data-testid="review-row"][data-new="3"]').waitFor({ timeout: 20_000 });
    const cols = (file: string) =>
      fileBox(file).locator('[data-testid="review-row"][data-new]').nth(1).evaluate((e) => ({ kids: e.children.length, tpl: (e as HTMLElement).style.gridTemplateColumns }));
    const added = await cols('src/Totals.ts');
    check(added.kids === 2 && added.tpl === '4ch 1fr', `a new file has one number column, as wide as 120 (${added.tpl})`);
    const modified = await cols('src/Cart.tsx');
    check(modified.kids === 3 && modified.tpl === '2ch 2ch 1fr', `a modified file has two columns (${modified.tpl})`);
    check((await fileBox('src/Totals.ts').locator('[data-testid="review-row"][data-new="1"]').innerText()).includes('+export const total1'), 'the + marker stays');
    await win.getByTestId('hud-title-devroom').dblclick().catch(() => undefined);
    await fileBox('src/Totals.ts').scrollIntoViewIfNeeded();
    await shot('diff-new-file-compact');
    await fileBox('src/Cart.tsx').scrollIntoViewIfNeeded();
    await shot('diff-modified-compact');

    // A review note still anchors on the line number (the row key / newNo).
    await fileBox('src/Cart.tsx').locator('[data-testid="review-row"][data-new="2"]').click();
    await review.getByTestId('review-input').fill('anchor check');
    await review.getByTestId('review-add').click();
    await desk.waitForFunction(() => document.querySelectorAll('[data-testid="review-note"]').length === 1, null, { timeout: 10_000 });
    check(true, 'a review note on line 2 is added (anchors use line numbers)');

    const base = await fontPx('[data-testid="review-diff"]');
    const bar = review.getByTestId('zoom-diff');
    await bar.getByRole('button', { name: '글자 키우기' }).click();
    await bar.getByRole('button', { name: '글자 키우기' }).click();
    check((await bar.getAttribute('data-zoom')) === '1.3', 'zoom + twice: 130%');
    const big = await fontPx('[data-testid="review-diff"]');
    check(Math.abs(big / base - 1.3) < 0.02, `the diff text is 1.3x (${base} -> ${big})`);
    await desk.mouse.move(700, 500);
    await desk.keyboard.down('Control');
    await desk.mouse.wheel(0, 100);
    await desk.keyboard.up('Control');
    await desk.waitForTimeout(200);
    check((await bar.getAttribute('data-zoom')) === '1.15', 'Ctrl + wheel down: one step smaller');
    await bar.getByRole('button', { name: '글자 키우기' }).click();
    await bar.getByRole('button', { name: '글자 키우기' }).click();
    await shot('diff-zoomed');
    await open();
    await desk.locator('[data-hud-id="icon:devroom"] button').click().catch(() => undefined);
    await desk.waitForTimeout(500);
    check(await desk.evaluate(() => localStorage.getItem('agty.textzoom.diff')) === '1.5', 'the diff zoom is remembered in the browser');
    await desk.evaluate(() => localStorage.removeItem('agty.textzoom.diff'));

    // ── 파일 window: 최근 산출물 ──
    await desk.locator('[data-hud-id="icon:files"] button').click();
    const files = desk.locator('section[aria-label="파일 탐색"]');
    await files.waitFor({ timeout: 20_000 });
    const recent = files.getByTestId('recent-outputs');
    await recent.waitFor({ timeout: 20_000 });
    const toggle = recent.getByTestId('recent-toggle');
    const total = await recent.locator('button[title]').count();
    check(total === 8, `a long list shows the newest 8 first (${total})`);
    check((await toggle.innerText()).includes('·'), 'the fold header carries the count: ' + (await toggle.innerText()).replace(/\n/g, ' '));
    await recent.getByTestId('recent-more').click();
    check((await recent.locator('button[title]').count()) > 8, '더 보기 shows more');
    await toggle.click();
    check((await recent.locator('button[title]').count()) === 0 && (await toggle.getAttribute('aria-expanded')) === 'false', 'folded: no entries, still the header');
    await shot('recent-folded');
    await open();
    await desk.locator('[data-hud-id="icon:files"] button').click();
    await files.getByTestId('recent-toggle').waitFor({ timeout: 20_000 });
    check((await files.getByTestId('recent-toggle').getAttribute('aria-expanded')) === 'false', 'the fold is remembered over a reload');
    await files.getByTestId('recent-toggle').click();
    check((await files.getByTestId('recent-outputs').locator('button[title]').count()) === 8, 'unfolded again (the first 8)');
    await shot('recent-open');

    // ── Preview and editor zoom, send keeps the file open ──
    await files.getByTestId('recent-outputs').locator('button[title]').first().click();
    const pane = files.getByLabel('파일 미리보기');
    await pane.getByText('Some').first().waitFor({ timeout: 10_000 });
    const pBase = await fontPx('[aria-label="파일 미리보기"] ul');
    const pz = pane.getByTestId('zoom-preview');
    for (let i = 0; i < 3; i++) await pz.getByRole('button', { name: '글자 키우기' }).click();
    check((await pz.getAttribute('data-zoom')) === '1.5', 'preview zoom + x3 = 150%');
    const pBig = await fontPx('[aria-label="파일 미리보기"] ul');
    check(pBig > pBase * 1.4 || (await pane.locator('div[style*="zoom"]').count()) > 0, `the preview is zoomed (CSS zoom, list font ${pBase} -> ${pBig})`);
    await shot('preview-zoomed');
    await pane.getByTestId('edit-switch').click();
    const cm = pane.getByTestId('code-editor').locator('.cm-content');
    await cm.waitFor({ timeout: 20_000 });
    const eBase = await fontPx('.cm-scroller');
    const ez = pane.getByTestId('zoom-editor');
    await cm.click();
    await desk.keyboard.press('Control+=');
    await desk.keyboard.press('Control+=');
    await desk.waitForTimeout(300);
    check((await ez.getAttribute('data-zoom')) === '1.3', 'editor: Ctrl + = twice = 130%');
    const eBig = await fontPx('.cm-scroller');
    check(Math.abs(eBig / eBase - 1.3) < 0.02, `the editor text is 1.3x (${eBase} -> ${eBig})`);
    await shot('editor-zoomed');
    await desk.keyboard.press('Control+0');
    check((await ez.getAttribute('data-zoom')) === '1', 'Ctrl + 0 resets');
    await pane.getByTestId('edit-switch').click();
    await pane.getByRole('button', { name: '메신저로 보내기' }).click();
    await desk.waitForTimeout(500);
    check((await files.getByLabel('파일 미리보기').count()) === 1, '메신저로 보내기 leaves the file open in the explorer');
    await shot('sent-file-still-open');

    // ── An image grows past the pane's width (owner 11-03 13:04: it stopped once it fit the width) ──
    await files.getByRole('button', { name: 'pics', exact: true }).click();
    await files.getByRole('button', { name: 'wide.svg', exact: true }).click();
    const img = files.getByLabel('파일 미리보기').locator('img');
    await img.waitFor({ timeout: 10_000 });
    await desk.waitForFunction(() => (document.querySelector<HTMLImageElement>('[aria-label="파일 미리보기"] img')?.naturalWidth ?? 0) > 0);
    await img.click();
    await desk.keyboard.press('Control+0');
    const w1 = (await img.boundingBox())?.width ?? 0;
    const iz = files.getByLabel('파일 미리보기').getByTestId('zoom-preview');
    for (let i = 0; i < 7; i++) await iz.getByRole('button', { name: '글자 키우기' }).click();
    check((await iz.getAttribute('data-zoom')) === '3', 'image zoom + x7 = 300%');
    const w3 = (await img.boundingBox())?.width ?? 0;
    const scrolls = await desk.evaluate(() => {
      const box = document.querySelector<HTMLElement>('[aria-label="파일 미리보기"]');
      return box ? box.scrollWidth > box.clientWidth : false;
    });
    check(w1 > 0 && Math.abs(w3 / w1 - 3) < 0.05 && scrolls, `the image is 3x its fitted width (${Math.round(w1)} -> ${Math.round(w3)} px) and the pane scrolls`);
    await shot('image-zoomed');
    await desk.keyboard.press('Control+0');

    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    fs.writeFileSync(path.join(os.tmpdir(), 'run-ux-polish.daemon.log'), daemon.log.join(''));
    console.error(err);
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    repo.cleanup();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
