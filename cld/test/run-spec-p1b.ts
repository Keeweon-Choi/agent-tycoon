/**
 * SPT-P1B visual check: dist/cli.js in a temp HOME (the engine fake as `claude`, no real agent),
 * one project `alpha` whose folder is a temp git repository holding an SRS-like table document,
 * a design document with ID headings, a plan with checkboxes and a PRD without IDs.
 *  1. Turn spec tracking on (the 켜기 window).
 *  2. 요구사항 lists the requirement IDs; every kind shows the design's and the plan's items too.
 *  3. The PRD shows nothing until its mode is 제목도 항목; then its `##` headings appear and its
 *     `###` does not. No repository byte changed so far (.git included).
 *  4. A row's text edited (its ID kept) and committed, then a daemon restart: the same UID, read
 *     through the API; again no byte changed but our own commit.
 *  5. A second document defines the same ID: the 확인할 것 alert shows, 개요 counts it.
 *  6. A new file in the tracked folder: tracked by itself, flagged 새 문서.
 *  7. Phone 390x844: the 요구사항 and 문서 tabs, no horizontal page scroll.
 * Screenshots in cld/artifacts/spec-p1b/.
 *
 *   npx tsx cld/test/run-spec-p1b.ts [port 18280|18281]
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import {
  assertPortFree,
  type Daemon,
  DEV_WINDOW,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openOfficeWindow,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/cld/testHome.js';
import { SPEC_SCAN_MIN_MS } from '../../server/src/constants.js';

const port = Number(process.argv[2]) || 18280;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/spec-p1b');
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
async function eventually<T>(what: string, test: () => Promise<T | null | undefined | false>, timeout = 30_000): Promise<T> {
  for (const end = Date.now() + timeout; ; await wait(250)) {
    const v = await test();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}

/** sha256 of every file under `root`, `.git` included. */
function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of fs.readdirSync(root, { recursive: true }).map(String).sort()) {
    const abs = path.join(root, rel);
    if (fs.lstatSync(abs).isFile()) out[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  }
  return out;
}
const diff = (a: Record<string, string>, b: Record<string, string>) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);

type Item = { uid: string; displayId?: string; title: string; doc: string; state: string };
type Doc = { uid: string; path: string; fresh: boolean; mode: string };

const SRS =
  '# SRS\n\n## 3.1 사무실\n\n| ID | 요구 | 상태 |\n|---|---|---|\n| FR-OFC-001 | 오케스트레이터 탭마다 방이 있다 | 완료 |\n| FR-OFC-002 | 방 이름을 바꿀 수 있다 | 진행 |\n| NFR-PERF-008 | 꺼진 프로젝트는 비용 0 | 검토 |\n';
const DESIGN = '# Cockpit 설계\n\n## D-001 사이드카에 둔다\n\n원본에는 쓰지 않는다.\n\n## D-002 화면은 지연 로드\n\n메인 번들은 그대로.\n';
const PLAN = '# 계획\n\n## 이번 주\n\n- [x] 개요 탭\n- [ ] 요구사항 탭\n- [ ] 문서 탭 알림\n';
const PRD = '# 설치 안내\n\n## 1. 목적\n\n한 줄로 설치한다.\n\n## 2. 첫 실행\n\n### 2.1 로그인\n\n기기 키로.\n\n## 3. 제거\n\n깨끗이.\n';

