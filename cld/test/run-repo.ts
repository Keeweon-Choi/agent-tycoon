/**
 * T-0020 visual check: dist/cli.js with an isolated HOME, the engine's fake
 * claude and --allow-actions on a spare port, over a throwaway git
 * repository (a bare remote and a clone in a temp dir) that the engine
 * project `alpha` works in. Headless Chromium logs in and, on a desktop and on a phone:
 * opens alpha's 작업실 (W1: the 변경 and worktree tabs), reads a file's diff, stages (취소 and Escape send
 * nothing), commits and pushes into the temp remote, and removes two task
 * worktrees (one with unmerged work, behind the stronger confirmation).
 * A second run without --allow-actions shows that reading works and no write
 * control is drawn, and that a forged repoAction is refused. Screenshots take
 * Hangul from malgun.ttf. The user's repositories are never
 * touched: HOME is a temp dir, and every
 * git command runs in the temp repo. A hard deadline and SIGINT/SIGTERM/
 * SIGHUP kill the server too.
 *
 *   npx tsx cld/test/run-repo.ts <port 18256-18259>
 */
import type { Browser, Locator, Page } from '@playwright/test';
import { type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Worktrees } from '../../server/src/cld/engine/git/worktrees.js';
import type { TempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import {
  assertPortFree,
  type Daemon,
  launchBrowser,
  makeEngineHome,
  openOfficeWindow,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';
import { configDirectory } from '../../server/src/cld/configPath.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0020');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
// Hangul from Malgun Gothic, everything else still the pixel font: for its
// range, the @font-face defined last is tried first.
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0020/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 300_000;
// iPhone 15/16 Home-Screen PWA (viewport-fit=cover), portrait.
const INSETS = { top: 59, bottom: 34 };
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const COMMIT_MESSAGE = 'Add notes, tweak app values';

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

/**
 * T-0008's safe-area rule: with the insets overridden, nothing tappable or
 * text-bearing may sit inside an inset strip. The office canvas and the
 * character overlays on it are map content (it pans), not chrome. Only the
 * on-screen part counts: clipped by the viewport and every clipping ancestor.
 */
function stripViolations(page: Page): Promise<{ checked: number; out: string[] }> {
  // No named functions inside evaluate: tsx's keepNames would inject __name.
  return page.evaluate((ins) => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const out: string[] = [];
    let checked = 0;
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (el.closest('[data-testid="agent-overlay"], [data-testid="ez-mood"], canvas')) continue;
      const tappable = el.matches(
        'button, a[href], input, select, textarea, [role="button"], [role="tab"]',
      );
      const texty = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim());
      if (!tappable && !texty) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
        continue;
      }
      const r = el.getBoundingClientRect();
      let [x0, x1, y0, y1] = [
        Math.max(r.left, 0),
        Math.min(r.right, W),
        Math.max(r.top, 0),
        Math.min(r.bottom, H),
      ];
      for (let a = el.parentElement; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
        const c = a.getBoundingClientRect();
        [x0, x1, y0, y1] = [
          Math.max(x0, c.left),
          Math.min(x1, c.right),
          Math.max(y0, c.top),
          Math.min(y1, c.bottom),
        ];
      }
      if (x1 - x0 < 1 || y1 - y0 < 1) continue;
      checked += 1;
      const hits = [y0 < ins.top && 'top', y1 > H - ins.bottom && 'bottom'].filter(Boolean);
      if (hits.length) {
        const what = (el.textContent ?? '').trim().slice(0, 24) || el.tagName;
        out.push(
          `${hits.join('+')}: <${el.tagName.toLowerCase()}> "${what}" y ${Math.round(y0)}-${Math.round(y1)}`,
        );
      }
    }
    return { checked, out };
  }, INSETS);
}

async function noStrips(page: Page, view: string): Promise<void> {
  const { checked, out } = await stripViolations(page);
  check(
    checked > 0 && out.length === 0,
    `inset strips empty (${view}, ${checked} on-screen elements)${out.map((l) => `\n  ${l}`).join('')}`,
  );
}

