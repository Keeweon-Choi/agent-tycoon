/**
 * P4-S6, the 개발실's 미리보기 tab end to end: dist/cli.js in a temp HOME on a spare port, a temp
 * repository, the engine's fake claude as Lead `shop-web` with one Worker and a Task worktree, and a
 * tiny local http server (OS-assigned port) as the "dev server" (never a real one). Desktop
 * (Chromium --disable-gpu, 1280x800, a loopback page = the PC): the tab is empty first, a foreign
 * address and the office's own port are refused, a pasted `Local:` + `Network:` log loads the page in
 * the sandboxed iframe (no Referer sent, loaded from the dev server itself) and warns that the dev
 * server is open to the network (mock-up P1). Phone (390x844, touch): the tab is mock-up P2; its
 * button makes a notice on the PC screen, whose tap opens the 미리보기. Screenshots in
 * cld/artifacts/p4-s6/.
 *
 *   nice -n 10 npx tsx cld/test/run-devroom-preview.ts <port 18268|18269>
 */
import type { Browser, Page } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import type { WorktreeRecord } from '../../server/src/cld/engine/git/worktrees.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (port !== 18268 && port !== 18269) throw new Error('port: 18268 or 18269');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/p4-s6');
const DEADLINE_MS = 240_000;
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

/** The mock-up's MINI SHOP, served as the dev server's page; remembers what each request carried. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>mini shop</title>
<style>body{margin:0;font:15px sans-serif;background:#fffaf0;color:#222}header{background:#2d3a5c;color:#fff;padding:12px 14px;display:flex;justify-content:space-between}
.sale{background:#f3d9a6;padding:14px;display:flex;justify-content:space-between;align-items:center}.sale b{background:#d9534f;color:#fff;padding:12px 14px}
.row{display:flex;gap:12px;padding:12px}.card{flex:1;border:2px solid #d8caa8;background:#fff;padding:10px}.card p{margin:4px 0}.card i{color:#d9534f;font-style:normal}
button{width:100%;background:#2d3a5c;color:#fff;border:0;padding:8px;margin-top:8px}.sum{margin:0 12px;padding:10px;background:#efe6d3;display:flex;justify-content:space-between}</style>
<header><span>MINI SHOP</span><span>장바구니 (2)</span></header>
<div class="sale"><div><h3 style="margin:0">가을맞이 할인</h3><small>머그컵, 모자, 양말을 골라 보세요</small></div><b>-20%</b></div>
<div class="row"><div class="card"><p>머그컵</p><i>12,000원</i><button>담기</button></div><div class="card"><p>야구 모자</p><i>18,000원</i><button>담기</button></div><div class="card"><p>양말 세트</p><i>6,000원</i><button>담기</button></div></div>
<div class="sum"><span>합계</span><span>30,000원</span></div>`;

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const seen: { referer: string | undefined }[] = [];
  const dev = http.createServer((req, res) => {
    seen.push({ referer: req.headers.referer });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
  });
  await new Promise<void>((resolve) => dev.listen(0, '127.0.0.1', resolve));
  const devPort = (dev.address() as AddressInfo).port;
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const repo = makeTempRepo();
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify({ v: 2, projects: [{ projectId: 'p_aaaaaaaaaa', name: 'shop-web', folder: repo.folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }] }),
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
    { PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C.UTF-8' },
    true,
  );
  console.log(`daemon pid ${daemon.child.pid} on ${port}, dev server on ${devPort}, HOME ${home}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL');
  }, DEADLINE_MS);
  try {
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args], {
        env: { PATH, HOME: home, CLD_OUTPUT: 'json' },
        encoding: 'utf8',
        timeout: 60_000,
      });
    const json = (r: ReturnType<typeof cli>) => JSON.parse(r.stdout || '{}') as Record<string, any>;
    await daemon.loginUrl();
    check(json(cli('worker', 'add', 'shop-web', 'web-worker')).ok === true, 'Worker web-worker added');
    const id = json(cli('task', 'add', '장바구니 합계 계산 분리', '--project', 'shop-web', '--assignee', 'web-worker', '--status', 'doing')).task?.id as string;
    check(json(cli('worktree', 'new', '--task', id, '--assign', 'web-worker')).ok === true, `${id} gets a worktree`);
    const wt = (JSON.parse(fs.readFileSync(path.join(cfg, 'worktrees.json'), 'utf8')) as WorktreeRecord[]).find((r) => r.taskId === id)!;

    browser = await launchBrowser();
    const version = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version.split('.').slice(0, 2).join('.');
    const newPage = async (b: Browser, opts: Parameters<Browser['newContext']>[0]) => {
      const ctx = await b.newContext(opts);
      await ctx.addInitScript((v) => localStorage.setItem('cld.changelogSeen', v), version);
      const p = await ctx.newPage();
      await p.goto(await daemon.loginUrl());
      await p.waitForURL(`http://127.0.0.1:${port}/`);
      return p;
    };
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });

    // ── Desktop: this page is served from loopback, so it is the PC. ──
    const desk = await newPage(browser, { viewport: { width: 1280, height: 800 } });
    await desk.locator('[data-hud-id="icon:devroom"] button').click();
    const win = desk.locator('[data-hud-window="devroom"]');
    await win.waitFor({ timeout: 20_000 });
    await win.getByTestId('hud-title-devroom').dblclick();
    const card = win.locator(`[data-testid="devroom-card"][data-task="${wt.task}"]`);
    await card.waitFor({ timeout: 20_000 });
    await card.click();
    await win.locator('[data-tab="preview"]').click();
    await win.getByTestId('preview-empty').waitFor();
    check(true, '미리보기 tab: empty until an address is given');

    const box = win.getByTestId('preview-url');
    for (const [text, why] of [
      ['http://example.com/', 'a foreign address'],
      ['192.168.0.7:5173', 'a LAN address'],
      [`localhost:${port}`, "the office's own port"],
    ] as const) {
      await box.fill(text);
      await box.press('Enter');
      await win.getByTestId('preview-error').waitFor();
      check((await win.getByTestId('preview').getAttribute('data-url')) === '', `${why} is refused, nothing loads`);
    }
    check((await win.locator('iframe').count()) === 0 && seen.length === 0, 'no iframe and no request reached the dev server');

    await box.fill(`  ➜  Local:   http://localhost:${devPort}/\n  ➜  Network: http://192.168.0.7:${devPort}/`);
    await box.press('Enter');
    const frame = win.getByTestId('preview-frame');
    await frame.waitFor();
    check(await desk.frameLocator('[data-testid="preview-frame"]').getByText('MINI SHOP').isVisible(), "the dev server's page shows in the iframe (CSP frame-src allows loopback)");
    check((await frame.getAttribute('sandbox')) === 'allow-scripts allow-same-origin allow-forms allow-popups', 'the iframe is sandboxed (no top navigation, no modals)');
    check((await frame.getAttribute('referrerpolicy')) === 'no-referrer', 'the iframe sends no referrer');
    check(seen.length >= 1 && seen.every((s) => s.referer === undefined), 'the dev server saw no Referer (the page url carries the token)');
    check((await box.inputValue()) === `localhost:${devPort}`, 'the box shows the plain address');
    await win.getByTestId('preview-exposed').waitFor();
    check(true, 'a Network: line warns that the dev server is open to the network');
    const before = seen.length;
    await win.getByTestId('preview-reload').click();
    await eventually('the reload reached the dev server', () => seen.length > before);
    check(true, '↻ loads the page again');
    check((await win.getByTestId('preview-footer').innerText()).includes('1'), 'the footer counts the open preview');
    await desk.waitForTimeout(500);
    await shot(desk, 'P1-desktop');

    // ── Phone: P2, then the notice on the PC. ──
    const phone = await newPage(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await phone.locator('[data-dock="devroom"]').tap();
    const list = phone.getByTestId('devroom-phone');
    const pcard = list.locator(`[data-testid="devroom-card"][data-task="${wt.task}"]`);
    await pcard.waitFor({ timeout: 20_000 });
    await pcard.locator('b').tap();
    await pcard.locator('[data-page="preview"]').tap();
    await list.getByTestId('preview-phone').waitFor();
    check((await list.locator('iframe').count()) === 0, 'phone: no iframe, only the ask');
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `phone: no sideways scroll (${overflow})`);
    await phone.waitForTimeout(400);
    await shot(phone, 'P2-phone');
    await list.getByTestId('preview-ask').tap();
    const toast = desk.getByTestId('notice-toast');
    await toast.waitFor({ timeout: 15_000 });
    check((await toast.innerText()).includes('미리보기 열기'), `the PC screen gets the notice: ${(await toast.innerText()).replace(/\n/g, ' / ')}`);
    check((await phone.getByTestId('notice-toast').count()) === 0, 'the phone makes no notice of its own ask');
    await shot(desk, 'P1-notice');
    await win.locator('[data-tab="terminal"]').click(); // away from it, so the toast's tap is what brings it back
    await toast.click();
    await desk.waitForFunction(() => document.querySelector('[data-testid="devroom-body"]')?.getAttribute('data-tab') === 'preview');
    check(true, "the notice's tap opens the 미리보기 on that worktree");

    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    fs.writeFileSync(path.join(os.tmpdir(), 'run-devroom-preview.daemon.log'), daemon.log.join(''));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    dev.close();
    killFakeSessions(home);
    repo.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
