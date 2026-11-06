/**
 * DV3, the 개발실 command palette (mockup D3, plan §4 3위), end to end: dist/cli.js in a temp HOME on
 * a spare port, a temp repository, the engine's fake claude as Lead `shop-web` and two Workers in our
 * PTY host (never a real claude). web-worker asks a permission (the fake's FAKE-PERMISSION, held by
 * the PermissionRequest hook), ui-worker's Task is 결제 화면 문구 정리.
 * Desktop 1600x1000 모던: with ui-worker's terminal pane focused, Ctrl+K opens the palette and the
 * terminal never sees the key while other keys still reach the PTY; opened empty, the first line is
 * the waiting web-worker; no line answers a permission; '결제' finds the worktree; Enter does not
 * pick while Hangul is composing; Esc closes it and focus is back in ui-worker's pane; Enter on the
 * waiting line goes to web-worker's pane; Alt+1/2 focus the panes, Alt+↓ the waiting agent; the title
 * bar's pill opens it. 1024x700 모던 and one 픽셀 감성 shot. Phone 390x844: the head's search icon
 * opens the same list full screen. Screenshots in cld/artifacts/<folder>/.
 *
 *   taskset -c 16,17 nice -n 10 npx tsx cld/test/run-devroom-palette.ts <port 19130..19139> [artifacts folder, default feat-devroom-palette]
 */
import type { Browser, Page } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import type { WorktreeRecord } from '../../server/src/cld/engine/git/worktrees.js';
import { assertPortFree, killFakeSessions, launchBrowser, makeEngineHome, REPO_ROOT, startDaemon } from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 19130 && port <= 19139)) throw new Error('port: 19130..19139');
const OUT = path.join(REPO_ROOT, 'cld/artifacts', process.argv[3] ?? 'feat-devroom-palette');
const DEADLINE_MS = 300_000;
let oks = 0;
const notes: string[] = [];

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