async function main() {
  if (port !== 18280 && port !== 18281) throw new Error('port 18280 or 18281');
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
  const old = () => new Date(Date.now() - 60_000); // older than the 5 s "being written" window
  const write = (rel: string, text: string) => {
    repo.write(rel, text);
    fs.utimesSync(path.join(repo.folder, rel), old(), old());
  };
  write('docs/requirements/SRS.md', SRS);
  write('docs/design/cockpit.md', DESIGN);
  write('docs/plan/TODO.md', PLAN);
  write('docs/product/PRD.md', PRD);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs: SRS, design, plan, PRD']);
  const before = hashTree(repo.folder);

  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  put('projects.json', {
    v: 2,
    projects: [{ projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: repo.folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }],
  });
  put('assignments.json', {
    v: 1,
    assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true }],
  });
  const start = () =>
    startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal']);
  let daemon: Daemon = start();
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}, repo ${repo.folder}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL'); // our own daemon only
  }, DEADLINE_MS);
  try {
    browser = await launchBrowser();
    const open = async (opts: BrowserContextOptions) => {
      const ctx = await browser!.newContext(opts);
      if (fs.existsSync(FONT)) await ctx.route('**/__sp/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
      return { ctx, page: await ctx.newPage() };
    };
    const hangul = (p: Page) => p.addStyleTag({ content: FONT_CSS });
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
    const api = async (p: Page, route: string) => {
      const r = await p.request.get(`http://127.0.0.1:${port}/api/cld/spec/alpha/${route}`);
      if (!r.ok()) throw new Error(`${route}: ${r.status()} ${await r.text()}`);
      return r.json();
    };
    const items = async (p: Page, q = '') => (await api(p, `items${q}`)).items as Item[];
    const login = async () => {
      const { ctx, page } = await open({ viewport: { width: 1400, height: 900 } });
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      await hangul(page);
      await openOfficeWindow(page);
      const win = page.locator(DEV_WINDOW);
      await win.getByRole('button', { name: '개발', exact: true }).click();
      const picker = win.getByRole('combobox', { name: '개발 프로젝트' });
      await eventually('alpha in the picker', async () => (await picker.locator('option[value="alpha"]').count()) > 0);
      await picker.selectOption('alpha');
      return { ctx, page, win, tab: (name: string) => win.getByRole('button', { name, exact: true }) };
    };

    // ── 1. Enable ──
    let { ctx: desk, page, win, tab } = await login();
    const names = await win.getByRole('navigation', { name: '개발 메뉴' }).getByRole('button').allTextContents();
    check(names.join(' ') === '개요 이슈 요구사항 그래프 문서 에이전트 변경', `1: 요구사항 comes after 이슈 (${names.join(' ')})`);
    await tab('개요').click();
    await win.getByTestId('spec-turn-on').click();
    const wizard = page.getByTestId('spec-wizard');
    await eventually('candidates', async () => (await wizard.getByTestId('spec-candidate').count()) === 4);
    await wizard.getByTestId('spec-wizard-confirm').click();
    await eventually('enabled', async () => (await wizard.getByTestId('spec-wizard-done').count()) > 0);
    await wizard.getByRole('button', { name: '닫기' }).click();
    let card = win.getByTestId('spec-card');
    await eventually('the card counts items', async () => (await card.getByTestId('spec-card-items').count()) > 0);
    const cardText = await card.getByTestId('spec-card-items').textContent();
    check(cardText?.includes('항목 8개'), `1: the 개요 card counts the items by kind (${cardText})`);
    await shot(page, '01-cockpit-items');

    // ── 2. 요구사항 ──
    await tab('요구사항').click();
    let reqs = win.getByTestId('spec-reqs');
    const shownIds = () => reqs.getByTestId('spec-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-id') ?? ''));
    await eventually('the requirement rows', async () => (await shownIds()).length === 3);
    check((await shownIds()).join(' ') === 'FR-OFC-001 FR-OFC-002 NFR-PERF-008', `2: 요구사항 lists the IDs (${(await shownIds()).join(' ')})`);
    const firstRow = await reqs.getByTestId('spec-item').first().textContent();
    check(firstRow?.includes('오케스트레이터 탭마다 방이 있다') && firstRow.includes('docs/requirements/SRS.md · 7행'), `2: a row shows its title, document and line (${firstRow})`);
    await shot(page, '02-reqs');
    await reqs.getByTestId('spec-reqs-kind').selectOption('');
    await eventually('every kind', async () => (await shownIds()).length === 8);
    const all = await shownIds();
    check(all.includes('D-001') && all.includes('D-002') && all.filter((x) => x === '').length === 3, `2: every kind adds the design's ID headings and the plan's three checkboxes`);
    await reqs.getByTestId('spec-reqs-search').fill('비용');
    const hit = await eventually('search', async () => (await shownIds()).join() === 'NFR-PERF-008' && 'NFR-PERF-008');
    check(hit, '2: the search finds by words');
    await reqs.getByTestId('spec-reqs-search').fill('');
    await eventually('every kind again', async () => (await shownIds()).length === 8);
    await shot(page, '02b-reqs-all-kinds');

    // ── 3. The PRD: nothing until 제목도 항목 ──
    const docsList = (await api(page, 'docs')).docs as Doc[];
    const prd = docsList.find((d) => d.path === 'docs/product/PRD.md')!;
    check((await items(page, `?doc=${prd.uid}`)).length === 0, '3: the ID-less PRD shows no item in the auto mode');
    await tab('문서').click();
    const prdRow = win.locator('[data-testid="spec-doc"][data-path="docs/product/PRD.md"]');
    await prdRow.getByTestId('spec-doc-mode').selectOption({ label: '제목도 항목' });
    await eventually('the PRD headings', async () => (await prdRow.getAttribute('data-items')) === '3');
    const prdTitles = (await items(page, `?doc=${prd.uid}`)).map((i) => i.title);
    check(prdTitles.join(' | ') === '1. 목적 | 2. 첫 실행 | 3. 제거', `3: its ## headings appear, its ### does not (${prdTitles.join(' | ')})`);
    check((await prdRow.getByTestId('spec-doc-depth').inputValue()) === '2', '3: the depth switch shows 2');
    await shot(page, '03-docs-prd-headings');
    await tab('요구사항').click();
    await reqs.getByTestId('spec-reqs-doc').selectOption(prd.uid);
    await eventually('PRD rows', async () => (await reqs.getByTestId('spec-item').count()) === 3);
    const noId = await reqs.getByTestId('spec-item').first().getByTestId('spec-item-id').textContent();
    check(noId === 'PRD.md · 설치 안내', `3: an item with no display ID shows 문서 · 절 (${noId})`);
    await shot(page, '03b-reqs-prd');
    const mid = hashTree(repo.folder);
    const changed3 = diff(before, mid);
    check(changed3.length === 0 && '.git/config' in mid && '.git/index' in mid, `3: no repository byte changed, .git included (${changed3.join(', ') || 'none'})`);

    // ── 4. Edit a row keeping its ID, commit, restart ──
    const uidBefore = (await items(page, '?q=FR-OFC-002')).find((i) => i.displayId === 'FR-OFC-002')!.uid;
    write('docs/requirements/SRS.md', SRS.replace('방 이름을 바꿀 수 있다', '방 이름과 색을 바꿀 수 있다'));
    repo.git(['commit', '-q', '-am', 'SRS: FR-OFC-002 색도']);
    const committed = hashTree(repo.folder);
    await desk.close();
    await daemon.stop();
    killFakeSessions(home);
    daemon = start();
    ({ ctx: desk, page, win, tab } = await login());
    reqs = win.getByTestId('spec-reqs'); // the new page's
    card = win.getByTestId('spec-card');
    const after = (await items(page, '?q=FR-OFC-002')).find((i) => i.displayId === 'FR-OFC-002')!;
    check(after.uid === uidBefore && after.title === '방 이름과 색을 바꿀 수 있다', `4: the edited row keeps its UID after a commit and a restart (${after.uid})`);
    await tab('요구사항').click();
    // 요구사항 by default: the SRS's three rows and, its mode kept across the restart, the PRD's three headings.
    await eventually('rows after restart', async () => (await shownIds()).length === 6);
    await shot(page, '04-reqs-after-edit-restart');
    const changed4 = diff(committed, hashTree(repo.folder));
    check(changed4.length === 0, `4: no repository byte changed but our own commit (${changed4.join(', ') || 'none'})`);

    // ── 5. A duplicate display ID ──
    write('docs/design/cockpit.md', `${DESIGN}\n## FR-OFC-001 같은 ID를 설계에도 씀\n`);
    await wait(SPEC_SCAN_MIN_MS + 500);
    await tab('문서').click();
    // SPT-P1C: duplicate IDs are one alert per set of documents (count, IDs, places).
    const alert = win.locator('[data-testid="spec-alert"][data-type="duplicateIds"]');
    await eventually('the duplicate alert', async () => (await alert.count()) === 1);
    const alertText = await alert.textContent();
    check(
      (await alert.getAttribute('data-count')) === '1' && alertText?.includes('FR-OFC-001') && alertText.includes('docs/requirements/SRS.md') && alertText.includes('docs/design/cockpit.md'),
      `5: the alert names the ID and both places`,
    );
    const dupes = await items(page, '?q=FR-OFC-001');
    check(dupes.length === 2 && dupes[0].uid !== dupes[1].uid, '5: two UIDs for the ID defined twice');
    await shot(page, '05-docs-duplicate-alert');

    // ── 6. A new file in the tracked folder ──
    write('docs/requirements/NFR.md', '# NFR\n\n| ID | 요구 |\n|---|---|\n| NFR-SEC-001 | 비밀은 가린다 |\n');
    await wait(SPEC_SCAN_MIN_MS + 500);
    const nfrDoc = await eventually(
      'the new document (API)',
      async () => ((await api(page, 'docs')).docs as Doc[]).find((d) => d.path === 'docs/requirements/NFR.md'),
      SPEC_SCAN_MIN_MS * 3,
    );
    check(nfrDoc.fresh === true, '6: the API tracks it by itself, flagged fresh');
    await tab('개요').click(); // the 문서 tab asks again when it is shown
    await tab('문서').click();
    const nfr = win.locator('[data-testid="spec-doc"][data-path="docs/requirements/NFR.md"]');
    await eventually('the new document', async () => (await nfr.count()) === 1);
    check((await nfr.getByTestId('spec-doc-new').textContent()) === '새 문서', '6: the new file is tracked and tagged 새 문서');
    check((await win.locator('[data-testid="spec-alert"][data-type="newDoc"]').count()) === 1, '6: 확인할 것 lists it');
    await eventually('its item', async () => (await items(page, '?q=NFR-SEC')).length === 1);
    await shot(page, '06-docs-new-document');
    await tab('개요').click();
    const alerts = await eventually('the alert count', async () => card.getByTestId('spec-card-alerts').getAttribute('data-count'));
    check(alerts === '2', `6: the 개요 card counts the two alerts (${alerts})`);
    await shot(page, '06b-cockpit-alerts');
    const phoneState = await desk.storageState();
    await desk.close();

    // ── 7. Phone ──
    const { page: phone } = await open({ ...PHONE, storageState: phoneState });
    await phone.goto(`http://127.0.0.1:${port}/`);
    await hangul(phone);
    await phone.locator('[data-dock="board"]').tap();
    const pw = phone.locator('[aria-label="현황판 화면"]');
    const dev = pw.getByRole('button', { name: '개발', exact: true });
    if ((await dev.count()) && (await dev.getAttribute('aria-pressed')) !== 'true') await dev.tap();
    const nav = pw.getByRole('navigation', { name: '개발 메뉴' });
    await nav.getByRole('button', { name: '요구사항', exact: true }).tap();
    await eventually('phone rows', async () => (await pw.getByTestId('spec-item').count()) >= 3);
    const phoneTabs = await nav.getByRole('button').allTextContents();
    check(phoneTabs.join(' ') === '개요 이슈 요구사항 그래프 문서 더보기', `7: phone tabs (${phoneTabs.join(' ')})`);
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '7: no horizontal page scroll on 요구사항 at 390 px');
    await shot(phone, '07-phone-reqs');
    await nav.getByRole('button', { name: '문서', exact: true }).tap();
    await eventually('phone docs', async () => (await pw.getByTestId('spec-doc').count()) === 5);
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '7: no horizontal page scroll on 문서 at 390 px');
    await shot(phone, '08-phone-docs');
    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    // What the daemon said about spec tracking (its output is otherwise kept to itself).
    console.error(daemon.log.join('').split('\n').filter((l) => /spec/i.test(l)).slice(-20).join('\n'));
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