const app = (): string =>
  `${Array.from({ length: 40 }, (_, i) => `export const value${i} = ${i};`).join('\n')}\n`;

/** 5000 lines; changing every one makes a ~500 KB diff, three pages of 200 KB. */
const big = (suffix: string): string =>
  Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(40)}${suffix}\n`).join('');

/** The temp project: committed and pushed code, then loose work of every kind. */
function seed(repo: TempRepo): void {
  repo.write('src/app.ts', app());
  repo.write('big.txt', big(''));
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'add app']);
  repo.git(['push', '-q', 'origin', 'main']);
}
function makeDirty(repo: TempRepo): void {
  const lines = app().split('\n');
  lines[2] = 'export const value2 = 200; // tuned';
  lines[29] = 'export const value29 = 2900;';
  repo.write('src/app.ts', lines.join('\n'));
  repo.write('big.txt', big('!'));
  fs.rmSync(path.join(repo.folder, 'sub/b.txt'));
  repo.write('notes.md', '# Notes\n\nStage me.\n');
  repo.write('docs/guide.md', '# Guide\n');
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const repo = makeTempRepo();
  seed(repo);
  makeDirty(repo);
  const { home, claudePath } = makeEngineHome();
  const fake = { home, claudePath };
  // The engine project alpha works in the temp clone.
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify([{ name: 'alpha', folder: repo.folder, wantRunning: false }]),
  );
  // Two task worktrees: `login` has a commit nobody merged and a loose file,
  // `docs` is fresh (merged, clean).
  const worktrees = new Worktrees({
    file: path.join(configDirectory(fake.home), 'worktrees.json'),
    run: repo.run,
    log: () => undefined,
  });
  const project = { name: 'alpha', folder: repo.folder };
  const wtDir = (task: string) => path.join(repo.folder, '.worktrees', task);
  await worktrees.create(project, 'login');
  fs.writeFileSync(path.join(wtDir('login'), 'login.ts'), 'export const login = true;\n');
  repo.git(['add', 'login.ts'], wtDir('login'));
  repo.git(['commit', '-q', '-m', 'login form'], wtDir('login'));
  fs.writeFileSync(path.join(wtDir('login'), 'todo.txt'), 'later\n');
  await worktrees.create(project, 'docs');

  const gitEnv = {
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@localhost',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@localhost',
  };
  let serverLog: string[] = [];
  let server: ChildProcess | undefined;
  let daemon: Daemon | undefined;
  /** Start dist/cli.js; resolves with its login URL. */
  const startServer = (extra: string[]) => {
    daemon = startDaemon(fake, port, ['--engine', 'on', '--no-terminal', ...extra], gitEnv);
    server = daemon.child;
    serverLog = daemon.log;
    return daemon.loginUrl();
  };
  const stopServer = async () => {
    await daemon?.stop();
  };
  // Never outlive the check: past the deadline or on a signal, kill the server
  // (its HOME is a temp dir, nothing to save) and exit; Playwright's own exit
  // handler takes the browser down.
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server && server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    fs.rmSync(fake.home, { recursive: true, force: true });
    repo.cleanup();
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  const sent: Array<Record<string, unknown>> = [];
  const received: Array<Record<string, unknown>> = [];
  let browser: Browser | undefined;
  let font: Buffer | undefined;
  const open = async (opts: Parameters<Browser['newContext']>[0]) => {
    const ctx = await browser!.newContext(opts);
    // T-0029: the 현황판 folds rooms and orchestrators; these checks press
    // buttons inside the cards, so a fresh profile starts with all open (모두 펼치기).
    await ctx.addInitScript(() => {
      if (!localStorage.getItem('cld.status-tree'))
        localStorage.setItem('cld.status-tree', '{"rooms":true,"orchs":true}');
    });
    await ctx.route('**/__t0020/malgun.ttf', (route) =>
      route.fulfill({ body: font, contentType: 'font/ttf' }),
    );
    const page = await ctx.newPage();
    page.on('websocket', (ws) => {
      const log = (into: typeof sent) => (f: { payload: string | Buffer }) => {
        try {
          into.push(JSON.parse(String(f.payload)) as Record<string, unknown>);
        } catch {
          /* binary */
        }
      };
      ws.on('framesent', log(sent));
      ws.on('framereceived', log(received));
    });
    return { ctx, page };
  };
  /** Hangul font; with `insets`, also the --cld-safe-* overrides and the inset
   *  strips tinted red (no text, no pointer events: the strip rule ignores them). */
  const hangul = async (page: Page, insets?: typeof INSETS) => {
    await page.addStyleTag({ content: FONT_CSS });
    if (insets) {
      await page.addStyleTag({
        content: `:root { --cld-safe-top: ${insets.top}px !important; --cld-safe-bottom: ${insets.bottom}px !important; }
          .t0020-strip { position: fixed; left: 0; right: 0; z-index: 2147483647; pointer-events: none; background: rgba(255, 0, 64, 0.3); }`,
      });
      await page.evaluate((ins) => {
        for (const [edge, px] of Object.entries(ins)) {
          const strip = document.createElement('div');
          strip.className = 't0020-strip';
          strip.style.cssText = `${edge}: 0; height: ${px}px;`;
          document.body.append(strip);
        }
      }, insets);
    }
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
  };
  const card = (scope: Locator, page: Page, name: string) =>
    scope.locator('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const actions = () => sent.filter((m) => m.type === 'repoAction');
  const results = () => received.filter((m) => m.type === 'repoActionResult');
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const gitOut = (args: string[], cwd?: string) => repo.git(args, cwd).trim();
  const toast = (page: Page, text: string) =>
    page.getByRole('status').filter({ hasText: text }).waitFor({ timeout: 10_000 });
  /** Press a panel button, confirm in the dialog, wait for the toast. */
  const confirm = async (page: Page, trigger: Locator, button: string, toastText: string) => {
    await trigger.click();
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: button, exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await toast(page, toastText);
  };

  /** W1: the 현황판 card's 작업실 button opens the 작업실 on that project; `go` picks a tab. */
  const openBench = async (page: Page, scope: Locator, tap = false) => {
    const button = card(scope, page, 'alpha').getByRole('button', { name: '작업실', exact: true });
    await (tap ? button.tap() : button.click());
    const bench = page.locator('[data-hud-window="workbench"], [aria-label="작업실 화면"]');
    await bench.waitFor();
    const go = async (name: '변경' | 'worktree') => {
      const tab = bench.getByRole('button', { name, exact: true });
      await (tap ? tab.tap() : tab.click());
    };
    return { panel: bench.getByLabel('alpha 저장소'), go };
  };

  try {
    font = fs.readFileSync(FONT);
    browser = await launchBrowser();

    // ════ --allow-actions ════
    const loginUrl = await startServer(['--allow-actions']);

    // ── Desktop ──
    const { ctx: desk, page } = await open({
      viewport: { width: 1400, height: 1100 },
      deviceScaleFactor: 1,
    });
    await page.goto(loginUrl);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await openOfficeWindow(page); // T-0108: a desktop starts with icons only
    await hangul(page);
    const drawer = page.getByRole('complementary', { name: '사무실 정보' });
    const { panel, go } = await openBench(page, drawer);
    await go('변경');
    await panel.getByText('main → origin/main').waitFor();
    const row = (name: string | RegExp) =>
      panel.getByRole('button', { name, exact: typeof name === 'string' });
    check(
      (await panel.textContent())?.includes('스테이지 안 됨 (5)') &&
        (await row('src/app.ts').count()) === 1 &&
        (await row('big.txt').count()) === 1 &&
        (await row('sub/b.txt').count()) === 1 &&
        (await row('notes.md').count()) === 1 &&
        (await row('docs/').count()) === 1,
      'the panel lists the five loose changes under 스테이지 안 됨',
    );
    check(
      (await panel.getByText('작업 공간').count()) === 0,
      'W1: the 변경 tab holds the changes only, the worktree list is its own tab',
    );
    await go('worktree');
    await panel.getByText('작업 공간 (2)').waitFor();
    check(
      (await panel.getByText('작업 공간 (2)').count()) === 1 &&
        (await panel.getByText('병합 안 됨').count()) === 1 &&
        (await panel.getByText('변경 1건').count()) === 1,
      '작업 공간 lists login (unmerged, 1 change) and docs (merged)',
    );
    await go('변경');
    await panel.getByText('main → origin/main').waitFor();
    await page.waitForTimeout(800);
    await panel.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await shot(page, 'desktop');

    // The diff view.
    await row('src/app.ts').click();
    const diff = panel.getByLabel('diff', { exact: true });
    await diff.waitFor();
    check(
      /mono/i.test(
        await diff
          .locator('span')
          .first()
          .evaluate((el) => getComputedStyle(el).fontFamily),
      ),
      'the diff lines are set in a monospace font (columns line up)',
    );
    const diffText = (await diff.textContent()) ?? '';
    check(
      diffText.includes('-export const value2 = 2;') &&
        diffText.includes('+export const value2 = 200; // tuned') &&
        diffText.includes('@@'),
      'src/app.ts shows its unified diff (two hunks)',
    );
    check(
      (await diff.locator('span.text-green-300').count()) >= 1 &&
        (await diff.locator('span.text-red-400').count()) >= 1,
      'added and removed lines are coloured',
    );
    await row('src/app.ts').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await shot(page, 'desktop-diff');
    await row('src/app.ts').click();
    await diff.waitFor({ state: 'detached' });

    // A big diff comes 200 KB at a time.
    await row('big.txt').click();
    await diff.waitFor();
    const more = panel.getByRole('button', { name: '더 보기' });
    await more.waitFor();
    const textLength = () => diff.evaluate((el) => el.textContent?.length ?? 0);
    const firstPage = await textLength();
    check(
      firstPage > 100_000 && firstPage <= 200 * 1024,
      `a big diff's first page is at most 200 KB (${firstPage} characters) with a 더 보기 link`,
    );
    await more.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await shot(page, 'desktop-diff-more');
    let pages = 1;
    while (await more.count()) {
      const before = await textLength();
      await more.click();
      await page.waitForFunction(
        (n) => (document.querySelector('pre[aria-label="diff"]')?.textContent?.length ?? 0) > n,
        before,
      );
      pages += 1;
      await page.waitForTimeout(100);
    }
    const whole = (await diff.textContent()) ?? '';
    check(
      pages === 3 &&
        whole.includes('-line 0 ') &&
        whole.includes('+line 4999 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx!'),
      `더 보기 loads the rest: ${pages} pages, the last line of the diff is there (${whole.length} characters)`,
    );
    await row('big.txt').click();
    await diff.waitFor({ state: 'detached' });
    await row('notes.md').click();
    check(
      ((await diff.textContent()) ?? '').includes('+Stage me.'),
      'an untracked file is shown whole',
    );
    await row('notes.md').click();
    await row('docs/').click();
    check(
      ((await diff.textContent()) ?? '').includes('새 폴더'),
      'a new folder says it is a folder',
    );
    await row('docs/').click();

    // 취소 and Escape send nothing.
    const dialog = page.getByRole('alertdialog');
    await panel.getByRole('checkbox', { name: 'notes.md 선택' }).check();
    const stageSelected = panel.getByRole('button', { name: '선택 스테이지 (1)' });
    await stageSelected.click();
    await dialog.waitFor();
    check(
      (await dialog.textContent())?.includes('선택한 파일 1개를 스테이지할까요?'),
      'the confirmation asks in Korean',
    );
    await shot(page, 'desktop-confirm');
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await stageSelected.click();
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await page.waitForTimeout(400);
    check(actions().length === 0, '취소 and Escape send no repoAction');
    check(gitOut(['status', '--porcelain']).includes('?? notes.md'), 'notes.md is still untracked');

    // Stage one file, then everything.
    await confirm(page, stageSelected, '스테이지', '스테이지했어요');
    await panel.getByText('스테이지됨 (1)').waitFor();
    check(gitOut(['status', '--porcelain']).includes('A  notes.md'), 'notes.md is staged in git');
    await confirm(
      page,
      panel.getByRole('button', { name: '모두 스테이지' }),
      '스테이지',
      '스테이지했어요',
    );
    await panel.getByText('스테이지됨 (5)').waitFor();
    check(!(await panel.getByText('스테이지 안 됨').count()), 'everything is staged');
    // Unstage one: the new folder's file comes back as the folder.
    await panel.getByRole('checkbox', { name: 'docs/guide.md 선택' }).check();
    await confirm(
      page,
      panel.getByRole('button', { name: '선택 해제 (1)' }),
      '해제',
      '스테이지를 해제했어요',
    );
    await panel.getByText('스테이지됨 (4)').waitFor();
    check(
      gitOut(['status', '--porcelain']).includes('?? docs/'),
      'docs/guide.md is untracked again',
    );
    await row('src/app.ts').first().click();
    await diff.waitFor();
    check(
      (
        (await panel.getByLabel('스테이지된 변경 요약 (git diff --cached --stat)').textContent()) ??
        ''
      ).includes('src/app.ts'),
      'the staged diff --stat is shown',
    );
    await row('src/app.ts').first().click();

    // Commit and push into the temp remote.
    const commitButton = panel.getByRole('button', { name: '커밋', exact: true });
    check(await commitButton.isDisabled(), '커밋 is disabled without a message');
    await panel.getByLabel('커밋 메시지').fill(COMMIT_MESSAGE);
    await commitButton.click();
    await dialog.waitFor();
    check(
      (await dialog.textContent())?.includes('스테이지된 파일 4개를 커밋할까요?') &&
        (await dialog.getByLabel('커밋 메시지').textContent()) === COMMIT_MESSAGE,
      'the commit dialog shows the message it will use',
    );
    await shot(page, 'desktop-confirm-commit');
    await dialog.getByRole('button', { name: '커밋', exact: true }).click();
    await toast(page, '커밋했어요');
    await panel.getByLabel('앞섬 1, 뒤처짐 0').waitFor();
    check(gitOut(['log', '-1', '--format=%s']) === COMMIT_MESSAGE, 'git log has the typed message');
    check(
      (await panel.getByLabel('커밋 메시지').inputValue()) === '',
      'the message box was emptied',
    );
    const pushButton = panel.getByRole('button', { name: /^push/ });
    const remoteBefore = gitOut(['rev-parse', 'refs/heads/main'], repo.remote);
    check(remoteBefore !== gitOut(['rev-parse', 'HEAD']), 'the remote has not got the commit yet');
    await pushButton.click();
    await dialog.waitFor();
    check(
      (await dialog.textContent())?.includes('origin/main에 push할까요?') &&
        (await dialog.textContent())?.includes('강제로 올리지는 않아요'),
      'the push dialog says where, and that it is not forced',
    );
    await dialog.getByRole('button', { name: 'push', exact: true }).click();
    await toast(page, 'push했어요');
    await panel.getByLabel('앞섬 0, 뒤처짐 0').waitFor();
    check(
      gitOut(['rev-parse', 'refs/heads/main'], repo.remote) === gitOut(['rev-parse', 'HEAD']),
      'the bare remote has the commit',
    );
    check(await pushButton.isDisabled(), 'push is disabled with nothing to push');
    await shot(page, 'desktop-after-push');

    // Worktrees: the stronger confirmation, then the plain one.
    await go('worktree');
    const loginRow = panel
      .getByLabel('작업 공간', { exact: true })
      .locator('li')
      .filter({ hasText: 'login' });
    await loginRow.getByRole('button', { name: '지우기' }).click();
    await dialog.waitFor();
    const text = (await dialog.textContent()) ?? '';
    check(
      text.includes('작업 공간 login을 지울까요?') &&
        text.includes('병합되지 않은 커밋 1개') &&
        text.includes('커밋하지 않은 변경 1건') &&
        text.includes('task/login는 남겨요'),
      'removing an unmerged worktree names what would be lost',
    );
    await shot(page, 'desktop-confirm-worktree');
    const removalsBefore = actions().filter((a) => a.action === 'worktreeRemove').length;
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.waitForTimeout(300);
    check(
      actions().filter((a) => a.action === 'worktreeRemove').length === removalsBefore &&
        fs.existsSync(wtDir('login')),
      '취소 keeps the worktree and sends nothing',
    );
    await loginRow.getByRole('button', { name: '지우기' }).click();
    await dialog.getByRole('button', { name: '버리고 지우기', exact: true }).click();
    await toast(page, '작업 공간을 지웠어요');
    await loginRow.waitFor({ state: 'detached' });
    check(
      !fs.existsSync(wtDir('login')) &&
        gitOut(['branch', '--list', 'task/login']).includes('task/login'),
      'login is gone, its branch with the unmerged commit stays',
    );
    const docsRow = panel
      .getByLabel('작업 공간', { exact: true })
      .locator('li')
      .filter({ hasText: 'docs' });
    await docsRow.getByRole('button', { name: '지우기' }).click();
    await dialog.waitFor();
    check(
      (await dialog.textContent())?.includes('task/docs도 함께 지워요') &&
        (await dialog.getByRole('button', { name: '지우기', exact: true }).count()) === 1,
      'a merged, clean worktree gets the plain dialog',
    );
    await dialog.getByRole('button', { name: '지우기', exact: true }).click();
    // The list empties when the result's fresh state arrives (the toast text repeats).
    await panel.getByLabel('작업 공간', { exact: true }).waitFor({ state: 'detached' });
    check(
      !fs.existsSync(wtDir('docs')) && !gitOut(['branch', '--list', 'task/docs']),
      'docs is gone with its branch',
    );

    check(
      JSON.stringify(actions().map((a) => [a.action, a.force ?? null])) ===
        JSON.stringify([
          ['stage', null],
          ['stage', null],
          ['unstage', null],
          ['commit', null],
          ['push', null],
          ['worktreeRemove', true],
          ['worktreeRemove', null],
        ]),
      'seven repoActions in total, one per confirmation; force only for the unmerged worktree',
    );
    check(
      results().length === 7 && results().every((r) => r.ok === true),
      'seven repoActionResults, all ok, matched by requestId',
    );

    // ── Phone ──
    // A second round: one commit nobody pushed, and new loose work on top of it.
    repo.write('CHANGELOG.md', '# Changes\n');
    repo.git(['add', 'CHANGELOG.md']);
    repo.git(['commit', '-q', '-m', 'second']);
    const round2 = fs.readFileSync(path.join(repo.folder, 'src/app.ts'), 'utf-8').split('\n');
    round2[5] = 'export const value5 = 500; // round two';
    repo.write('src/app.ts', round2.join('\n'));
    repo.write('second.txt', 'second\n');
    await worktrees.create(project, 'fix-typo');
    fs.writeFileSync(path.join(wtDir('fix-typo'), 'typo.txt'), 'fixed\n');
    repo.git(['add', 'typo.txt'], wtDir('fix-typo'));
    repo.git(['commit', '-q', '-m', 'typo'], wtDir('fix-typo'));
    const { page: phone } = await open({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      userAgent: IPHONE_UA,
      storageState: await desk.storageState(),
    });
    await phone.goto(`http://127.0.0.1:${port}/`);
    await hangul(phone);
    await phone
      .locator('[data-hud-id^="icon:"]')
      .getByRole('button', { name: '현황판', exact: true })
      .click();
    const ppanelRoot = phone.getByLabel('현황판 화면');
    const { panel: ppanel, go: pgo } = await openBench(phone, ppanelRoot, true);
    await pgo('worktree');
    await ppanel.getByText('작업 공간 (1)').waitFor();
    await pgo('변경');
    await ppanel.getByText('main → origin/main').waitFor();
    await ppanel.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await phone.waitForTimeout(600);
    await shot(phone, 'phone');
    await ppanel.getByRole('button', { name: 'src/app.ts', exact: true }).tap();
    await ppanel.getByLabel('diff', { exact: true }).waitFor();
    await ppanel
      .getByRole('button', { name: 'src/app.ts', exact: true })
      .evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await shot(phone, 'phone-diff');
    await ppanel.getByRole('button', { name: 'src/app.ts', exact: true }).tap();
    const pdialog = phone.getByRole('alertdialog');
    await ppanel.getByRole('button', { name: /^push/ }).tap();
    await pdialog.waitFor();
    await shot(phone, 'phone-confirm-push');
    await pdialog.getByRole('button', { name: '취소', exact: true }).tap();
    await pdialog.waitFor({ state: 'detached' });
    await ppanel.getByRole('checkbox', { name: 'second.txt 선택' }).check();
    await ppanel.getByRole('button', { name: '선택 스테이지 (1)' }).tap();
    await pdialog.waitFor();
    await shot(phone, 'phone-confirm');
    await pdialog.getByRole('button', { name: '스테이지', exact: true }).tap();
    await toast(phone, '스테이지했어요');
    await shot(phone, 'phone-toast');
    check(
      gitOut(['status', '--porcelain']).includes('A  second.txt'),
      'the phone staged second.txt',
    );

    // ── Phone with iPhone Home-Screen insets ──
    const { page: safe } = await open({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      userAgent: IPHONE_UA,
      storageState: await desk.storageState(),
    });
    await safe.goto(`http://127.0.0.1:${port}/`);
    await hangul(safe, INSETS);
    await safe
      .locator('[data-hud-id^="icon:"]')
      .getByRole('button', { name: '현황판', exact: true })
      .click();
    const { panel: spanel, go: sgo } = await openBench(safe, safe.getByLabel('현황판 화면'), true);
    await sgo('변경');
    await spanel.getByText('main → origin/main').waitFor();
    await safe.waitForTimeout(500);
    await noStrips(safe, '작업실 변경 tab');
    await sgo('worktree');
    await spanel.getByText('작업 공간 (1)').waitFor();
    await spanel.getByLabel('작업 공간', { exact: true }).scrollIntoViewIfNeeded();
    await safe.waitForTimeout(500);
    await noStrips(safe, '작업실 worktree tab scrolled to 작업 공간');
    await shot(safe, 'phone-safe-worktrees');
    await spanel
      .getByLabel('작업 공간', { exact: true })
      .getByRole('button', { name: '지우기' })
      .tap();
    const sdialog = safe.getByRole('alertdialog');
    await sdialog.waitFor();
    await shot(safe, 'phone-safe-confirm');
    await noStrips(safe, 'worktree confirm dialog');
    await sdialog.getByRole('button', { name: '버리고 지우기', exact: true }).tap();
    const stoast = safe.getByRole('status').filter({ hasText: '작업 공간을 지웠어요' });
    await stoast.waitFor({ timeout: 10_000 });
    await shot(safe, 'phone-safe-toast');
    await noStrips(safe, 'toast');
    check(
      !fs.existsSync(wtDir('fix-typo')),
      'the phone removed the unmerged worktree after the stronger dialog',
    );

    // The daemon's one log line per write, with the client's device.
    const lines = serverLog
      .join('')
      .split('\n')
      .filter((l) => l.startsWith('[cld repo] action'))
      .map((l) => l.replaceAll(repo.folder, '<repo>'));
    check(
      lines.length === 9 &&
        lines.slice(0, 7).every((l) => /: ok \d+\.\ds gui:linux$/.test(l)) &&
        lines.slice(7).every((l) => /: ok \d+\.\ds gui:ios$/.test(l)),
      'the daemon logged nine writes, gui:linux from the desktop and gui:ios from the phone',
    );
    check(
      !lines.join('\n').includes(COMMIT_MESSAGE) && !lines.join('\n').includes('notes.md'),
      'the log lines hold no message and no file name',
    );
    fs.writeFileSync(path.join(OUT, 'daemon-repo-lines.txt'), `${lines.join('\n')}\n`);
    fs.writeFileSync(
      path.join(OUT, 'ws-repo-actions.json'),
      `${JSON.stringify(actions(), null, 1)}\n`,
    );
    fs.writeFileSync(
      path.join(OUT, 'ws-repo-action-results.json'),
      `${JSON.stringify(results(), null, 1)}\n`,
    );
    fs.writeFileSync(
      path.join(OUT, 'remote-log.txt'),
      `${gitOut(['log', '--format=%h %s', 'main'], repo.remote)}\n`,
    );
    const types = new Set(received.map((m) => String(m.type)));
    check(
      ['repoState', 'repoDiff', 'repoActionResult'].every((t) => types.has(t)),
      'repoState, repoDiff and repoActionResult all arrived on the socket',
    );

    // ════ read-only daemon ════
    await stopServer();
    const loginUrl2 = await startServer([]);
    const { page: ro } = await open({
      viewport: { width: 1400, height: 900 },
      deviceScaleFactor: 1,
    });
    await ro.goto(loginUrl2);
    await ro.waitForURL(`http://127.0.0.1:${port}/`);
    await openOfficeWindow(ro); // T-0108: a desktop starts with icons only
    await hangul(ro);
    const rdrawer = ro.getByRole('complementary', { name: '사무실 정보' });
    const { panel: rpanel, go: rgo } = await openBench(ro, rdrawer);
    await rgo('변경');
    await rpanel.getByText('main → origin/main').waitFor();
    await rpanel.getByRole('button', { name: 'src/app.ts', exact: true }).click();
    await rpanel.getByLabel('diff', { exact: true }).waitFor();
    check(
      ((await rpanel.getByLabel('diff', { exact: true }).textContent()) ?? '').includes(
        '+export const value5 = 500',
      ),
      'read-only daemon: reading the diff works',
    );
    check(
      (await rpanel.getByRole('checkbox').count()) === 0 &&
        (await rpanel.getByRole('textbox').count()) === 0 &&
        (await rpanel.getByRole('button', { name: /스테이지|해제|커밋|push|지우기/ }).count()) ===
          0,
      'read-only daemon: no checkbox, message box or write button is drawn',
    );
    await shot(ro, 'desktop-readonly');
    // A forged repoAction over a logged-in socket is refused, and git is not touched.
    const statusBefore = gitOut(['status', '--porcelain']);
    const forged = await ro.evaluate(
      () =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const ws = new WebSocket(`ws://${location.host}/ws`);
          const timer = setTimeout(() => reject(new Error('no answer')), 8000);
          ws.onopen = () =>
            ws.send(
              JSON.stringify({
                type: 'repoAction',
                requestId: 'forged',
                action: 'stage',
                project: 'alpha',
              }),
            );
          ws.onmessage = (e) => {
            const m = JSON.parse(String(e.data)) as Record<string, unknown>;
            if (m.type === 'repoActionResult') {
              clearTimeout(timer);
              ws.close();
              resolve(m);
            }
          };
        }),
    );
    check(
      forged.ok === false && forged.error === '읽기 전용 모드라 조작할 수 없어요',
      'read-only daemon: a forged repoAction is refused in Korean',
    );
    check(
      gitOut(['status', '--porcelain']) === statusBefore,
      'read-only daemon: git was not touched',
    );
    fs.writeFileSync(
      path.join(OUT, 'ws-forged-result.json'),
      `${JSON.stringify(forged, null, 1)}\n`,
    );
  } finally {
    await browser?.close();
    await stopServer();
    clearTimeout(deadline);
    fs.writeFileSync(
      path.join(OUT, 'server.log'),
      serverLog
        .join('')
        .replaceAll(fake.home, '<fake-home>')
        .replaceAll(repo.folder, '<repo>')
        .replace(/code=[^\s&]+/g, 'code=<redacted>'),
    );
    fs.rmSync(fake.home, { recursive: true, force: true });
    repo.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
