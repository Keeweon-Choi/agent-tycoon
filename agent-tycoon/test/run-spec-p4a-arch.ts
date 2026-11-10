/**
 * SPT-P4A, end to end on the REAL API (no page.route fixtures but the font): dist/cli.js in a temp
 * HOME (the engine fake as `claude`, no real agent). Project `alpha`'s folder is a temp git
 * repository holding a design document (a flowchart with a nested subgraph and a cylinder, a
 * sequence diagram whose participants are the flowchart's labels, a component table with a 의존
 * column, an erDiagram, a flowchart with `A@{ shape: rect }`) and a copy of THIS repository's
 * agent-tycoon/docs/design/architecture.md. Project `beta` tracks a document without diagrams.
 * Desktop 1600x1000, then phone 390x844:
 *  1. the 그래프 tab's switch shows 아키텍처
 *  2. nodes and nested groups are drawn (a group folds and unfolds); the count line says 문서에서 읽음 K
 *  3. the interaction toggle shows the messages
 *  4. a node click shows its source, and [원본 열기] lands on that line
 *  5. the two unsupported entries show their first blocked line
 *  6. a project without diagrams shows the empty state
 *  7. phone: full width, the list under the graph, no horizontal scroll
 * Screenshots in agent-tycoon/artifacts/spec-p4a/.
 *
 *   npx tsx agent-tycoon/test/run-spec-p4a-arch.ts [port 18300|18301]
 */
import type { BrowserContextOptions, Locator, Page } from '@playwright/test';
import { type Browser, devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import type { TraceArch } from '../../core/src/agent-tycoon/spec/trace.js';
import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { makeTempRepo } from '../../server/src/agent-tycoon/engine/git/testRepo.js';
import { assertPortFree, type Daemon, DEV_WINDOW, killFakeSessions, launchBrowser, makeEngineHome, openOfficeWindow, REPO_ROOT, startDaemon } from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]) || 18300;
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/spec-p4a');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__sp/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 360_000;
const PHONE: BrowserContextOptions = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } };
})();
const M = (body: string) => '```mermaid\n' + body + '\n```\n';
const DESIGN = [
  '# 시스템 설계',
  '',
  '## 구성',
  '',
  M(
    [
      'flowchart LR',
      '  subgraph svc["서비스"]',
      '    subgraph core["코어"]',
      '      api["API server"]',
      '      db[(Main DB)]',
      '    end',
      '    web["Web app"]',
      '  end',
      '  user((Owner)) --> web',
      '  web --> api',
      '  api -- 읽기·쓰기 --> db',
    ].join('\n'),
  ),
  '## 흐름',
  '',
  M(['sequenceDiagram', '  participant U as Owner', '  participant W as Web app', '  participant A as API server', '  U->>W: 화면 열기', '  W->>A: GET /items', '  A-->>W: 200 items'].join('\n')),
  '## 구성요소 표',
  '',
  '| 구성요소 | 설명 | 의존 |',
  '|---|---|---|',
  '| Scheduler | 작업을 돌린다 | Queue, Worker |',
  '| Queue | 작업을 쌓는다 | |',
  '| Worker | 작업 하나를 한다 | Queue |',
  '',
  '## 데이터',
  '',
  M('erDiagram\n  ITEM ||--o{ TAG : has'),
  '## 새 문법',
  '',
  M('flowchart TD\n  X --> Y\n  A@{ shape: rect }'),
].join('\n');
const lineOf = (needle: string) => DESIGN.split('\n').findIndex((l) => l.includes(needle)) + 1;

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

