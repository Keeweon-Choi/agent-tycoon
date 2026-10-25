/**
 * DEV-BOARD check: dist/cli.js in an isolated HOME on a spare port, headless
 * Chromium with --disable-gpu. The seed list goes in with `cld-gui task import`,
 * S4 is linked to a running Codex task (`--codex`), and the 작업 tab must:
 * - open on 업무 with the 지금 하는 일 strip: the Codex owner's S4 with the observed
 *   Codex state beside it (관측), no percentage anywhere;
 * - show the seeded cards in their status groups (S1 under 검토, 끝남 folded);
 * - take a status change in the card editor (U-15 할 일 → 진행 중) that
 *   `cld-gui task list --json` then reports, and move the card without a reload;
 * - follow a CLI change live (S1 → 막힘);
 * - on a phone (393x852), list the same groups with nothing wider than the screen.
 * Screenshots go to cld/artifacts/taskboard/.
 *
 *   npx tsx cld/test/run-taskboard.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  openWorkbenchTab,
  REPO_ROOT,
  seedCodexTask,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const OUT = path.join(REPO_ROOT, 'cld/artifacts/taskboard');
// The repo's fixture (same shape as the orchestrator's list, neutral names): the orchestrator's
// own seed changes as the work moves (S4 is done now), so it must not decide this check.
// TASK_SEED=<file> points the check at another list.
const SEED =
  process.env.TASK_SEED ?? path.join(REPO_ROOT, 'server/src/cld/fixtures/dev-board-seed.json');
const CLI = path.join(REPO_ROOT, 'cld/bin/cld-gui');
const CODEX_ID = '1023-233618-cld-gui';
const FONTS = {
  malgun: '/mnt/c/Windows/Fonts/malgun.ttf',
  emoji: '/mnt/c/Windows/Fonts/seguiemj.ttf',
};
const FONT_CSS = `
@font-face { font-family: 'FS Pixel Sans'; src: url('/__fonts/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }
@font-face { font-family: 'FS Pixel Sans'; src: url('/__fonts/emoji.ttf');
  unicode-range: U+2300-23FF, U+2600-27BF, U+FE0F, U+1F000-1FAFF; }`;
const DEADLINE_MS = 150_000;

let checks = 0;
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  checks += 1;
  console.log(`ok - ${what}`);
}

async function until(
  what: string,
  fn: () => Promise<boolean> | boolean,
  ms = 20_000,
): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
}

async function main() {
  const port = sparePort();
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'S-8', agentsJson: true });
  // The seed's tasks belong to cld-gui: a project (off) of this home, so the 작업실 lists it.
  fs.mkdirSync(path.join(fake.home, '.config/cld-gui'), { recursive: true });
  fs.writeFileSync(
    path.join(fake.home, '.config/cld-gui/projects.json'),
    JSON.stringify([{ name: 'cld-gui', folder: path.join(fake.home, 'cld-gui'), wantRunning: false }]),
  );
  const sleeper = spawn('sleep', ['600'], { stdio: 'ignore', detached: true });
  sleeper.unref();
  seedCodexTask(fake.home, {
    id: CODEX_ID,
    project: 'cld-gui',
    state: 'running',
    started: new Date(Date.now() - 12 * 60_000).toISOString(),
    pid: sleeper.pid!,
    model: 'm1',
    title: 'S4 Tailscale 헤더 로그인 폐지',
  });
  const started = startDaemon(fake, port, ['--no-terminal']);
  const daemon = started.child;
  const cleanup = () => {
    sleeper.kill('SIGKILL');
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
    fs.rmSync(fake.home, { recursive: true, force: true });
  };
  const deadline = setTimeout(() => {
    console.error(`aborted: deadline ${DEADLINE_MS / 1000} s\n${started.log.join('')}`);
    cleanup();
    process.exit(1);
  }, DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.once(sig, () => {
      cleanup();
      process.exit(1);
    });

  /** `cld-gui …` as an agent would run it, against this HOME's daemon. */
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH, HOME: fake.home },
      cwd: fake.home,
      encoding: 'utf-8',
    });
    if (r.status !== 0) throw new Error(`cld-gui ${args.join(' ')}: ${r.status} ${r.stderr}`);
    return r.stdout;
  };
  const listed = () =>
    (JSON.parse(cli('task', 'list', '--json')) as { tasks: Array<{ id: string; status: string }> })
      .tasks;

  const fonts = fs.existsSync(FONTS.malgun)
    ? { malgun: fs.readFileSync(FONTS.malgun), emoji: fs.readFileSync(FONTS.emoji) }
    : null;
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript('globalThis.__name = (fn) => fn;');
    if (fonts)
      await ctx.route('**/__fonts/*.ttf', (route) =>
        route.fulfill({
          body: route.request().url().endsWith('emoji.ttf') ? fonts.emoji : fonts.malgun,
          contentType: 'font/ttf',
        }),
      );
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    return { ctx, page };
  };
  const ready = async (page: Page, url: string) => {
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    if (fonts) {
      await page.addStyleTag({ content: FONT_CSS });
      await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가📖'));
    }
  };
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const cardStatus = (page: Page, id: string) =>
    page
      .locator(`[data-testid="task-card"][data-task-id="${id}"]`)
      .first()
      .getAttribute('data-task-status');

  try {
    const loginUrl = await started.loginUrl();
    // The seed, as the orchestrator will import it, and S4's Codex run.
    const imported = cli('task', 'import', SEED);
    // The seed's size is the file's own (it grows with the orchestrator's list).
    const seeded = (JSON.parse(fs.readFileSync(SEED, 'utf-8')) as { tasks: unknown[] }).tasks
      .length;
    check(
      new RegExp(`작업 ${seeded}개 추가, 0개 바꿈, 0개 그대로`).test(imported),
      `the seed imports: ${imported.trim()}`,
    );
    const again = cli('task', 'import', SEED);
    check(
      new RegExp(`0개 추가, 0개 바꿈, ${seeded}개 그대로`).test(again),
      `a second import changes nothing: ${again.trim()}`,
    );
    cli('task', 'update', 'S4', '--codex', CODEX_ID);

    // ── desktop ──
    const { ctx: deskCtx, page: desk } = await open({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    await ready(desk, loginUrl);
    // UI-C1: the board is the 작업실's Task tab, narrowed to the project (the seed's is cld-gui).
    await openWorkbenchTab(desk, 'Task', { project: 'cld-gui' });
    const switcher = desk.getByRole('group', { name: '작업 보기' });
    check(
      (await switcher
        .getByRole('button', { name: '업무', exact: true })
        .getAttribute('aria-pressed')) === 'true',
      'desktop: the Task tab opens on 업무',
    );
    const strip = desk.getByTestId('task-now');
    const codexRow = desk
      .getByTestId('task-now-row')
      .filter({ has: desk.locator('[data-task-id="S4"]') });
    await until('desktop: 지금 하는 일 lists S4', async () => (await codexRow.count()) === 1);
    const stripText = await strip.innerText();
    const codexRowText = await codexRow.innerText();
    check(
      codexRowText.includes('S4') &&
        codexRowText.includes('관측') &&
        /Codex · 실행 중 · 1\d분째/.test(codexRowText),
      `desktop: S4 in the strip with its observed Codex state: ${codexRowText.replace(/\n/g, ' | ')}`,
    );
    check(
      (await desk.getByTestId('task-now-row').count()) >= 3,
      'desktop: the strip has a row per busy owner',
    );
    check(!/%|남은 시간|ETA/.test(stripText), 'desktop: no percentage or ETA in the strip (F-15)');
    check((await cardStatus(desk, 'S1')) === 'review', 'desktop: S1 is under 검토');
    check(
      (await desk
        .locator('[data-testid="task-group"][data-status="done"] [data-testid="task-card"]')
        .count()) === 0,
      'desktop: 끝남 is folded',
    );
    const s4 = desk.locator('[data-testid="task-card"][data-task-id="S4"]');
    check(
      (await s4.getByTestId('task-source').innerText()) === '보고' &&
        (await s4.getByTestId('task-run').count()) === 1,
      'desktop: S4 card is 보고 with its 관측 Codex run beside it',
    );
    await shot(desk, 'desktop-board');

    // Change U-15's status in the card editor.
    const u15 = desk.locator('[data-testid="task-card"][data-task-id="U-15"]');
    await u15.getByRole('button').first().click();
    await u15.getByTestId('task-editor').waitFor();
    await u15.getByRole('combobox', { name: '상태' }).selectOption('doing');
    await shot(desk, 'desktop-detail');
    await u15.getByRole('button', { name: '저장' }).click();
    await until(
      'cld-gui task list reports U-15 doing',
      () => listed().find((t) => t.id === 'U-15')?.status === 'doing',
    );
    check(true, 'desktop: the status change reached the store (cld-gui task list --json)');
    await until(
      'desktop: U-15 moves to 진행 중 without a reload',
      async () => (await cardStatus(desk, 'U-15')) === 'doing',
    );
    check(
      (await strip.innerText()).includes('레벨·경험치'),
      'desktop: U-15 joins 지금 하는 일 (미배정 row)',
    );
    // A CLI change arrives live.
    cli('task', 'update', 'S1', '--status', 'blocked', '--note', '러너 회귀');
    await until(
      'desktop: S1 moves to 막힘 live',
      async () => (await cardStatus(desk, 'S1')) === 'blocked',
    );
    check(true, 'desktop: a CLI update shows without a reload');
    await desk.locator('[data-testid="task-group"][data-status="done"] button').first().click();
    await until(
      'desktop: 끝남 unfolds',
      async () =>
        (await desk
          .locator('[data-testid="task-group"][data-status="done"] [data-testid="task-card"]')
          .count()) > 0,
    );
    await shot(desk, 'desktop-board-after');

    // ── phone ──
    const { ctx: phoneCtx, page: phone } = await open({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    await phoneCtx.addCookies(await deskCtx.cookies());
    await ready(phone, `http://127.0.0.1:${port}/`);
    await openWorkbenchTab(phone, 'Task', { project: 'cld-gui', tap: true });
    await phone.getByTestId('task-now').waitFor();
    await until(
      'phone: the board shows S1 blocked',
      async () => (await cardStatus(phone, 'S1')) === 'blocked',
    );
    const groups = await phone
      .locator('[data-testid="task-group"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-status')));
    check(
      JSON.stringify(groups) === JSON.stringify(['doing', 'review', 'blocked', 'todo', 'done']),
      `phone: one list grouped by status (${groups.join(', ')})`,
    );
    const widths = await phone.evaluate(() => {
      const board = document.querySelector('[data-testid="task-board"]') as HTMLElement;
      const wide = [...board.querySelectorAll<HTMLElement>('*')].filter(
        (el) => el.getBoundingClientRect().right > window.innerWidth + 1,
      );
      return {
        doc: document.documentElement.scrollWidth,
        view: window.innerWidth,
        wide: wide.length,
      };
    });
    check(
      widths.doc <= widths.view && widths.wide === 0,
      `phone: nothing wider than the screen (${JSON.stringify(widths)})`,
    );
    check(
      (await phone.getByRole('combobox', { name: '프로젝트', exact: true }).count()) === 1 &&
        (await phone.getByRole('combobox', { name: '목표' }).count()) === 1 &&
        (await phone.getByRole('combobox', { name: '담당' }).count()) === 1,
      'phone: the same filters',
    );
    await shot(phone, 'phone-board');
    await phone.getByRole('combobox', { name: '목표' }).selectOption('Security');
    await until(
      'phone: goal filter',
      async () => (await phone.locator('[data-task-id="U-15"]').count()) === 0,
    );
    check(
      (await phone.locator('[data-task-id="S1"]').count()) === 1,
      'phone: the goal filter keeps Security tasks only',
    );
    await shot(phone, 'phone-filtered');

    check(pageErrors.length === 0, `no page errors${pageErrors.map((e) => `\n  ${e}`).join('')}`);
    console.log(`all ${checks} checks passed`);
  } finally {
    clearTimeout(deadline);
    await browser.close();
    cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
