/**
 * P4-S5, the code editor in the 파일 window, end to end: dist/cli.js in a temp HOME on a spare port,
 * a temp repository `shop-web` with three task worktrees (the engine's fake claude as Lead and
 * Workers, never a real claude). Desktop (Chromium --disable-gpu, 1280x800): the dev room's `…` menu
 * "탐색기에서 열기" roots the 파일 window at the worktree; a file is opened read-only, 편집 loads
 * CodeMirror (its own chunk, fetched only now), an edit is saved to disk; then the runner rewrites
 * lines 6-7 as the agent would: the banner and the yellow lines appear, a save is refused
 * ("디스크에서 바뀜", the file stays the agent's), 다시 불러오기 loads the agent's text, and a save
 * with a stale hash gets 409 over HTTP. The picker is shown open (W4). Phone (390x844, touch): the
 * file read-only with its note, then 편집 (W5 right). Screenshots in agent-tycoon/artifacts/p4-s5/.
 *
 *   nice -n 10 npx tsx agent-tycoon/test/run-files-edit.ts <port 18262|18263>
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
if (port !== 18262 && port !== 18263) throw new Error('port: 18262 or 18263');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/p4-s5');
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

const CART = [
  "import { useCart } from './useCart'",
  "import { sumPrice, formatWon } from './price'",
  '',
  'export function Cart() {',
  '  const { items } = useCart()',
  '  const total = sumPrice(items)',
  '  const label = formatWon(total)',
  '  return <CartView total={label} />',
  '}',
  '',
].join('\n');
const FILE = 'src/shop/Cart.tsx';
const WORK = [
  { worker: 'web-worker', title: 'cart-total', status: 'doing' },
  { worker: 'api-worker', title: 'rate-limit', status: 'review' },
  { worker: 'ui-worker', title: 'pay-copy', status: 'doing' },
];

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const repo = makeTempRepo();
  const folder = repo.folder;
  repo.write(FILE, CART);
  repo.write('package.json', '{ "name": "shop-web" }\n');
  repo.write('README.md', '# shop-web\n');
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'the cart']);
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify({
      v: 2,
      projects: [
        {
          projectId: 'p_aaaaaaaaaa',
          name: 'shop-web',
          folder,
          room: '개발실',
          leadAssignmentId: 'a_aaaaaaaaaa',
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(cfg, 'assignments.json'),
    JSON.stringify({
      v: 1,
      assignments: [
        {
          assignmentId: 'a_aaaaaaaaaa',
          projectId: 'p_aaaaaaaaaa',
          role: 'lead',
          provider: 'claude',
          wantRunning: true,
        },
      ],
    }),
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
      spawnSync(process.execPath, [path.join(REPO_ROOT, 'agent-tycoon/bin/agty'), ...args], {
        env: { PATH, HOME: home, AGTY_OUTPUT: 'json' },
        encoding: 'utf8',
        timeout: 60_000,
      });
    const json = (r: ReturnType<typeof cli>) => JSON.parse(r.stdout || '{}') as Record<string, any>;
    const session = (name: string) =>
      fs.readdirSync(path.join(home, '.claude/sessions')).some((file) => {
        try {
          return (
            (
              JSON.parse(fs.readFileSync(path.join(home, '.claude/sessions', file), 'utf8')) as {
                name: string;
              }
            ).name === name
          );
        } catch {
          return false;
        }
      });
    await daemon.loginUrl();
    await eventually('the Lead revived', () => session('shop-web'));

    const wts: WorktreeRecord[] = [];
    for (const [i, w] of WORK.entries()) {
      check(
        json(cli('worker', 'add', 'shop-web', w.worker)).ok === true,
        `Worker ${w.worker} added`,
      );
      const id = json(
        cli(
          'task',
          'add',
          w.title,
          '--project',
          'shop-web',
          '--assignee',
          w.worker,
          '--status',
          w.status,
        ),
      ).task?.id as string;
      check(id === `T-${i + 1}`, `Task ${id} for ${w.worker}`);
      check(
        json(cli('worktree', 'new', '--task', id, '--assign', w.worker)).ok === true,
        `${id} gets a worktree for ${w.worker}`,
      );
      wts.push(
        (
          JSON.parse(fs.readFileSync(path.join(cfg, 'worktrees.json'), 'utf8')) as WorktreeRecord[]
        ).find((r) => r.taskId === id)!,
      );
    }
    const wt = wts[0];
    const onDisk = path.join(wt.path, FILE);
    check(fs.readFileSync(onDisk, 'utf8') === CART, `${wt.task} holds the cart file`);
    check(json(cli('worker', 'start', 'web-worker')).ok === true, 'web-worker started');
    await eventually('web-worker live', () => session('web-worker'));
    cli('send', 'web-worker', 'sumPrice 로 분리해 주세요');

    browser = await launchBrowser();
    // The "v0.1 으로 업데이트됐어요" toast would cover the screenshots: the webview's own version counts as seen.
    const seen = '0.1';
    const newPage = async (
      b: Browser,
      opts: Parameters<Browser['newContext']>[0],
      root?: object,
    ) => {
      const ctx = await b.newContext(opts);
      await ctx.addInitScript(
        ([v, r]) => {
          localStorage.setItem('agty.changelogSeen', v as string);
          if (r) localStorage.setItem('agty.files.root.v1', r as string);
        },
        [seen, root ? JSON.stringify(root) : ''],
      );
      const p = await ctx.newPage();
      await p.goto(await daemon.loginUrl());
      await p.waitForURL(`http://127.0.0.1:${port}/`);
      return p;
    };
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
    const chunks: string[] = [];

    // ── Desktop ──
    const desk = await newPage(browser, { viewport: { width: 1280, height: 800 } });
    desk.on('request', (r) => {
      if (/Editor-.*\.js/.test(r.url())) chunks.push(r.url());
    });
    await desk.locator('[data-hud-id="icon:devroom"] button').click();
    const dev = desk.locator('[data-hud-window="devroom"]');
    await dev.waitFor({ timeout: 20_000 });
    await dev.getByTestId('devroom-filter').click();
    await dev.getByRole('menuitemradio', { name: 'shop-web' }).click();
    const card = (task: string) => dev.locator(`[data-testid="devroom-card"][data-task="${task}"]`);
    await card(wt.task).waitFor({ timeout: 20_000 });
    await card(wt.task).getByTestId('devroom-more').click();
    await dev.getByTestId('devroom-menu').locator('[data-item="explorer"]').click();
    const files = desk.locator('section[aria-label="파일 탐색"]');
    await files.waitFor({ timeout: 20_000 });
    const picker = files.getByTestId('root-picker');
    await desk.waitForFunction(
      (t) => document.querySelector('[data-testid="root-picker"]')?.textContent?.includes(t),
      wt.task,
      { timeout: 10_000 },
    );
    check(true, `"탐색기에서 열기" roots the 파일 window at ${wt.task}`);
    check(chunks.length === 0, 'CodeMirror (the Editor chunk) is not fetched while only browsing');

    const treeButton = (name: string) =>
      files.getByRole('button', { name: new RegExp(`${name}$`) }).last();
    await treeButton('src').click();
    await treeButton('shop').click();
    await treeButton('Cart.tsx').click();
    const pane = files.getByLabel('파일 미리보기');
    await pane.getByText('sumPrice(items)').first().waitFor({ timeout: 10_000 });
    check(
      (await pane.getByTestId('edit-switch').getAttribute('aria-checked')) === 'false',
      '편집 is off by default (read-only view)',
    );
    check(chunks.length === 0, 'still no editor chunk while reading');

    // Edit and save.
    await pane.getByTestId('edit-switch').click();
    const editor = pane.getByTestId('code-editor').locator('.cm-content');
    await editor.waitFor({ timeout: 20_000 });
    check(
      chunks.length === 1,
      `pressing 편집 fetched the editor chunk once (${chunks[0]?.split('/').pop()})`,
    );
    check(
      (await pane.getByTestId('edit-status').innerText()).includes(
        '저장하기 전에는 파일이 바뀌지 않아요',
      ),
      'the status line says nothing changes before saving',
    );
    check(await pane.getByTestId('edit-save').isDisabled(), '저장 waits for a change');
    await editor.click();
    await desk.keyboard.press('Control+End');
    await desk.keyboard.type('// 합계는 sumPrice 로');
    check(fs.readFileSync(onDisk, 'utf8') === CART, 'typing alone does not touch the file');
    await pane.getByTestId('edit-save').click();
    await pane.getByTestId('edit-status').getByText('저장했어요').waitFor({ timeout: 10_000 });
    const saved = fs.readFileSync(onDisk, 'utf8');
    check(
      saved.endsWith('// 합계는 sumPrice 로'),
      'a save writes the typed text to the worktree file',
    );
    check(
      saved.startsWith(CART.split('\n').slice(0, 8).join('\n')),
      'the rest of the file is as it was',
    );

    // The agent changes lines 6-7 while the owner has an edit pending.
    await editor.click();
    await desk.keyboard.press('Control+End');
    await desk.keyboard.type('!');
    const mine = fs.readFileSync(onDisk, 'utf8');
    const agent = mine.split('\n');
    agent[5] = '  const total = sumPrice(items) // by web-worker';
    agent[6] = '  const label = formatWon(total, 0)';
    fs.writeFileSync(onDisk, agent.join('\n'));
    await pane.getByTestId('edit-changed').waitFor({ timeout: 15_000 });
    check(true, 'the banner "에이전트가 방금 이 파일을 바꿨어요" appears within the poll');
    const marked = await pane
      .locator('.cm-agent-line')
      .evaluateAll((els) => els.map((e) => e.textContent));
    check(
      marked.length === 2 &&
        marked[0]?.includes('sumPrice(items)') &&
        marked[1]?.includes('formatWon(total)'),
      `the yellow lines are 6 and 7 (${marked.join(' | ')})`,
    );
    check(
      (await pane.getByTestId('edit-lines').innerText()).includes('6, 7번째 줄'),
      'the caption names lines 6, 7',
    );
    await picker.click();
    await files.getByTestId('root-picker-menu').waitFor();
    const rows = await files
      .getByTestId('root-picker-menu')
      .getByRole('menuitemradio')
      .allInnerTexts();
    check(
      rows.length === 4 &&
        rows[0].startsWith('main') &&
        rows[1].includes(wt.task) &&
        rows[1].includes('web-worker'),
      `the picker lists main and the worktrees (${rows.map((r) => r.replace(/\n/g, ' / ')).join(' | ')})`,
    );
    await desk.waitForTimeout(300);
    await shot(desk, 'W4-desktop-edit-picker');
    await desk.keyboard.press('Escape');
    await files.getByTestId('root-picker-menu').waitFor({ state: 'detached' });

    // A save while the file is different on disk is refused, and the disk keeps the agent's text.
    await pane.getByTestId('edit-save').click();
    await pane
      .getByTestId('edit-status')
      .getByText('디스크에서 바뀜 · 저장하지 않았어요')
      .waitFor({ timeout: 10_000 });
    check(
      fs.readFileSync(onDisk, 'utf8') === agent.join('\n'),
      "the refused save left the agent's file untouched",
    );
    await desk.waitForTimeout(300);
    await shot(desk, 'W4-desktop-refused');

    // The same refusal over HTTP: a stale hash gets 409 with the disk's hash.
    const raw = await desk.evaluate(
      async ([project, task]) => {
        const res = await fetch(`/api/agty/files/${project}/text`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: 'src/shop/Cart.tsx', task, text: 'x', baseHash: 'stale' }),
        });
        return {
          status: res.status,
          body: (await res.json()) as { errorCode?: string; hash?: string },
        };
      },
      ['shop-web', wt.task],
    );
    check(
      raw.status === 409 &&
        raw.body.errorCode === 'file_changed_on_disk' &&
        /^[0-9a-f]{64}$/.test(raw.body.hash ?? ''),
      'HTTP: a stale hash gets 409 file_changed_on_disk with the disk hash',
    );
    check(fs.readFileSync(onDisk, 'utf8') === agent.join('\n'), 'HTTP: the 409 wrote nothing');

    // 다시 불러오기 takes the agent's text, then a save works.
    await pane.getByRole('button', { name: '다시 불러오기' }).click();
    await pane.getByTestId('edit-changed').waitFor({ state: 'detached' });
    check(
      (await editor.innerText()).includes('by web-worker'),
      "다시 불러오기 shows the agent's text",
    );
    check(
      (await pane.locator('.cm-agent-line').count()) === 2,
      'the yellow lines stay after reloading',
    );
    await editor.click();
    await desk.keyboard.press('Control+End');
    await desk.keyboard.type('// ok');
    await pane.getByTestId('edit-save').click();
    await pane.getByTestId('edit-status').getByText('저장했어요').waitFor({ timeout: 10_000 });
    check(
      fs.readFileSync(onDisk, 'utf8').endsWith('// ok') &&
        fs.readFileSync(onDisk, 'utf8').includes('by web-worker'),
      'after reloading, the save goes through',
    );
    check((await pane.locator('.cm-agent-line').count()) === 0, 'a save clears the yellow lines');
    await pane.getByTestId('edit-switch').click();
    await pane.getByText('by web-worker').first().waitFor();
    check(true, 'turning 편집 off returns to the read-only view');

    // ── Phone: W5 right ──
    const phone = await newPage(
      browser,
      {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      },
      { kind: 'worktree', project: 'shop-web', task: wt.task },
    );
    await phone.locator('[data-hud-id="icon:files"] button').click();
    const pexp = phone.locator('section[aria-label="파일 탐색"]');
    await pexp.waitFor({ timeout: 20_000 });
    const ptree = (name: string) =>
      pexp.getByRole('button', { name: new RegExp(`${name}$`) }).last();
    await ptree('src').tap();
    await ptree('shop').tap();
    await ptree('Cart.tsx').tap();
    const ppane = phone.getByLabel('파일 미리보기');
    await ppane.getByText('formatWon').first().waitFor({ timeout: 10_000 });
    check(
      await ppane.getByText('지금은 읽기만 돼요').isVisible(),
      'phone: read-only, with the note',
    );
    await phone.waitForTimeout(300);
    await shot(phone, 'W5-phone-readonly');
    await ppane.getByRole('button', { name: '편집', exact: true }).tap();
    await ppane.getByTestId('code-editor').locator('.cm-content').waitFor({ timeout: 20_000 });
    const overflow = await phone.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    check(overflow <= 0, `phone: no sideways scroll (${overflow})`);
    await phone.waitForTimeout(300);
    await shot(phone, 'W5-phone-edit');

    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    fs.writeFileSync(path.join(os.tmpdir(), 'run-files-edit.daemon.log'), daemon.log.join(''));
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
