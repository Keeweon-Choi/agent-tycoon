/**
 * DEVROOM-SIDEBAR (owner 11-06 22:05 and 22:11), the 개발실 rail as Orca's sidebar, end to end:
 * dist/cli.js in a temp HOME on a spare port, two temp repositories as projects `shop-web` and
 * `blog`, the engine's fake claude (PTY host, never a real claude) as their Leads and one Worker.
 * shop-web has an engine worktree (the Worker's) and two external ones made with `git worktree add`
 * (one gets hidden). The Lead's transcript gets four sub-agents: one edits in the engine worktree,
 * one runs tests in the external worktree, one only fetches a web page (no path: under main, `?`),
 * one finished. Desktop (Chromium --disable-gpu, 1920x1080) in 모던 and 픽셀 감성: each sub-agent's
 * row sits under its worktree, a click opens its transcript in the pane; phone (WebKit 390x844):
 * the same rows in the list. Screenshots in cld/artifacts/feat-devroom-worktree-sidebar/.
 *
 *   nice -n 10 npx tsx cld/test/run-devroom-worktree-sidebar.ts <port 18293|18294>
 */
import type { Browser, Page } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import { assertPortFree, killFakeSessions, launchBrowser, makeEngineHome, REPO_ROOT, startDaemon } from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (port !== 18293 && port !== 18294) throw new Error('port: 18293 or 18294');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/feat-devroom-worktree-sidebar');
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

type Rec = Record<string, unknown>;
let seq = 0;
const stamp = (r: Rec, cwd: string): Rec => ({ uuid: `u-${++seq}`, timestamp: new Date().toISOString(), cwd, ...r });
const call = (id: string, name: string, input: Rec) => ({ type: 'tool_use', id, name, input });
const text = (s: string) => ({ type: 'text', text: s });

