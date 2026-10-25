/**
 * W4/W5 visual check: dist/cli.js in an isolated HOME on a spare port over a throwaway repository.
 * Two task worktrees hold different work (what each agent changed shows separately), a third was
 * merged before the daemon started (the history is read back from merge-history.json), and the
 * guard hook refuses a commit on master in a worktree. Headless Chromium (--disable-gpu).
 *
 *   npx tsx cld/test/run-w4.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RepoManager } from '../../server/src/cld/engine/git/repoManager.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import {
  assertPortFree,
  launchBrowser,
  makeEngineHome,
  openOfficeWindow,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/w4');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__w4/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const repo = makeTempRepo();
  const { home, claudePath } = makeEngineHome();
  const configDir = path.join(home, '.config/cld-gui');
  fs.writeFileSync(
    path.join(configDir, 'projects.json'),
    JSON.stringify([{ name: 'alpha', folder: repo.folder, wantRunning: false }]),
  );
  const project = { name: 'alpha', folder: repo.folder };
  const mgr = new RepoManager({ projects: () => [project], readOnly: false, configDir, run: repo.run, log: () => undefined });
  const make = async (id: string, slug: string, files: Record<string, string>, commit: boolean) => {
    const wt = await mgr.worktrees.createForTask(project, { taskId: id, slug, createdBy: 'user' });
    for (const [f, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(wt.path, f)), { recursive: true });
      fs.writeFileSync(path.join(wt.path, f), text);
    }
    if (commit) {
      repo.git(['add', '-A'], wt.path);
      repo.git(['commit', '-q', '-m', `${slug}: ${Object.keys(files).join(', ')}`], wt.path);
    }
    return wt;
  };
  const login = await make('T-1', 'login', { 'src/login.ts': 'export const login = true;\n', 'a.txt': 'one\nlogin tweak\n' }, true);
  fs.writeFileSync(path.join(login.path, 'todo.txt'), 'later\n'); // loose work
  await make('T-2', 'api', { 'src/api.ts': 'export const api = 1;\nexport const v2 = 2;\n' }, true);
  const docs = await make('T-3', 'docs', { 'docs/guide.md': '# Guide\n' }, true);
  const merged = await mgr.merge('alpha', docs.task, { privileged: true, source: 'run-w4' });
  check(merged.ok, 'a merge made before the daemon starts');
  mgr.dispose();
  // W5: a commit on master inside a task worktree is refused (the hook is the repository's).
  repo.git(['switch', '-q', '-c', 'master'], login.path);
  let refused = '';
  try {
    fs.writeFileSync(path.join(login.path, 'oops.txt'), 'x\n');
    repo.git(['add', 'oops.txt'], login.path);
    repo.git(['commit', '-q', '-m', 'oops'], login.path);
  } catch (e) {
    refused = String((e as { stderr?: string }).stderr ?? e);
  }
  check(/protected branch/.test(refused), 'W5: the hook refused a commit on master in a task worktree');
  repo.git(['reset', '-q', '--', 'oops.txt'], login.path);
  fs.rmSync(path.join(login.path, 'oops.txt'));
  repo.git(['switch', '-q', login.branch], login.path);
  check(fs.readFileSync(path.join(configDir, 'guard-refusals.log'), 'utf-8').includes('master'), 'W5: the refusal is recorded');

  const daemon = startDaemon({ home, claudePath }, port, ['--engine', 'on', '--no-terminal', '--allow-actions'], {
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@localhost',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@localhost',
  });
  const cleanup = async () => {
    await daemon.stop();
    fs.rmSync(home, { recursive: true, force: true });
    repo.cleanup();
  };
  const deadline = setTimeout(() => {
    console.error('aborted: deadline');
    void cleanup().then(() => process.exit(1));
  }, 240_000);
  let browser;
  try {
    const loginUrl = await daemon.loginUrl();
    browser = await launchBrowser();
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1200 }, deviceScaleFactor: 1 });
    await ctx.addInitScript(() => {
      if (!localStorage.getItem('cld.status-tree')) localStorage.setItem('cld.status-tree', '{"rooms":true,"orchs":true}');
    });
    const font = fs.readFileSync(FONT);
    await ctx.route('**/__w4/malgun.ttf', (route) => route.fulfill({ body: font, contentType: 'font/ttf' }));
    const page: Page = await ctx.newPage();
    await page.goto(loginUrl);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await openOfficeWindow(page);
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
    const drawer = page.getByRole('complementary', { name: '사무실 정보' });
    await drawer
      .locator('article')
      .filter({ has: page.getByRole('heading', { name: 'alpha', exact: true }) })
      .getByRole('button', { name: '작업실', exact: true })
      .click();
    const bench = page.locator('[data-hud-window="workbench"], [aria-label="작업실 화면"]');
    await bench.waitFor();
    await bench.getByRole('button', { name: 'worktree', exact: true }).click();
    const panel = bench.getByLabel('alpha 저장소');
    await panel.getByText('작업 공간 (3)').waitFor();

    const rows = panel.getByTestId('worktree-row');
    const rowOf = (task: string) => panel.locator(`[data-testid="worktree-row"][data-task="${task}"]`);
    const open = async (task: string) => {
      const r = rowOf(task);
      await r.getByTestId('worktree-detail-toggle').click();
      await r.getByTestId('worktree-file-tab').first().waitFor();
      return r;
    };
    check((await rows.count()) === 3, 'three worktrees listed');
    const rLogin = await open(login.task);
    const rApi = await open('t-2-api');
    const tabs = async (r: ReturnType<typeof rowOf>) => (await r.getByTestId('worktree-file-tab').allTextContents()).map((t) => t.trim());
    const tl = await tabs(rLogin);
    const ta = await tabs(rApi);
    check(tl.length === 3 && tl.some((t) => t.includes('login.ts')) && tl.some((t) => t.includes('todo.txt')), `login's own files: ${tl.join(' | ')}`);
    check(ta.length === 1 && ta[0].includes('api.ts'), `api's own files: ${ta.join(' | ')}`);
    check((await rLogin.getByTestId('worktree-commits').textContent())?.includes('login:'), 'login shows its commit');
    await rLogin.getByTestId('worktree-file-tab').filter({ hasText: 'login.ts' }).click();
    await rLogin.getByLabel('diff', { exact: true }).waitFor();
    check(((await rLogin.getByLabel('diff', { exact: true }).textContent()) ?? '').includes('+export const login = true;'), "login.ts's diff shows");
    check((await rLogin.getByTestId('worktree-guard').textContent())?.includes('가드'), 'the guard note shows');
    const history = panel.getByTestId('merge-history');
    await history.waitFor();
    check((await history.textContent())?.includes('docs') && (await history.textContent())?.includes('main'), 'the merge made before the restart is in the history');
    await rLogin.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, 'workbench.png') });
    await history.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'workbench-history.png') });
    console.log(`screenshots: ${OUT}/workbench.png, workbench-history.png`);
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await cleanup();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