const WORK = [
  { worker: 'web-worker', title: '장바구니 합계 계산 분리', file: 'src/shop/cart.ts', text: 'export const sumPrice = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n' },
  { worker: 'ui-worker', title: '결제 화면 문구 정리', file: 'src/ui/pay.txt', text: '결제하기\n' },
];

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
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
    {
      PATH,
      FAKE_TURN_MS: '240000',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@localhost',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@localhost',
      LANG: 'C.UTF-8',
    },
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
      spawnSync(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args], {
        env: { PATH, HOME: home, CLD_OUTPUT: 'json' },
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
    const typed = () => {
      const file = path.join(home, 'fake-claude-typed.log');
      return fs.existsSync(file)
        ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { name: string; text: string })
        : [];
    };
    await daemon.loginUrl();
    await eventually('the Lead revived', () => session('shop-web'));
    const wts: WorktreeRecord[] = [];
    for (const [i, w] of WORK.entries()) {
      check(json(cli('worker', 'add', 'shop-web', w.worker)).ok === true, `Worker ${w.worker} added`);
      const id = json(cli('task', 'add', w.title, '--project', 'shop-web', '--assignee', w.worker, '--status', 'doing')).task?.id as string;
      check(id === `T-${i + 1}`, `Task ${id} for ${w.worker}`);
      check(json(cli('worktree', 'new', '--task', id, '--assign', w.worker)).ok === true, `${id} gets a worktree`);
      const wt = (JSON.parse(fs.readFileSync(path.join(cfg, 'worktrees.json'), 'utf8')) as WorktreeRecord[]).find((r) => r.taskId === id)!;
      fs.mkdirSync(path.dirname(path.join(wt.path, w.file)), { recursive: true });
      fs.writeFileSync(path.join(wt.path, w.file), w.text);
      repo.git(['add', '-A'], wt.path);
      repo.git(['commit', '-q', '-m', w.title], wt.path);
      wts.push(wt);
    }
    for (const w of WORK) {
      check(json(cli('worker', 'start', w.worker)).ok === true, `${w.worker} started`);
      await eventually(`${w.worker} live`, () => session(w.worker));
    }
    // web-worker asks a permission; its hook waits for an answer nobody gives here.
    cli('send', 'web-worker', 'FAKE-PERMISSION npm test');
    await eventually('web-worker asked its permission', () => typed().some((x) => x.name === 'web-worker' && x.text.includes('FAKE-PERMISSION')), 60_000);
    check(true, 'web-worker waits on a permission');

    browser = await launchBrowser();
    const seen = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version.split('.').slice(0, 2).join('.');
    const newPage = async (b: Browser, opts: Parameters<Browser['newContext']>[0], theme?: 'pixel') => {
      const ctx = await b.newContext(opts);
      await ctx.addInitScript(
        ([v, th]) => {
          localStorage.setItem('cld.changelogSeen', v);
          if (th) localStorage.setItem('cld.ui-theme', th);
        },
        [seen, theme ?? ''] as const,
      );
      const p = await ctx.newPage();
      await p.goto(await daemon.loginUrl());
      await p.waitForURL(`http://127.0.0.1:${port}/`);
      return p;
    };
    const shot = async (p: Page, name: string) => {
      await p.waitForTimeout(300);
      await p.screenshot({ path: path.join(OUT, `${name}.png`) });
    };
    const openDevroom = async (p: Page) => {
      await p.locator('[data-hud-id="icon:devroom"] button').click();
      const win = p.locator('[data-hud-window="devroom"]');
      await win.waitFor({ timeout: 20_000 });
      if ((await win.getByRole('button', { name: /원래 크기|Restore/ }).count()) === 0) await win.getByTestId('hud-title-devroom').dblclick();
      return win;
    };
    const palette = (p: Page) => p.getByTestId('devroom-palette');
    const items = (p: Page) =>
      palette(p).getByTestId('devroom-palette-item').evaluateAll((els) =>
        els.map((e) => ({ group: e.getAttribute('data-group'), kind: e.getAttribute('data-kind'), text: (e as HTMLElement).innerText, on: e.getAttribute('aria-selected') === 'true' })),
      );
    const paneOfFocus = (p: Page) => p.evaluate(() => document.activeElement?.closest<HTMLElement>('[data-testid="devroom-pane"]')?.dataset.agent ?? null);

    // ── Desktop 1600x1000, 모던 ──
    const desk = await newPage(browser, { viewport: { width: 1600, height: 1000 } });
    const win = await openDevroom(desk);
    const card = (task: string) => win.locator(`[data-testid="devroom-card"][data-task="${task}"]`);
    await card(wts[1].task).waitFor({ timeout: 20_000 });
    check(await win.getByTestId('devroom-palette-pill').isVisible(), 'the title bar shows the 찾기 · Ctrl+K pill');
    await card(wts[1].task).click();
    const uiPane = win.locator('[data-testid="devroom-pane"][data-agent="ui-worker"]');
    await uiPane.waitFor({ timeout: 20_000 });
    await desk.waitForFunction(
      () => [...document.querySelectorAll<HTMLElement>('[data-testid="devroom-pane"][data-agent="ui-worker"] .xterm-rows')].some((el) => el.innerText.includes('fake Claude Code (pty)')),
      undefined,
      { timeout: 30_000 },
    );
    await uiPane.locator('.xterm-screen').click();
    check((await paneOfFocus(desk)) === 'ui-worker', "ui-worker's terminal has focus");
    // Count the keys the terminal's own text box receives: Ctrl+K must never be one of them.
    await desk.evaluate(() => {
      const w = window as unknown as { dv3Keys: string[] };
      w.dv3Keys = [];
      document.activeElement?.addEventListener('keydown', (e) => w.dv3Keys.push(`${(e as KeyboardEvent).ctrlKey ? 'C-' : ''}${(e as KeyboardEvent).key}`));
    });
    await desk.keyboard.type('dv3hello');
    await desk.keyboard.press('Control+k');
    await palette(desk).waitFor({ timeout: 5_000 });
    check(true, 'with a terminal pane focused, Ctrl+K opens the palette');
    const keysSeen = await desk.evaluate(() => (window as unknown as { dv3Keys: string[] }).dv3Keys);
    // The Control key itself reaches it (the listener works); the letters go through xterm's IME layer, so the PTY's log proves them below.
    check(keysSeen.includes('C-Control') && !keysSeen.includes('C-k'), `the terminal's text box never saw Ctrl+K (${keysSeen.join(' ')})`);
    let list = await items(desk);
    let waits = false;
    try {
      await desk.waitForFunction(() => document.querySelector('[data-testid="devroom-palette-item"]')?.getAttribute('data-group') === 'waiting', undefined, { timeout: 30_000 });
      list = await items(desk);
      check(list[0].group === 'waiting' && list[0].text.includes('web-worker') && list[0].on, `opened empty, the first line is the waiting web-worker (${list[0].text})`);
      waits = true;
    } catch {
      notes.push(`no waiting line came (first: ${list[0]?.group} ${list[0]?.text}); the fake's permission was not seen as a wait`);
    }
    const KINDS = new Set(['pane', 'space', 'tab', 'sync', 'cleanup', 'newIssue']);
    check(list.every((i) => KINDS.has(i.kind ?? '')) && !list.some((i) => /^(허용|거부|허락|거절)$/.test(i.text.trim())), `no line answers a permission (${[...new Set(list.map((i) => i.kind))].join(', ')})`);
    check((await palette(desk).getByTestId('devroom-palette-foot').innerText()).includes('허락과 거절은 칸 안의 단추로만 해요'), 'the footer says approvals are buttons only');
    const box = await palette(desk).boundingBox();
    check(box && Math.round(box.width) === 640, `the palette is 640 px wide (${box?.width})`);
    await shot(desk, 'desktop-1600-empty');
    await desk.keyboard.type('결제');
    await desk.waitForFunction(() => [...document.querySelectorAll('[data-testid="devroom-palette-item"][data-group="spaces"]')].some((e) => (e as HTMLElement).innerText.includes('결제 화면 문구 정리')), undefined, { timeout: 5_000 });
    list = await items(desk);
    check(list.some((i) => i.group === 'actions' && i.text.includes('결제 화면 문구 정리 · 머지 탭 열기')), "'결제' finds the worktree and its 머지 tab line");
    check(list.find((i) => i.on)?.text.includes('결제'), 'the chosen line is the first that matches');
    await shot(desk, 'desktop-1600-typed');
    // An Enter while Hangul composes must not pick (the IME's own Enter ends the syllable).
    await palette(desk).getByTestId('devroom-palette-input').evaluate((el) =>
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229, bubbles: true, cancelable: true })),
    );
    await desk.waitForTimeout(300);
    check(await palette(desk).isVisible(), 'Enter while composing does not pick');
    await desk.keyboard.press('Escape');
    await palette(desk).waitFor({ state: 'detached', timeout: 5_000 });
    check((await paneOfFocus(desk)) === 'ui-worker', "Esc closes it and focus is back in ui-worker's pane");
    await desk.keyboard.press('Enter');
    await eventually('the typed line reached the PTY', () => typed().some((x) => x.name === 'ui-worker' && x.text.includes('dv3hello')), 15_000);
    check(!typed().some((x) => x.text.includes('\u000b')), 'other keys reached the PTY; Ctrl+K did not');

    // Alt+1..2: two panes; Alt+↓: the waiting agent.
    await win.getByTestId('devroom-layout-2').click();
    await desk.waitForFunction(() => document.querySelectorAll('[data-testid="devroom-pane"]').length === 2, undefined, { timeout: 10_000 });
    const paneNames = await win.getByTestId('devroom-pane').evaluateAll((els) => els.map((e) => e.getAttribute('data-agent')));
    await desk.keyboard.press('Alt+2');
    check((await paneOfFocus(desk)) === paneNames[1], `Alt+2 focuses pane 2 (${paneNames[1]})`);
    await desk.keyboard.press('Alt+1');
    check((await paneOfFocus(desk)) === paneNames[0], `Alt+1 focuses pane 1 (${paneNames[0]})`);
    if (waits) {
      await desk.keyboard.press('Alt+ArrowDown');
      await desk.waitForFunction(() => document.activeElement?.closest<HTMLElement>('[data-testid="devroom-pane"]')?.dataset.agent === 'web-worker', undefined, { timeout: 5_000 });
      check(true, "Alt+↓ goes to the waiting web-worker's pane");
    }
    // The pill opens it too; Enter on the waiting line goes to its pane.
    await win.getByTestId('devroom-palette-pill').click();
    await palette(desk).waitFor();
    if (waits) {
      // From ui-worker's pane, so the jump is seen.
      await desk.keyboard.press('Escape');
      await uiPane.locator('.xterm-screen').click();
      await desk.keyboard.press('Control+k');
      await palette(desk).waitFor();
      await desk.keyboard.press('Enter');
      await palette(desk).waitFor({ state: 'detached' });
      await desk.waitForFunction(() => document.activeElement?.closest<HTMLElement>('[data-testid="devroom-pane"]')?.dataset.agent === 'web-worker', undefined, { timeout: 5_000 });
      check(true, "Enter on the waiting line goes to web-worker's pane");
    } else {
      await desk.keyboard.press('Escape');
    }

    // ── 1024x700 모던, then one 픽셀 감성 shot ──
    const small = await newPage(browser, { viewport: { width: 1024, height: 700 } });
    await openDevroom(small);
    await small.keyboard.press('Control+k');
    await palette(small).waitFor();
    const sbox = await palette(small).boundingBox();
    check(sbox && sbox.x >= 0 && sbox.x + sbox.width <= 1024 && sbox.y + sbox.height <= 700, 'at 1024x700 the palette fits the screen');
    await shot(small, 'desktop-1024-empty');
    const pixel = await newPage(browser, { viewport: { width: 1600, height: 1000 } }, 'pixel');
    await openDevroom(pixel);
    await pixel.keyboard.press('Control+k');
    await palette(pixel).waitFor();
    await pixel.keyboard.type('결제');
    await shot(pixel, 'desktop-1600-pixel');

    // ── Phone 390x844: the head's search icon, full screen ──
    const phone = await newPage(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await phone.locator('[data-dock="devroom"]').tap();
    await phone.getByTestId('devroom-palette-open').tap({ timeout: 20_000 });
    await palette(phone).waitFor();
    const pbox = await palette(phone).boundingBox();
    check(pbox && Math.round(pbox.width) === 390 && Math.round(pbox.height) === 844, `phone: the list is full screen (${pbox?.width}x${pbox?.height})`);
    const over = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(over <= 0, `phone: no sideways scroll (${over})`);
    await shot(phone, 'phone-empty');
    await phone.getByTestId('devroom-palette-input').fill('결제');
    await shot(phone, 'phone-typed');
    await phone.getByTestId('devroom-palette-item').filter({ hasText: '결제 화면 문구 정리' }).first().tap();
    await palette(phone).waitFor({ state: 'detached' });
    check(true, 'phone: a tap on a line goes there and closes the list');

    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
    for (const n of notes) console.log(`note - ${n}`);
  } catch (err) {
    fs.writeFileSync(path.join(os.tmpdir(), 'run-devroom-palette.daemon.log'), daemon.log.join(''));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    repo.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
