/**
 * GAME-UI-1 G2 (현황판·요구사항·이슈: cockpit 09·11, agents 08) end to end on the REAL API: dist/cli.js
 * in a temp HOME (the engine fake as `claude`), project `alpha` on a temp git repository holding this
 * repository's SRS. Nine requirements accepted through the API (HI-SCORE 0009); acceptance.json
 * seeded with five past weeks whose best is 9 (fixture records, as tasks.json is seeded); Tasks on the
 * board with priorities, T-5 confirmed to FR-TRC-008, T-4 to FR-ENG-001.
 *  1. 요구사항: the tab row's HI-SCORE 0009; FR-TRC-008's [수락] → the gold stamp drops (frames, the
 *     animations slowed 10x through CDP), the panel thunks, the tab row rolls 0009 → 0010, the row's 수락 mark
 *  2. 반려 FR-ENG-002 with a memo: a quiet dashed stamp with the memo, no score change, no thunk
 *  3. stale: FR-ENG-003's text edited after it was shown: [수락] is refused, no stamp, no score
 *  4. 개요: the big HI-SCORE 0010; 이번 주 수락 10 against a best of 9 → 신기록 (gold); one more
 *     accepted through the API while shown → today's column gains a cell and the big HI-SCORE rolls
 *  5. 이슈: the quest board in columns, pins, stars, faces, requirement chips with LEDs, T-1's 완료
 *     stamp; T-4 → 끝남 in the card editor drops its stamp (frames)
 *  6. 게임 효과 off: no animation; a photo
 *  7. phone 390x844: the 개요's week and the 이슈 list, no horizontal scroll
 *  8. beside the mocks (11, 08, 09)
 * Screenshots in cld/artifacts/game-cockpit/.
 *
 *   npx tsx cld/test/run-game-cockpit.ts [port 18318|18319]
 */