async function main() {
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const shop = makeTempRepo();
  const blog = makeTempRepo();
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify({
      v: 2,
      projects: [
        { projectId: 'p_aaaaaaaaaa', name: 'shop-web', folder: shop.folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' },
        { projectId: 'p_bbbbbbbbbb', name: 'blog', folder: blog.folder, room: '개발실', leadAssignmentId: 'a_bbbbbbbbbb' },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(cfg, 'assignments.json'),
    JSON.stringify({
      v: 1,
      assignments: [
        { assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude-pty', wantRunning: true },
        { assignmentId: 'a_bbbbbbbbbb', projectId: 'p_bbbbbbbbbb', role: 'lead', provider: 'claude-pty', wantRunning: true },
      ],
    }),
  );
  // Two worktrees the Lead made itself (outside the engine), one with a commit and a loose file.
  const search = path.join(shop.folder, '.worktrees', 'feat-search');
  const login = path.join(shop.folder, '.worktrees', 'fix-login');
  shop.git(['worktree', 'add', '-q', search, '-b', 'feat/search']);
  shop.git(['worktree', 'add', '-q', login, '-b', 'fix/login']);
  fs.writeFileSync(path.join(search, 'search.ts'), 'export const q = 1;\n');
  shop.git(['add', 'search.ts'], search);
  shop.git(['commit', '-q', '-m', 'search'], search);
  fs.writeFileSync(path.join(search, 'loose.txt'), 'l\n');

  const PATH = [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    { PATH, FAKE_TURN_MS: '240000', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C.UTF-8' },
    true,
  );
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  let phoneBrowser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL');
  }, DEADLINE_MS);
  try {
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args], { env: { PATH, HOME: home, CLD_OUTPUT: 'json' }, encoding: 'utf8', timeout: 60_000 });
    const json = (r: ReturnType<typeof cli>) => JSON.parse(r.stdout || '{}') as Record<string, any>;
    const sessionOf = (name: string) => {
      for (const file of fs.readdirSync(path.join(home, '.claude/sessions'))) {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(home, '.claude/sessions', file), 'utf8')) as { name: string; sessionId: string; cwd: string };
          if (s.name === name) return s;
        } catch {
          /* written as we read */
        }
      }
      return undefined;
    };
    const transcriptOf = (name: string) => {
      const s = sessionOf(name);
      return s && path.join(home, '.claude/projects', s.cwd.replace(/[^a-zA-Z0-9-]/g, '-'), `${s.sessionId}.jsonl`);
    };
    await daemon.loginUrl();
    await eventually('the Leads revived', () => !!sessionOf('shop-web') && !!sessionOf('blog'), 60_000);
    check(json(cli('worker', 'add', 'shop-web', 'web-worker')).ok === true, 'Worker web-worker added');
    const id = json(cli('task', 'add', '장바구니 합계', '--project', 'shop-web', '--assignee', 'web-worker', '--status', 'doing')).task?.id as string;
    const before = new Set(fs.readdirSync(path.join(shop.folder, '.worktrees')));
    check(json(cli('worktree', 'new', '--task', id, '--assign', 'web-worker')).ok === true, `${id} gets an engine worktree`);
    const cartTask = fs.readdirSync(path.join(shop.folder, '.worktrees')).find((d) => !before.has(d))!;
    const cart = path.join(shop.folder, '.worktrees', cartTask);
    check(cartTask, `the engine worktree is ${cartTask}`);

    await eventually("the Lead's transcript", () => { const f = transcriptOf('shop-web'); return !!f && fs.existsSync(f); });
    const lead = transcriptOf('shop-web')!;
    const at = (r: Rec) => stamp(r, shop.folder);
    const said = (content: Rec[]): Rec => ({ type: 'assistant', message: { model: 'claude-opus-4-5', content } });
    const result = (tid: string, content: string): Rec => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: tid, content }] } });
    const sub = (parent: string, msg: Rec): Rec => at({ type: 'progress', parentToolUseID: parent, data: { type: 'agent_progress', message: msg } });
    const SUBS = [
      { id: 'tu-cart', desc: '장바구니 합계 고치기' },
      { id: 'tu-search', desc: '검색 테스트 돌리기' },
      { id: 'tu-docs', desc: '결제 문서 조사' },
      { id: 'tu-readme', desc: 'README 읽기' },
    ];
    const records: Rec[] = [
      at(said([text('네 갈래로 나눠 맡길게요.'), ...SUBS.map((s) => call(s.id, 'Agent', { description: s.desc, prompt: s.desc, subagent_type: 'general-purpose' }))])),
      sub('tu-cart', said([call('c1', 'Read', { file_path: path.join(cart, 'README.md') })])),
      sub('tu-cart', result('c1', '# shop')),
      sub('tu-cart', said([call('c2', 'Edit', { file_path: path.join(cart, 'cart.ts'), old_string: 'a', new_string: 'b' })])),
      sub('tu-search', said([call('s1', 'Bash', { command: `cd ${search} && npm test`, description: '검색 테스트' })])),
      sub('tu-search', result('s1', 'ok')),
      sub('tu-search', said([call('s2', 'Read', { file_path: path.join(search, 'search.ts') })])),
      sub('tu-docs', said([call('d1', 'WebFetch', { url: 'https://docs.example.com/pay', prompt: '환불' })])),
      sub('tu-readme', said([call('r1', 'Read', { file_path: path.join(shop.folder, 'README.md') })])),
      sub('tu-readme', result('r1', '# shop')),
    ];
    for (const r of records) fs.appendFileSync(lead, `${JSON.stringify(r)}\n`);

    browser = await launchBrowser();
    const seen = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version.split('.').slice(0, 2).join('.');
    const newPage = async (b: Browser, opts: Parameters<Browser['newContext']>[0], theme = 'modern') => {
      const ctx = await b.newContext(opts);
      await ctx.addInitScript(([v, th]) => {
        localStorage.setItem('cld.changelogSeen', v);
        localStorage.setItem('cld.ui-theme', th);
      }, [seen, theme]);
      const p = await ctx.newPage();
      await p.goto(await daemon.loginUrl());
      await p.waitForURL(`http://127.0.0.1:${port}/`);
      const toast = await p.getByText(/으로 업데이트됐어요/).first().textContent({ timeout: 5_000 }).catch(() => null);
      const v = toast?.match(/v([\d.]+)/)?.[1];
      if (v) {
        await p.evaluate((x) => localStorage.setItem('cld.changelogSeen', x), v);
        await p.reload();
      }
      return p;
    };
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
    const subRow = (p: Page, sid: string) => p.locator(`[data-testid="devroom-agent-row"][data-sub$=":${sid}"]`).first();
    /** Which worktree group a sub-agent's row sits in: an external path, else the rows' label (task or project). */
    const whereIs = (p: Page, sid: string) =>
      subRow(p, sid).evaluate((el) => {
        const ext = el.closest('[data-testid="devroom-external"]');
        if (ext) return `external:${ext.getAttribute('data-path')}`;
        return el.closest('[data-testid="devroom-agent-rows"]')?.getAttribute('aria-label') ?? '';
      });

    // ── Desktop, 모던 ──
    const openRail = async (p: Page) => {
      await p.locator('[data-hud-id="icon:devroom"] button').click();
      const win = p.locator('[data-hud-window="devroom"]');
      await win.waitFor({ timeout: 20_000 });
      await win.getByTestId('hud-title-devroom').dblclick();
      await win.getByTestId('devroom-external').first().waitFor({ timeout: 30_000 });
      await subRow(p, 'tu-search').waitFor({ timeout: 30_000 });
      return win;
    };
    const desk = await newPage(browser, { viewport: { width: 1920, height: 1080 } });
    const win = await openRail(desk);
    check((await win.getByTestId('devroom-project-head').count()) === 2, 'two project heads, each its own band');
    check((await win.getByTestId('devroom-external').count()) === 2, 'both external worktrees are listed');
    const marks = await win.locator(`[data-testid="devroom-external"][data-path="${search}"] [data-testid="devroom-marks"]`).innerText();
    check(marks.includes('↑1') && marks.includes('●1'), `the external one with a commit and a loose file reads ${marks}`);
    check(await win.locator('[data-testid="devroom-agent-row"][data-role="lead"][data-agent="shop-web"]').count(), 'the Lead has its own row');
    check(await win.locator('[data-testid="devroom-agent-row"][data-role="worker"][data-agent="web-worker"]').count(), 'and the Worker');
    const wCart = await whereIs(desk, 'tu-cart');
    check(wCart.includes(cartTask), `the cart sub-agent sits under the engine worktree (${wCart})`);
    const wSearch = await whereIs(desk, 'tu-search');
    check(wSearch === `external:${search}`, `the search sub-agent sits under the external worktree (${wSearch})`);
    const docs = subRow(desk, 'tu-docs');
    check((await docs.getAttribute('data-unknown')) === 'true' && (await whereIs(desk, 'tu-docs')).includes('shop-web'), 'the web look-up has no path: under main, marked unknown');
    // One sub-agent finishes while the rail looks (a finished one is remembered from then on).
    fs.appendFileSync(lead, `${JSON.stringify(at(result('tu-readme', 'README 를 읽었어요.')))}\n`);
    const readme = () =>
      desk.evaluate(() => {
        const el = document.querySelector('[data-testid="devroom-agent-row"][data-sub$=":tu-readme"]');
        return el ? `${el.getAttribute('data-dot')} ${el.textContent}` : 'gone';
      });
    let last = '';
    for (const end = Date.now() + 20_000; Date.now() < end && !last.startsWith('done'); await wait(300)) last = await readme();
    if (!last.startsWith('done')) {
      await shot(desk, 'debug-done');
      const rows = await desk.evaluate(() => [...document.querySelectorAll('[data-testid="devroom-agent-row"]')].map((e) => `${e.getAttribute('data-sub') ?? e.getAttribute('data-agent')}=${e.getAttribute('data-dot')}`));
      console.log(`rows: ${rows.join(' | ')}; windows: ${await desk.locator('[data-hud-window]').evaluateAll((els) => els.map((e) => e.getAttribute('data-hud-window')).join(','))}`);
    }
    check(last.startsWith('done'), `the finished one wears done (${last})`);
    check((await subRow(desk, 'tu-search').getAttribute('data-dot')) === 'working', 'the running one wears the spinner');
    // Hide one external worktree, Orca's way: it folds into 숨긴 워크트리 1개.
    await win.locator(`[data-testid="devroom-external"][data-path="${login}"] [data-testid="devroom-external-hide"]`).click();
    await win.getByTestId('devroom-hidden').waitFor();
    check((await win.getByTestId('devroom-external').count()) === 1, 'hidden: one external row left, the hidden line under it');
    await win.getByTestId('devroom-hidden').locator('button').first().click();
    await desk.waitForTimeout(800);
    await shot(desk, 'pc-modern');
    await subRow(desk, 'tu-search').click();
    const view = win.locator('[data-testid="devroom-pane"][data-agent="shop-web"] [data-testid="devroom-sub-view"][data-sub$=":tu-search"]');
    await view.getByTestId('devroom-sub-steps').first().waitFor({ timeout: 20_000 });
    check(true, "a click on the sub-agent's row opens its transcript in the Lead's pane");
    await desk.waitForTimeout(600);
    await shot(desk, 'pc-modern-sub');
    await win.locator('[data-testid="devroom-agent-row"][data-role="worker"][data-agent="web-worker"]').click();
    await win.locator('[data-testid="devroom-pane"][data-agent="web-worker"]').waitFor({ timeout: 20_000 });
    check(true, "a click on the Worker's row shows the Worker in the pane");

    // ── Desktop, 픽셀 감성 ──
    const pix = await newPage(browser, { viewport: { width: 1920, height: 1080 } }, 'pixel');
    await openRail(pix);
    await pix.waitForTimeout(800);
    await shot(pix, 'pc-pixel');

    // ── Phone (WebKit 390x844) ──
    phoneBrowser = await launchBrowser({ webkit: true });
    const phone = await newPage(phoneBrowser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await phone.locator('[data-dock="devroom"]').tap();
    await subRow(phone, 'tu-search').waitFor({ timeout: 30_000 });
    check((await whereIs(phone, 'tu-search')) === `external:${search}`, 'phone: the same row under the external worktree');
    await subRow(phone, 'tu-cart').scrollIntoViewIfNeeded();
    await phone.waitForTimeout(600);
    await shot(phone, 'phone');
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `phone: no sideways scroll (${overflow})`);
    await subRow(phone, 'tu-search').tap();
    await phone.locator('[data-testid="devroom-sub-view"][data-sub$=":tu-search"] [data-testid="devroom-sub-steps"]').first().waitFor({ timeout: 20_000 });
    check(true, "phone: a tap opens the sub-agent's transcript");
    await phone.waitForTimeout(400);
    await shot(phone, 'phone-sub');

    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    fs.writeFileSync(path.join(os.tmpdir(), 'run-devroom-worktree-sidebar.daemon.log'), daemon.log.join(''));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await phoneBrowser?.close();
    await daemon.stop();
    killFakeSessions(home);
    shop.cleanup();
    blog.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
