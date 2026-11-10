/**
 * DEVROOM-PROJECT (owner 11-03 10:38), the dev room's 프로젝트 추가 end to end: dist/cli.js in a
 * temp HOME on a spare port, the engine's fake claude (never a real claude), one project already
 * there (shop-web). Desktop (Chromium --disable-gpu, 1280x800): the rail's `+` opens the dialog,
 * 폴더 열기 picks a plain folder under ~/projects, the dialog says it is no git repository, git init
 * makes it one, the engine's add form comes with the folder and its name filled, 추가 makes the
 * Lead and the dev room lists the project. Phone (390x844, touch): `+ 프로젝트 추가`, 주소로 클론
 * from a local bare repository under the HOME into ~/projects/cloned-app, the add form, 추가, the
 * new project's chip and trunk. Screenshots in agent-tycoon/artifacts/devroom-project/.
 *
 *   nice -n 10 npx tsx agent-tycoon/test/run-devroom-project.ts <port 18266|18267>
 */
import type { Browser, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { makeTempRepo } from '../../server/src/agent-tycoon/engine/git/testRepo.js';
import { assertPortFree, killFakeSessions, launchBrowser, makeEngineHome, REPO_ROOT, startDaemon } from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (port !== 18266 && port !== 18267) throw new Error('port: 18266 or 18267');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/devroom-project');
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
  // 폴더 열기's plain folder, and 주소로 클론's source: a bare repository with one commit, both under the HOME.
  const projects = path.join(home, 'projects');
  const local = path.join(projects, 'local-app');
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, 'README.md'), '# local-app\n');
  const bare = path.join(home, 'src', 'remote.git');
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  repo.git(['clone', '-q', '--bare', repo.remote, bare], repo.root);
  const PATH = [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    {
      PATH,
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
    await daemon.loginUrl();
    browser = await launchBrowser();
    const seen = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version.split('.').slice(0, 2).join('.');
    const newPage = async (b: Browser, opts: Parameters<Browser['newContext']>[0]) => {
      const ctx = await b.newContext(opts);
      await ctx.addInitScript((v) => localStorage.setItem('agty.changelogSeen', v), seen);
      const p = await ctx.newPage();
      await p.goto(await daemon.loginUrl());
      await p.waitForURL(`http://127.0.0.1:${port}/`);
      return p;
    };
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });

    // ── Desktop: 폴더 열기 a plain folder, git init, the add form, the new project in the rail. ──
    const desk = await newPage(browser, { viewport: { width: 1280, height: 800 } });
    await desk.locator('[data-hud-id="icon:devroom"] button').click();
    const win = desk.locator('[data-hud-window="devroom"]');
    await win.waitFor({ timeout: 20_000 });
    await win.getByTestId('hud-title-devroom').dblclick();
    await win.locator('[data-testid="devroom-trunk"][data-project="shop-web"]').waitFor({ timeout: 20_000 });
    // DV4: the rail's + makes a worktree; 프로젝트 추가 is in the project menu.
    await win.getByTestId('devroom-filter').click();
    await win.getByTestId('devroom-add').click();
    const dialog = desk.getByTestId('devroom-add-dialog');
    await dialog.waitFor();
    check(true, 'desktop: the rail `+` opens 프로젝트 추가');
    await dialog.getByRole('button', { name: '찾아보기' }).click();
    const picker = desk.getByRole('button', { name: 'local-app' });
    await picker.click();
    await desk.getByRole('button', { name: '이 폴더 선택' }).click();
    check((await dialog.getByTestId('devroom-add-folder').inputValue()) === local, 'desktop: the folder picker fills the folder');
    await shot(desk, 'desktop-add-open');
    await dialog.getByTestId('devroom-add-next').click();
    await dialog.getByTestId('devroom-add-not-repo').waitFor({ timeout: 20_000 });
    check(true, 'desktop: a plain folder is said to be no git repository');
    await shot(desk, 'desktop-not-repo');
    await dialog.getByTestId('devroom-add-init').click();
    const form = desk.getByRole('form', { name: '오케스트레이터 추가' });
    await form.waitFor({ timeout: 20_000 });
    check(fs.existsSync(path.join(local, '.git')), 'desktop: git init made it a repository');
    check((await form.getByRole('textbox', { name: '이름' }).inputValue()) === 'local-app', "desktop: the add form takes the folder's name");
    await shot(desk, 'desktop-add-form');
    await form.getByRole('button', { name: '추가', exact: true }).click();
    const group = win.locator('[data-testid="devroom-group"][data-project="local-app"]');
    await group.waitFor({ timeout: 40_000 });
    check(true, 'desktop: the dev room lists local-app');
    await desk.waitForTimeout(1500);
    await shot(desk, 'desktop-added');
    const groupText = await group.innerText();
    console.log(`note - local-app group (empty repository): ${groupText.replace(/\n/g, ' | ')}`);

    // ── Phone: + 프로젝트 추가, 주소로 클론 a local bare repository, the add form, its chip. ──
    const phone = await newPage(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await phone.locator('[data-dock="devroom"]').tap();
    const list = phone.getByTestId('devroom-phone');
    await list.waitFor({ timeout: 20_000 });
    await list.getByTestId('devroom-add').tap();
    const pd = phone.getByTestId('devroom-add-dialog');
    await pd.waitFor();
    await pd.getByTestId('devroom-add-mode-clone').tap();
    await pd.getByTestId('devroom-add-url').fill(bare);
    check((await pd.getByTestId('devroom-add-name').inputValue()) === 'remote', 'phone: the folder name comes from the address');
    await pd.getByTestId('devroom-add-name').fill('cloned-app');
    check((await pd.getByTestId('devroom-add-parent').inputValue()) === '~/projects', 'phone: the clone goes under ~/projects by default');
    await shot(phone, 'phone-add-clone');
    await pd.getByTestId('devroom-add-next').tap();
    const pform = phone.getByRole('form', { name: '오케스트레이터 추가' });
    await pform.waitFor({ timeout: 60_000 });
    check(fs.existsSync(path.join(projects, 'cloned-app', 'a.txt')), 'phone: the bare repository was cloned into ~/projects/cloned-app');
    check((await pform.getByRole('textbox', { name: '이름' }).inputValue()) === 'cloned-app', 'phone: the add form takes cloned-app');
    await shot(phone, 'phone-add-form');
    await pform.getByRole('button', { name: '추가', exact: true }).tap();
    await list.getByTestId('devroom-filter').getByRole('radio', { name: 'cloned-app' }).waitFor({ timeout: 40_000 });
    await list.locator('[data-testid="devroom-group"][data-project="cloned-app"]').waitFor({ timeout: 20_000 });
    check(true, 'phone: the dev room lists cloned-app');
    await phone.waitForTimeout(1500);
    await shot(phone, 'phone-added');
    // A second clone into the same folder is refused, and says so.
    await list.getByTestId('devroom-add').tap();
    await pd.getByTestId('devroom-add-mode-clone').tap();
    await pd.getByTestId('devroom-add-url').fill(bare);
    await pd.getByTestId('devroom-add-name').fill('cloned-app');
    await pd.getByTestId('devroom-add-next').tap();
    await pd.getByTestId('devroom-add-error').waitFor({ timeout: 20_000 });
    check((await pd.getByTestId('devroom-add-error').innerText()).includes('이미 있어요'), 'phone: an existing folder is refused');
    await shot(phone, 'phone-clone-exists');
    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    fs.writeFileSync(path.join(os.tmpdir(), 'run-devroom-project.daemon.log'), daemon.log.join(''));
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
