/**
 * SPT-P3-ISSUES end to end on the REAL spec API (no page.route fixtures), set up like
 * run-spec-p2-real: dist/cli.js in a temp HOME (the engine fake as `claude`, no real agent), one
 * project `alpha` whose folder is a temp git repository with an SRS (FR-ENG-001..003), Tasks in
 * tasks.json: T-1 (P0, Ann) confirmed to FR-ENG-001 through the API, T-2 (P1, Lead) whose title
 * names FR-ENG-002, T-3 (P1, Bo) with neither. Spec tracking on through the API.
 *  1. the 요구사항 filter on FR-ENG-001 leaves T-1 only; ✕ clears it
 *  2. the 우선순위 and 담당 filters
 *  3. T-2's detail shows FR-ENG-002 as observed, with where the ID is written
 *  4. [확인] makes it confirmed
 *  5. [요구사항 연결] links FR-ENG-003
 *  6. a chip opens the requirement's detail
 *  7. phone 390x844: no horizontal scroll on the 이슈 tab with a Task detail open
 * Screenshots in cld/artifacts/spec-p3-issues/.
 *
 *   npx tsx cld/test/run-spec-p3-issues.ts [port 18292|18293|18318|18319]
 */
import type { Browser, BrowserContextOptions, Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import type { TraceTaskReqs } from '../../core/src/cld/spec/trace.js';
import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import { assertPortFree, type Daemon, DEV_WINDOW, killFakeSessions, launchBrowser, makeEngineHome, openOfficeWindow, REPO_ROOT, startDaemon } from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]) || 18292;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/spec-p3-issues');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__sp/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 300_000;
const PHONE: BrowserContextOptions = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } };
})();
let oks = 0;
let lastShown = '';
const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  oks++;
  console.log(`ok - ${text}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually<T>(what: string, test: () => Promise<T | null | undefined | false>, timeout = 20_000): Promise<T> {
  for (const end = Date.now() + timeout; ; await wait(200)) {
    const v = await test();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what} (cards: ${lastShown})`);
  }
}
const SRS =
  '# SRS\n\n## 3.1 엔진\n\n| ID | 요구 | 출처 |\n|---|---|---|\n| FR-ENG-001 | 엔진이 세션을 이어 받는다 | |\n| FR-ENG-002 | 엔진이 작업을 기록한다 | |\n| FR-ENG-003 | 엔진이 꺼진 프로젝트를 건너뛴다 | |\n';
const AT = '2026-11-03T08:00:00.000Z';
const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });

async function main() {
  if (![18292, 18293, 18308, 18309, 18318, 18319].includes(port)) throw new Error('port 18292, 18293, 18308, 18309, 18318 or 18319');
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  const put = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(cfg, rel)), { recursive: true });
    fs.writeFileSync(path.join(cfg, rel), JSON.stringify(data));
  };
  const repo = makeTempRepo({ push: false });
  repo.write('docs/requirements/SRS.md', SRS);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(repo.folder, 'docs/requirements/SRS.md'), old, old);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs: SRS']);
  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  put('projects.json', { v: 2, projects: [{ projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: repo.folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }] });
  put('assignments.json', { v: 1, assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true }] });
  const t = (id: string, title: string, priority: string, owner: { kind: string; name: string }) => ({ id, project: 'alpha', title, status: 'todo', priority, owner, source: 'reported', createdAt: AT, updatedAt: AT, history: [] });
  put('tasks.json', {
    v: 2,
    tasks: [
      t('T-1', '세션 이어 받기', 'P0', { kind: 'worker', name: 'Ann' }),
      t('T-2', 'FR-ENG-002 기록 정리', 'P1', { kind: 'lead', name: 'alpha' }),
      t('T-3', '설치 안내 다듬기', 'P1', { kind: 'worker', name: 'Bo' }),
    ],
  });
  const daemon: Daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal']);
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}, repo ${repo.folder}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL'); // our own daemon only
  }, DEADLINE_MS);
  try {
    browser = await launchBrowser();
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    if (fs.existsSync(FONT)) await ctx.route('**/__sp/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
    const page = await ctx.newPage();
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    const api = async <T>(route: string): Promise<T> => {
      const r = await page.request.get(`http://127.0.0.1:${port}/api/cld/spec/alpha/${route}`);
      if (!r.ok()) throw new Error(`${route}: ${r.status()} ${await r.text()}`);
      return (await r.json()) as T;
    };
    const post = (route: string, body: object) =>
      page.evaluate(async ([r, b]) => (await fetch(`/api/cld/spec/alpha/${r}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).status, [route, body] as const);
    check((await post('enable', { docs: ['docs/requirements/SRS.md'] })) === 200, 'spec tracking on');
    const items = (await api<{ items: Array<{ uid: string; displayId?: string }> }>('items')).items;
    const uid = Object.fromEntries(items.map((i) => [i.displayId ?? '', i.uid]));
    check(items.length === 3, `three requirements (${items.map((i) => i.displayId).join(' ')})`);
    check((await post('links', { from: uid['FR-ENG-001'], to: 'T-1', rel: 'implements' })) === 200, 'T-1 confirmed to FR-ENG-001 through the API');
    const t1 = await api<TraceTaskReqs>('task/T-1');
    check(t1.enabled && t1.edges.length === 1 && t1.edges[0].status === 'confirmed' && t1.nodes[0]?.label === 'FR-ENG-001', 'the Task route: T-1 has FR-ENG-001 confirmed');
    check((await page.request.get(`http://127.0.0.1:${port}/api/cld/spec/alpha/task/T-404`)).status() === 404, 'the Task route: an unknown Task is 404');

    await openOfficeWindow(page);
    const win = page.locator(DEV_WINDOW);
    await win.getByRole('button', { name: '프로젝트', exact: true }).click();
    const picker = win.getByRole('combobox', { name: '개발 프로젝트' });
    await eventually('alpha in the picker', async () => (await picker.locator('option[value="alpha"]').count()) > 0);
    await picker.selectOption('alpha');
    await win.getByTestId('hud-title-office').dblclick();
    await win.getByRole('button', { name: '이슈', exact: true }).click();
    const board = win.getByTestId('task-board');
    // The Task cards only: the tracking feed may add a card for the SRS document itself.
    const shown = async (): Promise<string> => (await board.locator('[data-testid="task-card"]:not([data-tracked])').evaluateAll((els) => els.map((e) => e.getAttribute('data-task-id')))).join(' ');
    const shownAll = async () => (lastShown = await shown());
    await eventually('three Tasks', async () => (await shownAll()) === 'T-1 T-2 T-3');
    check(true, 'the 이슈 tab shows T-1 T-2 T-3');

    // ── 1. 요구사항 filter ──
    await board.getByTestId('spec-issues-filter').click();
    await board.getByTestId('spec-issues-search').fill('FR-ENG-001');
    await eventually('the picker finds FR-ENG-001', async () => (await board.locator('[data-testid="spec-issues-pick"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))).join(' ') === 'FR-ENG-001');
    await board.locator('[data-testid="spec-issues-pick"][data-id="FR-ENG-001"]').click();
    await eventually('T-1 only', async () => (await shownAll()) === 'T-1');
    const chip = await board.getByTestId('spec-issues-chip').textContent();
    check(chip?.includes('FR-ENG-001'), `1: the 요구사항 filter on FR-ENG-001 leaves T-1 only; the chip shows the ID (${chip})`);
    await shot(page, '01-req-filter');
    await board.getByTestId('spec-issues-clear').click();
    await eventually('all again', async () => (await shownAll()) === 'T-1 T-2 T-3');
    check(true, '1: ✕ clears the filter');

    // ── 2. priority and owner ──
    const priority = board.getByRole('combobox', { name: '우선순위' }).first();
    const owner = board.getByRole('combobox', { name: '담당' }).first();
    await priority.selectOption('P1');
    await eventually('P1', async () => (await shownAll()) === 'T-2 T-3');
    check(true, '2: 우선순위 P1 leaves T-2 T-3');
    await owner.selectOption('worker:Bo');
    await eventually('P1 and Bo', async () => (await shownAll()) === 'T-3');
    check(true, '2: with 담당 Bo, T-3 only');
    await shot(page, '02-priority-owner');
    await priority.selectOption('');
    await owner.selectOption('');
    await eventually('all again', async () => (await shownAll()) === 'T-1 T-2 T-3');

    // ── 3. T-2's detail: FR-ENG-002 observed ──
    const card = (id: string) => board.locator(`[data-testid="task-card"][data-task-id="${id}"]`);
    await card('T-2').locator('> button').click();
    const reqs = card('T-2').getByTestId('spec-task-reqs');
    const link = (id: string): Locator => reqs.locator(`[data-testid="spec-link"][data-to="${uid[id]}"]`);
    await eventually('observed FR-ENG-002', async () => (await link('FR-ENG-002').getAttribute('data-status').catch(() => null)) === 'observed');
    const text = await link('FR-ENG-002').textContent();
    check(text?.includes('관측') && text.includes('T-2에 ID가 적혀 있어요'), `3: FR-ENG-002 is observed with where its ID is written (${text})`);
    await shot(page, '03-task-observed');

    // ── 4. [확인] ──
    await link('FR-ENG-002').getByTestId('spec-link-confirm').click();
    await eventually('confirmed', async () => (await link('FR-ENG-002').getAttribute('data-status')) === 'confirmed');
    check(true, '4: [확인] makes it confirmed');

    // ── 5. [요구사항 연결] FR-ENG-003 ──
    await reqs.getByTestId('spec-issues-link').click();
    await reqs.getByTestId('spec-issues-search').fill('FR-ENG-003');
    await eventually('FR-ENG-003 offered', async () => (await reqs.locator('[data-testid="spec-issues-pick"][data-id="FR-ENG-003"]').count()) === 1);
    await reqs.locator('[data-testid="spec-issues-pick"][data-id="FR-ENG-003"]').click();
    await eventually('FR-ENG-003 linked', async () => (await link('FR-ENG-003').getAttribute('data-status').catch(() => null)) === 'confirmed');
    const t2 = await api<TraceTaskReqs>('task/T-2');
    check(t2.edges.map((e) => `${t2.nodes.find((n) => n.id === e.from)?.label}:${e.status}`).sort().join(' ') === 'FR-ENG-002:confirmed FR-ENG-003:confirmed', '5: [요구사항 연결] linked FR-ENG-003 (the API agrees)');
    await shot(page, '04-task-linked');

    // ── 6. a chip opens the requirement detail ──
    await link('FR-ENG-003').getByTestId('spec-link-open').click();
    const detail = win.getByTestId('spec-detail');
    await eventually('detail', async () => (await detail.getAttribute('data-uid')) === uid['FR-ENG-003'] && (await detail.getByTestId('spec-detail-freshness').count()) > 0);
    check((await detail.getByTestId('spec-detail-id').textContent()) === 'FR-ENG-003', '6: a chip opens the requirement detail');
    await shot(page, '05-req-detail');
    const phoneState = await ctx.storageState();
    await ctx.close();

    // ── 7. phone ──
    const pctx = await browser.newContext({ ...PHONE, storageState: phoneState });
    if (fs.existsSync(FONT)) await pctx.route('**/__sp/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
    const phone = await pctx.newPage();
    await phone.goto(`http://127.0.0.1:${port}/`);
    await phone.addStyleTag({ content: FONT_CSS });
    await phone.locator('[data-dock="board"]').tap();
    const pw = phone.locator('[aria-label="현황판 화면"]');
    const dev = pw.getByRole('button', { name: '프로젝트', exact: true });
    if ((await dev.count()) && (await dev.getAttribute('aria-pressed')) !== 'true') await dev.tap();
    await pw.getByRole('navigation', { name: '개발 메뉴' }).getByRole('button', { name: '이슈', exact: true }).tap();
    const pb = pw.getByTestId('task-board');
    await eventually('phone board', async () => (await pb.locator('[data-testid="task-card"]:not([data-tracked])').count()) === 3);
    await pb.getByTestId('spec-issues-filter').tap();
    await pb.getByTestId('spec-issues-search').fill('FR');
    await eventually('phone picker', async () => (await pb.getByTestId('spec-issues-pick').count()) === 3);
    const noScroll = () => phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    check(await noScroll(), '7: no horizontal scroll at 390 px with the requirement picker open');
    await shot(phone, '06-phone-picker');
    await pb.getByRole('button', { name: '닫기', exact: true }).tap();
    await pb.locator('[data-testid="task-card"][data-task-id="T-2"] > button').tap();
    await eventually('phone reqs', async () => (await pb.getByTestId('spec-link').count()) === 2);
    check(await noScroll(), '7: no horizontal scroll at 390 px with a Task detail and its requirements open');
    await pb.getByTestId('spec-task-reqs').scrollIntoViewIfNeeded();
    await shot(phone, '07-phone-task');
    await pctx.close();
    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    console.error(daemon.log.join('').split('\n').filter((l) => /spec|error/i.test(l)).slice(-20).join('\n'));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    repo.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
