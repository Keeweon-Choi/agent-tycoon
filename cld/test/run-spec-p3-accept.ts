/**
 * SPT-P3-ACCEPT end to end on the REAL API (no page.route fixtures but the font): dist/cli.js in a
 * temp HOME (the engine fake as `claude`, no real agent), one project `alpha` whose folder is a temp
 * git repository with an SRS (an `인수 기준` column, a fake secret in FR-ENG-001's row, FR-ENG-001's
 * 출처 cell naming T-2) below a long 개요 so [원본 열기] has to scroll. Setup as run-spec-p2-real.
 *  1b. the text changes while the detail is open: 수락 is refused as stale and the detail refetches
 *  1. 수락 with a memo; the list shows 수락
 *  2. the SRS line edited: '지금 버전 검토 전 · 이전 버전(…) 수락', 최신 names 수용 재검토
 *  3. [연결 검토함] leaves acceptance (and acceptance.json) as it is
 *  4. 반려 cannot be sent without a memo (button and API)
 *  5. 원문 shows the text, the fake secret masked
 *  6. 인수 기준 from the table column
 *  7. [원본 열기] lands on the line, scrolled there and marked
 *  8. phone 390x844: the detail is full screen, no horizontal scroll
 * Screenshots in cld/artifacts/spec-p3-accept/.
 *
 *   npx tsx cld/test/run-spec-p3-accept.ts [port 18290|18291]
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import type { TraceItem } from '../../core/src/cld/spec/trace.js';
import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import { assertPortFree, type Daemon, DEV_WINDOW, killFakeSessions, launchBrowser, makeEngineHome, openOfficeWindow, REPO_ROOT, startDaemon } from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]) || 18290;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/spec-p3-accept');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__sp/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 300_000;
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
async function eventually<T>(what: string, test: () => Promise<T | null | undefined | false>, timeout = 40_000): Promise<T> {
  for (const end = Date.now() + timeout; ; await wait(300)) {
    const v = await test();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}

const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;
const INTRO = Array.from({ length: 80 }, (_, i) => `개요 문단 ${i + 1}.`).join('\n\n');
const ROW1 = `| FR-ENG-001 | 엔진이 세션을 이어 받는다 (키 ${TOKEN}) | T-2 | 재시작 뒤 같은 세션<br>토큰 유지 |`;
const SRS = `# SRS\n\n## 1. 개요\n\n${INTRO}\n\n## 3.1 엔진\n\n| ID | 요구 | 출처 | 인수 기준 |\n|---|---|---|---|\n${ROW1}\n| FR-ENG-002 | 엔진이 작업을 기록한다 | | |\n`;
const ROW1_LINE = SRS.split('\n').indexOf(ROW1) + 1;
const AT = '2026-11-03T08:00:00.000Z';

async function main() {
  if (port !== 18290 && port !== 18291) throw new Error('port 18290 or 18291');
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
  const srsPath = path.join(repo.folder, 'docs/requirements/SRS.md');
  const writeSrs = (text: string) => {
    repo.write('docs/requirements/SRS.md', text);
    const old = new Date(Date.now() - 60_000); // settled: the scan reads it now
    fs.utimesSync(srsPath, old, old);
  };
  writeSrs(SRS);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs: SRS']);
  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  put('projects.json', { v: 2, projects: [{ projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: repo.folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }] });
  put('assignments.json', { v: 1, assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true }] });
  put('tasks.json', { v: 2, tasks: [{ id: 'T-2', project: 'alpha', title: '세션 이어 받기', status: 'doing', source: 'reported', createdAt: AT, updatedAt: AT, history: [] }] });
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
    const font = async (c: typeof ctx) => {
      if (fs.existsSync(FONT)) await c.route('**/__sp/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
    };
    await font(ctx);
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
    const u = uid['FR-ENG-001'];
    check(u && uid['FR-ENG-002'], `two requirements (${items.map((i) => i.displayId).join(' ')})`);

    await openOfficeWindow(page);
    const win = page.locator(DEV_WINDOW);
    await win.getByRole('button', { name: '개발', exact: true }).click();
    const picker = win.getByRole('combobox', { name: '개발 프로젝트' });
    await eventually('alpha in the picker', async () => (await picker.locator('option[value="alpha"]').count()) > 0);
    await picker.selectOption('alpha');
    await win.getByTestId('hud-title-office').dblclick();
    await win.getByRole('button', { name: '요구사항', exact: true }).click();
    const row = (x: string) => win.locator(`[data-testid="spec-item"][data-uid="${x}"]`);
    const accCol = (x: string) => row(x).getByTestId('spec-item-trace').locator('[data-col="acceptance"]').textContent();
    await eventually('rows', async () => (await row(u).count()) === 1);
    await row(u).getByRole('button').click();
    const detail = win.getByTestId('spec-detail');
    await eventually('detail', async () => (await detail.getAttribute('data-uid')) === u && (await detail.getByTestId('spec-detail-text').count()) === 1);

    // ── 5. 원문, masked ──
    const text = (await detail.getByTestId('spec-detail-text').textContent()) ?? '';
    check(text.includes('엔진이 세션을 이어 받는다') && text.includes('***') && !text.includes(TOKEN), `5: 원문 shows the row, the fake secret masked (${text.slice(0, 80)}…)`);
    check((await detail.getByTestId('spec-detail-text').getByTestId('spec-detail-row').count()) === 1 && text.includes('요구:'), "5: the row reads as 'column: value' lines (SPT-P3-FINISH), not as a table");
    // ── 6. 인수 기준 ──
    const crit = await detail.getByTestId('spec-detail-criteria').locator('li').allTextContents();
    check(crit.join(' | ') === '재시작 뒤 같은 세션 | 토큰 유지', `6: 인수 기준 from the table column (${crit.join(' | ')})`);
    await shot(page, '01-detail-text-criteria');

    // ── 4. 반려 needs a memo ──
    const set = (s: string) => detail.locator(`[data-testid="spec-accept-set"][data-state="${s}"]`);
    check(await set('rejected').isDisabled(), '4: 반려 is disabled while the memo is empty');
    check((await post('acceptance', { uid: u, state: 'rejected' })) === 400, '4: the API refuses 반려 without a note (400)');

    // ── 1b. the text changes while the detail is open: 수락 is refused as stale, the detail reads it again ──
    await detail.getByTestId('spec-accept-memo').fill('인수 기준 둘 다 확인');
    check(await set('rejected').isEnabled(), '4: 반려 is enabled once the memo has text');
    writeSrs(SRS.replace('토큰 유지 |', '토큰 계속 유지 |'));
    await set('accepted').click();
    await eventually('stale toast', async () => (await page.getByText('원문이 그사이 바뀌었어요', { exact: false }).count()) > 0);
    await eventually('the new text shown', async () => (await detail.getByTestId('spec-detail-text').textContent())?.includes('토큰 계속 유지'));
    check(!fs.existsSync(path.join(cfg, 'spec/p_aaaaaaaaaa/acceptance.json')), '1b: 수락 on the text the owner had read is refused as stale, nothing recorded');
    check((await detail.getByTestId('spec-accept-memo').inputValue()) === '인수 기준 둘 다 확인', '1b: the detail read the new text again; the memo stays');
    await shot(page, '01b-stale-refetched');

    // ── 1. 수락 with a memo, on the text shown now ──
    await set('accepted').click();
    await eventually('accepted', async () => (await detail.getByTestId('spec-detail-acceptance').textContent())?.endsWith('수락'));
    const hist1 = await detail.getByTestId('spec-accept-history').locator('li').allTextContents();
    check(/^지금 버전 · 수락 · 사장님 · \d\d-\d\d \d\d:\d\d · 인수 기준 둘 다 확인$/.test(hist1[0] ?? ''), `1: the history line (${hist1[0]})`);
    await eventually('list shows 수락', async () => (await accCol(u)) === '수락');
    check(true, '1: the list shows 수락');
    const accFile = path.join(cfg, 'spec/p_aaaaaaaaaa/acceptance.json');
    check((fs.statSync(accFile).mode & 0o777) === 0o600, '1: acceptance.json is 0600');
    // A link to review later: confirm the observed T-2.
    const t2 = detail.locator('[data-testid="spec-link"][data-to="T-2"]');
    await t2.getByTestId('spec-link-confirm').click();
    await eventually('T-2 confirmed', async () => (await t2.getAttribute('data-status')) === 'confirmed');
    await shot(page, '02-accepted');

    // ── 2. the SRS line edited ──
    writeSrs(SRS.replace('엔진이 세션을 이어 받는다', '엔진이 세션을 끊김 없이 이어 받는다'));
    await eventually('the edit scanned', async () => (await api<TraceItem>(`item/${u}`)).node.state?.acceptanceReview, 60_000);
    await detail.getByTestId('spec-detail-close').click();
    await row(u).getByRole('button').click();
    await eventually('detail again', async () => (await detail.getByTestId('spec-link-review').count()) === 1);
    const accText = await detail.getByTestId('spec-detail-acceptance').textContent();
    check(/지금 버전 검토 전 · 이전 버전\(\d\d-\d\d\) 수락$/.test(accText ?? ''), `2: ${accText}`);
    const fresh = await detail.getByTestId('spec-detail-freshness').textContent();
    check(fresh?.endsWith('재검토 필요 · 연결 재검토 · 수용 재검토'), `2: 최신 names both branches (${fresh})`);
    const hist2 = await detail.getByTestId('spec-accept-history').locator('li').allTextContents();
    check(hist2[0]?.startsWith('이전 버전 · 수락'), `2: the record is now an earlier version's (${hist2[0]})`);
    check((await accCol(u)) === '검토 전', '2: the list shows 검토 전 for the new text');
    await shot(page, '03-text-changed');

    // ── 3. [연결 검토함] leaves acceptance ──
    const bytes = fs.readFileSync(accFile);
    await detail.getByTestId('spec-review').click();
    await eventually('link review done', async () => (await detail.getByTestId('spec-link-review').count()) === 0);
    const fresh3 = await detail.getByTestId('spec-detail-freshness').textContent();
    check(fresh3?.endsWith('재검토 필요 · 수용 재검토'), `3: only 수용 재검토 is left (${fresh3})`);
    check((await detail.getByTestId('spec-detail-acceptance').textContent()) === accText, '3: acceptance reads the same');
    check(fs.readFileSync(accFile).equals(bytes), '3: acceptance.json is byte for byte the same');
    await shot(page, '04-after-link-review');
    // The 수용▾ filter (daemon side): 수용 재검토 lists FR-ENG-001 only.
    await win.getByTestId('spec-reqs-acceptance').selectOption('review');
    await eventually('filtered', async () => (await win.locator('[data-testid="spec-item"]').count()) === 1 && (await row(u).count()) === 1);
    check(true, '1: 수용▾ 수용 재검토 lists FR-ENG-001 only');
    await win.getByTestId('spec-reqs-acceptance').selectOption('');
    const summary = await api<{ acceptance?: Record<string, number> }>('summary');
    check(JSON.stringify(summary.acceptance) === JSON.stringify({ none: 2, validate: 0, accepted: 0, rejected: 0, review: 1 }), `summary acceptance counts (${JSON.stringify(summary.acceptance)})`);

    // ── 7. [원본 열기] at the line ──
    await detail.getByTestId('spec-detail-open').click();
    const marked = page.locator('[data-testid="file-lines"] [aria-current="true"]');
    await eventually('the file viewer at the line', async () => (await marked.count()) === 1);
    check((await marked.getAttribute('data-line')) === String(ROW1_LINE), `7: the marked line is ${ROW1_LINE} (${await marked.getAttribute('data-line')})`);
    await wait(300);
    const inView = await marked.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    });
    check(inView && ROW1_LINE > 100, '7: scrolled there (the line is on screen, below a long 개요)');
    await shot(page, '05-open-source-line');
    const phoneState = await ctx.storageState();
    await ctx.close();

    // ── 8. phone ──
    const pctx = await browser.newContext({ ...PHONE, storageState: phoneState });
    await font(pctx);
    const phone = await pctx.newPage();
    await phone.goto(`http://127.0.0.1:${port}/`);
    await phone.addStyleTag({ content: FONT_CSS });
    await phone.locator('[data-dock="board"]').tap();
    const pw = phone.locator('[aria-label="현황판 화면"]');
    const dev = pw.getByRole('button', { name: '개발', exact: true });
    if ((await dev.count()) && (await dev.getAttribute('aria-pressed')) !== 'true') await dev.tap();
    await pw.getByRole('navigation', { name: '개발 메뉴' }).getByRole('button', { name: '요구사항', exact: true }).tap();
    const prow = pw.locator(`[data-testid="spec-item"][data-uid="${u}"]`);
    await eventually('phone row', async () => (await prow.count()) === 1);
    await prow.getByRole('button').tap();
    const pd = phone.getByTestId('spec-detail');
    await eventually('phone detail', async () => (await pd.getByTestId('spec-accept').count()) === 1);
    const box = await pd.boundingBox();
    check(box && box.width >= 389 && box.height >= 840, `8: the detail is full screen (${box?.width}x${box?.height})`);
    const noScroll = await phone.evaluate(() => {
      const d = document.querySelector('[data-testid="spec-detail"]')!;
      return document.documentElement.scrollWidth <= window.innerWidth + 1 && d.scrollWidth <= d.clientWidth + 1;
    });
    check(noScroll, '8: no horizontal scroll (page and detail)');
    await shot(phone, '06-phone-detail');
    await pd.getByTestId('spec-accept').scrollIntoViewIfNeeded();
    await shot(phone, '07-phone-accept');
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
const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