import type { Browser, BrowserContextOptions, CDPSession, Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import { assertPortFree, type Daemon, DEV_WINDOW, killFakeSessions, launchBrowser, makeEngineHome, REPO_ROOT, startDaemon } from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]) || 18318;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/game-cockpit');
const MOCKS = path.join(REPO_ROOT, '../specs/ui-mock-1103/ideas');
const DEADLINE_MS = 420_000;
const PROJECT_ID = 'p_aaaaaaaaaa';
const AT = new Date(Date.now() - 2 * 3600_000).toISOString();
const DAY = 86_400_000;
const PHONE: BrowserContextOptions = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } };
})();
let oks = 0;
const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  oks++;
  console.log(`ok - ${text}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually<T>(what: string, test: () => Promise<T | null | undefined | false>, timeout = 30_000): Promise<T> {
  for (const end = Date.now() + timeout; ; await wait(150)) {
    const v = await test();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}
const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
/** All CSS animations at `rate` (0.1 = ten times slower) so start, middle and end can be photographed. */
const slow = (cdp: CDPSession, rate: number) => cdp.send('Animation.setPlaybackRate', { playbackRate: rate });

const task = (id: string, title: string, status: string, priority: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  project: 'alpha',
  title,
  status,
  source: 'reported',
  createdAt: AT,
  updatedAt: AT,
  history: [],
  ...(priority && { priority }),
  ...extra,
});
const LEAD = { assignmentId: 'a_aaaaaaaaaa', name: 'alpha' };

async function main() {
  if (port !== 18318 && port !== 18319) throw new Error('port 18318 or 18319');
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
  const SRS = fs.readFileSync(path.join(REPO_ROOT, 'cld/docs/requirements/SRS.md'), 'utf-8');
  repo.write('docs/requirements/SRS.md', SRS);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(repo.folder, 'docs/requirements/SRS.md'), old, old);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs: SRS']);
  repo.git(['commit', '-q', '--allow-empty', '-m', 'FR-TRC-008: show the four states apart']);
  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  put('projects.json', { v: 2, projects: [{ projectId: PROJECT_ID, name: 'alpha', folder: repo.folder, room: '개발실', leadAssignmentId: LEAD.assignmentId }] });
  put('assignments.json', { v: 1, assignments: [{ assignmentId: LEAD.assignmentId, projectId: PROJECT_ID, role: 'lead', provider: 'claude', wantRunning: true }] });
  put('tasks.json', {
    v: 2,
    tasks: [
      task('T-7', '설치 안내 다듬기', 'todo', 'P1'),
      task('T-9', '폰에서 근거 범례 접기', 'todo', 'P2'),
      task('T-10', '커밋 ID 대소문자 무시', 'todo', null),
      task('T-5', '네 가지 상태 따로 보이기', 'doing', 'P0', { assignee: LEAD, testsPassed: { value: true, source: 'reported', at: AT } }),
      task('T-4', '반려 메모 꼭 받기', 'review', 'P1', { assignee: LEAD }),
      task('T-6', '배포 확인 작업 만들기', 'blocked', 'P1'),
      task('T-1', '문서에서 요구사항 읽기', 'done', 'P1', { assignee: LEAD }),
    ],
  });
  // Fixture history: five past weeks of acceptance records (best 9), oldest first like the daemon writes them.
  const PAST = [3, 0, 7, 5, 9];
  const records = PAST.flatMap((n, w) =>
    Array.from({ length: n }, (_, i) => ({
      uid: `r_seed${w}x${String(i).padStart(4, '0')}`,
      textHash: 'seed',
      state: 'accepted',
      by: { kind: 'owner', name: 'owner' },
      at: new Date(Date.now() - (PAST.length - w) * 7 * DAY).toISOString(),
      evidence: { change: 'none', integration: 'none', test: 'none', deploy: 'none', reported: false },
    })),
  );
  put(`spec/${PROJECT_ID}/acceptance.json`, { v: 1, rev: 1, records });
  const daemon: Daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal']);
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}, repo ${repo.folder}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL'); // our own daemon only
  }, DEADLINE_MS);
  try {
    browser = await launchBrowser();
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Animation.enable');
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    const call = (route: string, body?: object) =>
      page.evaluate(
        async ([r, b]) => {
          const res = await fetch(`/api/cld/spec/alpha/${r}`, b ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) } : {});
          return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
        },
        [route, body] as const,
      );
    check((await call('enable', { docs: ['docs/requirements/SRS.md'] })).status === 200, 'spec tracking on');
    const list = (await call('items?kind=requirements')).json.items as Array<{ uid: string; displayId?: string }>;
    const uid = (id: string) => list.find((i) => i.displayId === id)!.uid;
    for (const body of [
      { from: uid('FR-TRC-008'), to: 'T-5', rel: 'implements' },
      { from: uid('FR-ENG-001'), to: 'T-4', rel: 'implements' },
    ])
      check((await call('links', body)).status === 200, `link ${body.to}`);
    const accept = async (u: string, state = 'accepted') => {
      const version = (await call(`item/${u}`)).json.version as string;
      return call('acceptance', { uid: u, state, version });
    };
    const keep = new Set(['FR-TRC-008', 'FR-ENG-002', 'FR-ENG-003', 'FR-TRC-010']);
    const nine = list.filter((i) => i.displayId && !keep.has(i.displayId)).slice(0, 9);
    for (const i of nine) check((await accept(i.uid)).status === 200, `${i.displayId} accepted through the API`);
    const sum = (await call('summary')).json as { items: { total: number }; acceptance: { accepted: number }; week: { days: Array<{ accepted: number }>; weeks: number[]; today: number } };
    check(sum.acceptance.accepted === 9 && sum.week.weeks.join() === PAST.join() && sum.week.days[sum.week.today].accepted === 9, `the summary: 9 accepted, past weeks ${sum.week.weeks.join(',')}, today ${sum.week.days[sum.week.today].accepted}`);

    // ── 1. 요구사항: 수락 ──
    const win = page.locator(DEV_WINDOW);
    const icon = page.locator('[data-hud-id="icon:office"] button');
    await icon.waitFor();
    if (!(await win.isVisible())) await icon.click();
    await win.getByRole('button', { name: '프로젝트', exact: true }).click();
    const picker = win.getByRole('combobox', { name: '개발 프로젝트' });
    await eventually('alpha in the picker', async () => (await picker.locator('option[value="alpha"]').count()) > 0);
    await picker.selectOption('alpha');
    await win.getByTestId('hud-title-office').dblclick();
    const tab = (name: string) => win.getByRole('navigation', { name: '개발 메뉴' }).getByRole('button', { name, exact: true });
    await tab('요구사항').click();
    const hiTab = win.getByTestId('tab-hi-score');
    await eventually('the tab row HI-SCORE', async () => (await hiTab.getAttribute('data-count').catch(() => null)) === '9');
    check((await hiTab.innerText()).replace(/\s+/g, ' ').includes(`0009 / ${String(sum.items.total).padStart(4, '0')}`), `1: the tab row carries the HI-SCORE (${(await hiTab.innerText()).replace(/\s+/g, ' ')})`);
    const reqs = win.getByTestId('spec-reqs');
    const open = async (id: string) => {
      await reqs.getByTestId('spec-reqs-search').fill(id);
      const row = reqs.locator(`[data-testid="spec-item"][data-id="${id}"]`);
      await eventually(`${id} row`, async () => (await row.count()) === 1);
      await row.getByRole('button').first().click();
      const detail = win.getByTestId('spec-detail');
      await eventually(`${id} detail`, async () => (await detail.getByTestId('spec-detail-id').textContent()) === id && (await detail.getByTestId('spec-accept').count()) === 1);
      return { row, detail };
    };
    const { row: trcRow, detail } = await open('FR-TRC-008');
    check((await detail.getByTestId('spec-accept-stamp').count()) === 0, '1: no stamp before 수락');
    await shot(page, '01-reqs-before');
    await slow(cdp, 0.1);
    await detail.locator('[data-testid="spec-accept-set"][data-state="accepted"]').click();
    const stamp = detail.getByTestId('spec-accept-stamp');
    await stamp.waitFor();
    await shot(page, '02-accept-frame-0-start');
    await wait(1_300);
    await shot(page, '03-accept-frame-1-mid');
    await eventually('the tab row reached 0010', async () => (await hiTab.getAttribute('data-count')) === '10');
    await wait(4_500);
    await shot(page, '04-accept-frame-2-end');
    await slow(cdp, 1);
    const looks = await stamp.locator('.game-stamp').evaluate((el) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--score-gold)';
      document.body.append(probe);
      const gold = getComputedStyle(probe).color;
      probe.remove();
      return { tone: el.getAttribute('data-tone'), color: getComputedStyle(el).color, gold, text: (el as HTMLElement).innerText.replace(/\s+/g, ' ') };
    });
    check(looks.tone === 'gold' && looks.color === looks.gold && looks.text.startsWith('수락'), `1: the 수락 stamp is gold (${looks.text})`);
    check((await stamp.getAttribute('data-fresh')) === 'true' && ['a', 'b'].includes((await detail.getAttribute('data-thunk')) ?? ''), '1: it dropped here (fresh) and the panel thunked');
    check((await hiTab.locator('[data-testid="hi-digits"]').innerText()).replace(/\s+/g, '') === '0010', '1: the tab row HI-SCORE rolled to 0010');
    check((await trcRow.locator('[data-col="acceptance"] span').first().getAttribute('class'))?.includes('border-2'), "1: the row's 수용 cell is a framed 수락 mark");
    const box = await detail.boundingBox();
    const open1 = await detail.getByTestId('spec-detail-open').boundingBox();
    const sbox = await stamp.boundingBox();
    check(box && sbox && open1 && sbox.x + sbox.width <= box.x + box.width && sbox.y <= open1.y + open1.height, '1: the stamp sits top right beside [원본 열기], not over the text');
    if (box) await page.screenshot({ path: path.join(OUT, '05-accept-detail-zoom.png'), clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 420) } });

    // ── 2. 반려 ──
    const { detail: eng2 } = await open('FR-ENG-002');
    await eng2.getByTestId('spec-accept-memo').fill('배포 확인이 없어요. deploy check 부터 다시');
    await eng2.locator('[data-testid="spec-accept-set"][data-state="rejected"]').click();
    const rej = eng2.getByTestId('spec-reject-stamp');
    await rej.waitFor();
    await eventually('the 반려 stamp drawn (its two frames)', async () => (await rej.innerText()).includes('deploy check'));
    check((await rej.innerText()).includes('deploy check 부터 다시') && (await eng2.getByTestId('spec-accept-stamp').count()) === 0, `2: 반려 is a dashed stamp with the memo (${(await rej.innerText()).replace(/\s+/g, ' ')})`);
    check((await rej.evaluate((el) => getComputedStyle(el).borderTopStyle)) === 'dashed' && (await eng2.getAttribute('data-thunk')) === null, '2: dashed, no thunk');
    await wait(800);
    check((await hiTab.getAttribute('data-count')) === '10', '2: no score change on 반려');
    await rej.scrollIntoViewIfNeeded();
    await shot(page, '06-reject');

    // ── 3. stale ──
    const { detail: eng3 } = await open('FR-ENG-003');
    const edited = SRS.replace('| FR-ENG-003 | ', '| FR-ENG-003 | (edited) ');
    repo.write('docs/requirements/SRS.md', edited);
    const before = (await call('summary')).json as { acceptance: { accepted: number } };
    await eng3.locator('[data-testid="spec-accept-set"][data-state="accepted"]').click();
    await wait(2_500);
    const after = (await call('summary')).json as { acceptance: { accepted: number } };
    check((await eng3.getByTestId('spec-accept-stamp').count()) === 0 && after.acceptance.accepted === before.acceptance.accepted, `3: a stale 수락 is refused: no stamp, still ${after.acceptance.accepted}`);
    await shot(page, '07-stale-no-stamp');
    repo.write('docs/requirements/SRS.md', SRS);

    // ── 4. 개요 ──
    await eng3.getByTestId('spec-detail-close').click();
    await tab('개요').click();
    const ov = win.getByTestId('spec-cockpit');
    const week = ov.getByTestId('ov-week');
    await week.waitFor();
    await eventually('the week has 10 today', async () => (await week.getAttribute('data-total')) === '10');
    check((await week.getAttribute('data-record')) === 'true' && (await week.getAttribute('data-best')) === '9', '4: 10 this week beats the best past week (9): 신기록');
    const tileColor = await ov.getByTestId('ov-week-total').evaluate((el) => [getComputedStyle(el.querySelector('.wk-v')!).color, getComputedStyle(el).borderTopColor]);
    check(tileColor[0] === looks.gold, `4: the 신기록 box is gold (${tileColor.join(' ')})`);
    check((await ov.getByTestId('ov-acc-accepted').innerText()).replace(/\s+/g, ' ').includes('0010 /'), '4: the big HI-SCORE shows 0010');
    check((await win.getByTestId('tab-hi-score').count()) === 0, '4: no tab row copy on the 개요 (the big one is there)');
    await ov.getByTestId('ov-col-reqs').scrollIntoViewIfNeeded();
    await shot(page, '08-overview-week-record');
    await slow(cdp, 0.1);
    check((await accept(uid('FR-TRC-010'))).status === 200, '4: one more accepted through the API while the 개요 is shown');
    const today = week.locator('[data-testid="ov-week-day"][data-today]');
    await eventually('today +1', async () => Number(await today.getAttribute('data-accepted')) === 11, 20_000);
    await shot(page, '09-week-drop-frame-0-start');
    await wait(1_000);
    await shot(page, '10-week-drop-frame-1-mid');
    await wait(4_000);
    await shot(page, '11-week-drop-frame-2-end');
    await slow(cdp, 1);
    check((await today.locator('[data-new]').count()) === 1 && (await ov.getByTestId('ov-acc-accepted').locator('[data-testid="hi-digits"]').innerText()).replace(/\s+/g, '') === '0011', '4: a new cell dropped on today, the big HI-SCORE rolled to 0011');

    // ── 5. 이슈: the quest board ──
    await tab('이슈').click();
    const board = win.getByTestId('task-board');
    await board.waitFor();
    const card = (id: string) => board.locator(`[data-testid="task-card"][data-task-id="${id}"]`);
    await eventually('T-5 requirement chip', async () => (await card('T-5').getByTestId('quest-req').getAttribute('data-uid').catch(() => null)) === uid('FR-TRC-008'));
    const cols = await board.locator('[data-testid="task-group"]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-status'), Math.round(e.getBoundingClientRect().x)] as const).sort((a, b) => a[1] - b[1]).map((x) => x[0]));
    check(cols.join(' ') === 'todo doing review blocked done', `5: columns 할 일 → 끝남 side by side (${cols.join(' ')}; 끝남 folded)`);
    const t5 = card('T-5');
    check((await t5.locator('.quest-pin').count()) === 1 && (await t5.locator('.quest-stars').getAttribute('data-lit')) === '3' && (await t5.locator('.quest-stars').getAttribute('aria-label')) === '우선순위 P0', '5: T-5 is pinned, ★★★ named 우선순위 P0');
    const t5leds = await t5.getByTestId('quest-req').locator('[data-led]').evaluateAll((els) => els.map((e) => e.getAttribute('data-led')).join(' '));
    check(t5leds.split(' ').length === 4 && (await t5.locator('.quest-chip').innerText()).includes('FR-TRC-008'), `5: T-5 carries FR-TRC-008 and its four lights (${t5leds})`);
    await eventually('T-7 no requirement', async () => (await card('T-7').getByTestId('quest-req').innerText().catch(() => '')) === '요구사항 없음');
    check(true, '5: T-7 says 요구사항 없음');
    check((await card('T-10').locator('.quest-stars').getAttribute('data-lit')) === '0', '5: no priority: three dim stars');
    check((await t5.getByTestId('task-assignee').innerText()) === 'alpha' && (await t5.getByTestId('quest-who').locator('canvas, img').count()) === 1, `5: T-5's assignee alpha with the lead's face`);
    check((await card('T-6').getByTestId('quest-who').innerText()).includes('담당 없음') && (await card('T-6').locator('.quest-noface').count()) === 1, '5: nobody on T-6: an empty dashed face, 담당 없음');
    await board.locator('.quest-cols').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await shot(page, '12-quest-board');
    await board.locator('[data-testid="task-group"][data-status="done"] button').first().click();
    const t1 = card('T-1');
    await t1.waitFor();
    check((await t1.locator('[data-testid="game-stamp"]').getAttribute('data-still')) === 'true' && (await t1.getAttribute('data-done')) === 'true', '5: T-1 (done) carries a still 완료 stamp');
    // T-4 → 끝남 in the card editor: its stamp drops once.
    await card('T-4').locator('> button').click();
    await card('T-4').getByTestId('task-editor').waitFor();
    await card('T-4').getByRole('combobox', { name: '상태' }).selectOption('done');
    await slow(cdp, 0.1);
    await card('T-4').getByRole('button', { name: '저장' }).click();
    const t4stamp = board.locator('[data-testid="task-group"][data-status="done"] [data-task-id="T-4"] [data-testid="game-stamp"]');
    await t4stamp.waitFor();
    await t4stamp.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await shot(page, '13-done-frame-0-start');
    await wait(1_000);
    await shot(page, '14-done-frame-1-mid');
    await wait(3_000);
    await shot(page, '15-done-frame-2-end');
    await slow(cdp, 1);
    check((await t4stamp.getAttribute('data-still')) === null && (await t1.locator('[data-testid="game-stamp"]').getAttribute('data-still')) === 'true', '5: T-4 just turned done: its stamp dropped; T-1 stays still');
    check((await card('T-4').getByRole('button').first().getAttribute('aria-expanded')) !== null, '5: the card is still a button that opens its detail');

    // ── 6. 게임 효과 off ──
    const settings = async () => {
      await page.locator('button[aria-label="설정"]').first().click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ timeout: 10_000 });
      await dialog.locator('#settings-tab-display').click();
      await dialog.getByTestId('game-motion-option').getByRole('button', { pressed: false }).click(); // 끔 | 켬
      await dialog.locator('[data-modal-title] button').click();
      await dialog.waitFor({ state: 'detached', timeout: 10_000 });
    };
    await settings();
    check((await page.evaluate(() => document.documentElement.dataset.gameMotion)) === 'off', '6: 게임 효과 off');
    const anim = await t4stamp.evaluate((el) => getComputedStyle(el).animationName);
    check(anim === 'none', `6: no stamp animation (${anim})`);
    await tab('개요').click();
    await ov.getByTestId('ov-week').waitFor();
    await ov.getByTestId('ov-col-reqs').scrollIntoViewIfNeeded();
    await shot(page, '16-overview-effects-off');
    await settings();
    const state = await ctx.storageState();
    await ctx.close();

    // ── 7. phone ──
    const pctx = await browser.newContext({ ...PHONE, storageState: state });
    const phone = await pctx.newPage();
    await phone.goto(`http://127.0.0.1:${port}/`);
    await phone.locator('[data-dock="board"]').tap();
    const pw = phone.locator('[aria-label="현황판 화면"]');
    const dev = pw.getByRole('button', { name: '프로젝트', exact: true });
    if ((await dev.count()) && (await dev.getAttribute('aria-pressed')) !== 'true') await dev.tap();
    const pnav = pw.getByRole('navigation', { name: '개발 메뉴' });
    await pnav.getByRole('button', { name: '개요', exact: true }).tap();
    const pweek = pw.getByTestId('ov-week');
    await pweek.waitFor();
    await pweek.scrollIntoViewIfNeeded();
    await wait(300);
    const noScroll = () => phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    const inside = (l: Locator) => l.evaluate((el) => [...el.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > el.getBoundingClientRect().right + 1).length);
    check((await noScroll()) && (await inside(pweek)) === 0, '7: the week fits a phone');
    await shot(phone, '17-phone-week');
    await pnav.getByRole('button', { name: '이슈', exact: true }).tap();
    const pboard = pw.getByTestId('task-board');
    await pboard.waitFor();
    const pcols = await pboard.locator('[data-testid="task-group"]').evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().x))).size);
    check(pcols === 1 && (await noScroll()) && (await inside(pboard)) === 0, '7: the 이슈 board is one list on a phone, nothing sticks out');
    await pboard.locator('[data-testid="task-card"][data-task-id="T-5"]').scrollIntoViewIfNeeded();
    await shot(phone, '18-phone-quest');
    await pctx.close();

    // ── 8. beside the mocks ──
    const side = await browser.newPage({ viewport: { width: 1420, height: 600 } });
    const img = (f: string) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
    const pair = (mock: string, ours: string) =>
      `<div style="display:flex;gap:20px"><figure style="margin:0;width:700px"><figcaption>mock ${path.basename(mock)}</figcaption><img src="${img(mock)}" style="width:700px"></figure>` +
      `<figure style="margin:0;width:700px"><figcaption>GAME-UI-1 G2 ${path.basename(ours)}</figcaption><img src="${img(ours)}" style="width:700px"></figure></div>`;
    await side.setContent(
      `<body style="margin:0;font:14px sans-serif;display:grid;gap:16px">` +
        pair(path.join(MOCKS, 'cockpit/11-accept-stamp.png'), path.join(OUT, '04-accept-frame-2-end.png')) +
        pair(path.join(MOCKS, 'agents/08-level.png'), path.join(OUT, '08-overview-week-record.png')) +
        pair(path.join(MOCKS, 'cockpit/09-quest-board.png'), path.join(OUT, '12-quest-board.png')) +
        `</body>`,
    );
    await side.screenshot({ path: path.join(OUT, '19-beside-mocks.png'), fullPage: true });
    await side.close();
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