async function main() {
  if (port !== 18300 && port !== 18301) throw new Error('port 18300 or 18301');
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  const put = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(cfg, rel)), { recursive: true });
    fs.writeFileSync(path.join(cfg, rel), JSON.stringify(data));
  };
  const old = new Date(Date.now() - 60_000); // settled: the scan reads them now
  const repo = makeTempRepo({ push: false });
  repo.write('docs/design/system.md', DESIGN);
  repo.write('docs/design/architecture.md', fs.readFileSync(path.join(REPO_ROOT, 'agent-tycoon/docs/design/architecture.md'), 'utf-8'));
  for (const f of ['docs/design/system.md', 'docs/design/architecture.md']) fs.utimesSync(path.join(repo.folder, f), old, old);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs: design']);
  const plain = makeTempRepo({ push: false });
  plain.write('docs/design/notes.md', '# 메모\n\n그림 없는 설계 메모.\n');
  fs.utimesSync(path.join(plain.folder, 'docs/design/notes.md'), old, old);
  plain.git(['add', '-A']);
  plain.git(['commit', '-q', '-m', 'docs: notes']);
  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  put('projects.json', {
    v: 2,
    projects: [
      { projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: repo.folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' },
      { projectId: 'p_bbbbbbbbbb', name: 'beta', folder: plain.folder, room: '개발실', leadAssignmentId: 'a_bbbbbbbbbb' },
    ],
  });
  put('assignments.json', {
    v: 1,
    assignments: [
      { assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true },
      { assignmentId: 'a_bbbbbbbbbb', projectId: 'p_bbbbbbbbbb', role: 'lead', provider: 'claude', wantRunning: true },
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
    const font = async (c: typeof ctx) => {
      if (fs.existsSync(FONT)) await c.route('**/__sp/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
    };
    await font(ctx);
    const page = await ctx.newPage();
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
    const enable = (project: string, docs: string[]) =>
      page.evaluate(
        async ([pr, ds]) => (await fetch(`/api/agty/spec/${pr}/enable`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ docs: ds }) })).status,
        [project, docs] as const,
      );
    check((await enable('alpha', ['docs/design/system.md', 'docs/design/architecture.md'])) === 200, 'alpha: spec tracking on with the design document and architecture.md');
    check((await enable('beta', ['docs/design/notes.md'])) === 200, 'beta: spec tracking on with a document without diagrams');
    const t0 = Date.now();
    const r = await page.request.get(`http://127.0.0.1:${port}/api/agty/spec/alpha/arch`);
    const api = (await r.json()) as TraceArch;
    console.log(`[measure] first GET …/arch over the real API (scan included): ${Date.now() - t0} ms`);
    const K = api.counts.fromDocs;
    check(r.ok() && K === 18 && api.groups.length === 3, `the API reads ${K} components (4 + 3 table rows + architecture.md's 11) and 3 groups`);
    const t1 = Date.now();
    await page.request.get(`http://127.0.0.1:${port}/api/agty/spec/alpha/arch?layer=interaction`);
    console.log(`[measure] GET …/arch?layer=interaction, index held: ${Date.now() - t1} ms`);

    await openOfficeWindow(page);
    const win = page.locator(DEV_WINDOW);
    await win.getByRole('button', { name: '프로젝트', exact: true }).click();
    const picker = win.getByRole('combobox', { name: '개발 프로젝트' });
    await eventually('alpha in the picker', async () => (await picker.locator('option[value="alpha"]').count()) > 0);
    await picker.selectOption('alpha');
    await win.getByTestId('hud-title-office').dblclick(); // maximized
    const tab = (name: string) => win.getByRole('navigation', { name: '개발 메뉴' }).getByRole('button', { name, exact: true });
    const toArch = async (root: Locator, press: (l: Locator) => Promise<void>) => {
      const sw = root.getByTestId('spec-graph-switch');
      await eventually('the switch', async () => (await sw.count()) === 1);
      await press(sw.locator('[data-view="arch"]'));
      await eventually('the 아키텍처 view', async () => (await root.getByTestId('arch-graph').count()) === 1);
      return sw;
    };

    // ── 1. the switch ──
    await tab('지도').click();
    const sw = await toArch(win, (l) => l.click());
    const archBtn = sw.locator('[data-view="arch"]');
    check((await archBtn.textContent()) === '그림으로 보기' && (await archBtn.getAttribute('aria-pressed')) === 'true' && (await sw.locator('[data-view="cards"]').textContent()) === '카드로 보기', '1: MAP-A: the 지도 구조 view reads 카드로 보기 | 그림으로 보기 and shows the drawing');
    const g = win.getByTestId('arch-graph');

    // ── 2. nodes, nested groups, the count line ──
    await eventually('nodes drawn', async () => (await g.getByTestId('arch-node').count()) === K);
    const groups = g.getByTestId('arch-group');
    check((await groups.count()) === 3, `2: ${K} components and 3 groups drawn`);
    const counts = (await g.getByTestId('arch-counts').textContent()) ?? '';
    // 제안 = 4b's proposed folders from the repository's own tree: not this runner's subject.
    check(new RegExp(`^승인한 구조 0 · 제안 \\d+ · 문서에서 읽음 ${K}$`).test(counts), `2: the count line (${counts})`);
    const box = async (label: string) => g.locator('[data-testid="arch-group"]', { hasText: label }).boundingBox();
    const [outer, inner] = [await box('서비스'), await box('코어')];
    check(outer && inner && inner.x > outer.x && inner.y > outer.y && inner.x + inner.width < outer.x + outer.width && inner.y + inner.height < outer.y + outer.height, '2: 코어 is drawn inside 서비스 (a nested subgraph)');
    const db = g.locator('[data-testid="arch-node"]', { hasText: 'Main DB' });
    check((await db.getAttribute('data-kind')) === 'store', '2: the cylinder [( )] is a store');
    await shot(page, '01-desktop-arch');
    await g.locator('[data-testid="arch-group"]', { hasText: '코어' }).getByTestId('arch-group-fold').click();
    await eventually('folded', async () => (await g.getByTestId('arch-fold').count()) === 1);
    check((await g.getByTestId('arch-node').count()) === K - 2 && ((await g.getByTestId('arch-fold').textContent()) ?? '').includes('+2'), '2: 코어 folds into one node (+2)');
    await shot(page, '02-desktop-folded');
    await g.getByTestId('arch-fold').click();
    await eventually('unfolded', async () => (await g.getByTestId('arch-node').count()) === K);
    check(true, '2: and unfolds');

    // ── 3. the interaction layer ──
    check((await g.locator('.ag-e--interaction').count()) === 0, '3: the interaction layer is folded by default');
    await g.getByTestId('arch-interaction').click();
    await eventually('messages', async () => (await g.locator('.ag-e--interaction').count()) > 0);
    await wait(300);
    const texts = await g.locator('.react-flow__edge-text').allTextContents();
    check(texts.some((x) => x.includes('GET /items')) && texts.some((x) => x.includes('200 items')) && texts.some((x) => x.includes('화면 열기')), `3: the toggle shows the messages (${texts.filter((x) => /items|화면/.test(x)).join(' | ')})`);
    await shot(page, '03-desktop-interaction');

    // ── 5. the unsupported entries ──
    const bad = g.getByTestId('arch-unsupported-item');
    check((await bad.count()) === 2, '5: two unsupported entries');
    const er = bad.filter({ hasText: 'erDiagram' });
    const fl = bad.filter({ hasText: 'A@{' });
    check((await er.getAttribute('data-line')) === String(lineOf('erDiagram')) && (await er.getByTestId('arch-blocked').textContent()) === `${lineOf('erDiagram')}번째 줄: erDiagram`, `5: erDiagram, blocked at line ${lineOf('erDiagram')}`);
    check((await fl.getByTestId('arch-blocked').textContent()) === `${lineOf('A@{')}번째 줄: A@{ shape: rect }` && ((await fl.locator('pre').textContent()) ?? '').includes('X --> Y'), `5: the flowchart blocked at line ${lineOf('A@{')} (A@{ shape: rect }), its source shown`);
    await g.getByTestId('arch-unsupported').scrollIntoViewIfNeeded();
    await shot(page, '04-desktop-unsupported');

    // ── 6. a project without diagrams ──
    await picker.selectOption('beta');
    await tab('지도').click();
    await toArch(win, (l) => l.click());
    const empty = win.getByTestId('arch-empty');
    await eventually('empty state', async () => (await empty.count()) === 1);
    check((await empty.textContent()) === '아키텍처 정보 없음 · 설계 문서에 Mermaid 순서도를 넣거나 여기서 구성요소를 추가하세요' && ((await win.getByTestId('arch-counts').textContent()) ?? '').endsWith('문서에서 읽음 0'), '6: beta shows the empty state, the count line still there');
    await shot(page, '05-desktop-empty');

    // ── 4. a node's source, [원본 열기] at the line ──
    await picker.selectOption('alpha');
    await tab('지도').click();
    await toArch(win, (l) => l.click());
    const api2 = win.getByTestId('arch-graph').locator('[data-testid="arch-node"]', { hasText: 'API server' });
    await eventually('api node', async () => (await api2.count()) === 1);
    await api2.click();
    const pop = win.getByTestId('arch-node-pop');
    await eventually('the pop', async () => (await pop.count()) === 1);
    const srcs = await pop.getByTestId('arch-source').allTextContents();
    check(srcs[0]?.startsWith(`docs/design/system.md:${lineOf('api["API server"]')}`) && srcs[1]?.startsWith(`docs/design/system.md:${lineOf('participant A as')}`) && ((await pop.textContent()) ?? '').includes('구성요소 · 문서에서 읽음'), `4: the node shows its kind and where it is written (${srcs.join(' | ')})`);
    await shot(page, '06-desktop-node');
    await pop.getByTestId('arch-open-source').first().click();
    const marked = page.locator('[data-testid="file-lines"] [aria-current="true"]');
    await eventually('the file viewer at the line', async () => (await marked.count()) === 1);
    check((await marked.getAttribute('data-line')) === String(lineOf('api["API server"]')), `4: [원본 열기] lands on line ${lineOf('api["API server"]')}`);
    await shot(page, '07-desktop-open-source');
    const state = await ctx.storageState();
    await ctx.close();

    // ── 7. phone ──
    const pctx = await browser.newContext({ ...PHONE, storageState: { cookies: state.cookies, origins: state.origins.map((o) => ({ ...o, localStorage: o.localStorage.filter((x) => !x.name.includes('workbench')) })) } });
    await font(pctx);
    const phone = await pctx.newPage();
    await phone.goto(`http://127.0.0.1:${port}/`);
    await phone.addStyleTag({ content: FONT_CSS });
    await phone.locator('[data-dock="board"]').tap();
    const pw = phone.locator('[aria-label="현황판 화면"]');
    const dev = pw.getByRole('button', { name: '프로젝트', exact: true });
    if ((await dev.count()) && (await dev.getAttribute('aria-pressed')) !== 'true') await dev.tap();
    const ppicker = pw.getByRole('combobox', { name: '개발 프로젝트' });
    await eventually('alpha in the phone picker', async () => (await ppicker.locator('option[value="alpha"]').count()) > 0);
    await ppicker.selectOption('alpha');
    await pw.getByRole('navigation', { name: '개발 메뉴' }).getByRole('button', { name: '지도', exact: true }).tap();
    await toArch(pw, (l) => l.tap());
    const pg = pw.getByTestId('arch-graph');
    await eventually('phone nodes', async () => (await pg.getByTestId('arch-node').count()) === K);
    await wait(400); // fitView
    const graphBox = await pg.locator('.tg-root').boundingBox();
    const listBox = await pg.getByTestId('arch-list').boundingBox();
    const badBox = await pg.getByTestId('arch-unsupported').boundingBox();
    check(graphBox && listBox && badBox && graphBox.width >= 340 && listBox.y >= graphBox.y + graphBox.height && badBox.y >= listBox.y + listBox.height, `7: the graph takes the width (${graphBox?.width}px), the list and the unsupported entries under it`);
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '7: no horizontal page scroll at 390 px');
    await shot(phone, '08-phone-arch');
    await pg.getByTestId('arch-unsupported').scrollIntoViewIfNeeded();
    await shot(phone, '09-phone-unsupported');
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
    plain.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
