/**
 * SPT-P4B, end to end on the REAL API (no page.route fixtures but the font): dist/cli.js in a temp
 * HOME (the engine fake as `claude`, no real agent). Project `alpha`'s folder is a temp git
 * repository holding a design document (a flowchart and a component table) and the folders
 * `server/`, `webview-ui/`, `core/`, `docs/`. Project `beta` tracks a document without diagrams.
 * Desktop 1600x1000, then phone 390x844:
 *  1. approve the flowchart: the count line says 승인한 구조
 *  2. the diagram edited in the temp repo: 재검토 필요; approved again
 *  3. a node's kind set to store: the node's style changes
 *  4. a component and a relation added by hand
 *  5. two components of different diagrams merged as the same one
 *  6. proposals: approve `server/`, rename `webview-ui/`, remove `docs/` (makeTempRepo adds its own `sub/`)
 *  7. a project with no diagrams: the empty state's [추가] works
 *  8. phone: the detail and the dialog full screen, a proposal approved, no horizontal scroll
 * Screenshots in agent-tycoon/artifacts/spec-p4b/.
 *
 *   npx tsx agent-tycoon/test/run-spec-p4b-arch-owner.ts [port 18302|18303]
 */
import type { BrowserContextOptions, Locator, Page } from '@playwright/test';
import { type Browser, devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import type { TraceArch } from '../../core/src/agent-tycoon/spec/trace.js';
import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { makeTempRepo } from '../../server/src/agent-tycoon/engine/git/testRepo.js';
import { assertPortFree, type Daemon, DEV_WINDOW, killFakeSessions, launchBrowser, makeEngineHome, openOfficeWindow, REPO_ROOT, startDaemon } from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]) || 18302;
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/spec-p4b');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__sp/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 420_000;
const PHONE: BrowserContextOptions = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } };
})();
const M = (body: string) => '```mermaid\n' + body + '\n```\n';
const FLOW = ['flowchart LR', '  user((Owner)) --> web["Web app"]', '  web --> api["API server"]', '  api --> auth["Auth"]', '  api --> db[(Main DB)]'].join('\n');
const DESIGN = ['# 시스템 설계', '', '## 구성', '', M(FLOW), '## 구성요소 표', '', '| 구성요소 | 설명 |', '|---|---|', '| Auth service | 로그인 |', '| Scheduler | 작업을 돌린다 |', ''].join('\n');

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
  if (![18302, 18303, 18308, 18309].includes(port)) throw new Error('port 18302, 18303, 18308 or 18309');
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  const put = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(cfg, rel)), { recursive: true });
    fs.writeFileSync(path.join(cfg, rel), JSON.stringify(data));
  };
  const old = () => new Date(Date.now() - 60_000); // settled: the scan reads it now
  const repo = makeTempRepo({ push: false });
  const design = path.join(repo.folder, 'docs/design/system.md');
  repo.write('docs/design/system.md', DESIGN);
  fs.utimesSync(design, old(), old());
  for (const f of ['server/index.ts', 'server/src/main.ts', 'server/src/routes.ts', 'webview-ui/src/App.tsx', 'webview-ui/index.html', 'core/index.ts']) repo.write(f, 'export {};\n');
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'init']);
  const plain = makeTempRepo({ push: false });
  plain.write('docs/design/notes.md', '# 메모\n\n그림 없는 설계 메모.\n');
  fs.utimesSync(path.join(plain.folder, 'docs/design/notes.md'), old(), old());
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
    const arch = async (project = 'alpha', from: Page = page) => (await (await from.request.get(`http://127.0.0.1:${port}/api/agty/spec/${project}/arch`)).json()) as TraceArch;
    check((await enable('alpha', ['docs/design/system.md'])) === 200, 'alpha: spec tracking on with the design document');
    check((await enable('beta', ['docs/design/notes.md'])) === 200, 'beta: spec tracking on with a document without diagrams');
    const a0 = await arch();
    const uid = (a: TraceArch, label: string) => a.nodes.find((n) => n.label === label)?.id ?? '';
    check(a0.diagrams.map((d) => `${d.type}:${d.standing}`).join(',') === 'flowchart:doc,table:doc' && a0.counts.fromDocs === 7, `the API: a flowchart and a table read from documents, 7 components (${JSON.stringify(a0.counts)})`);

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
    };
    await tab('지도').click();
    await toArch(win, (l) => l.click());
    const g = win.getByTestId('arch-graph');
    const counts = () => g.getByTestId('arch-counts').textContent();
    const node = (label: string) => g.locator('[data-testid="arch-node"]', { hasText: label });
    const pop = g.getByTestId('arch-node-pop');
    const dialog = page.getByTestId('arch-dialog');
    const flowRow = g.locator('[data-testid="arch-diagram"]', { hasText: '순서도' });
    await eventually('nodes drawn', async () => (await g.getByTestId('arch-node').count()) === 7);

    // ── 1. approve the diagram ──
    check((await flowRow.getAttribute('data-standing')) === 'doc' && ((await flowRow.textContent()) ?? '').includes('문서에서 읽음'), '1: the flowchart reads 문서에서 읽음 with [이 구조 승인]');
    await flowRow.getByTestId('arch-approve').click();
    await eventually('approved', async () => (await flowRow.getAttribute('data-standing')) === 'approved');
    const c1 = await eventually('counts', async () => ((await counts()) ?? '').startsWith('승인한 구조 5') && counts());
    check(c1 === '승인한 구조 5 · 제안 8 · 문서에서 읽음 2', `1: the count line (${c1})`);
    check((await node('API server').getAttribute('data-standing')) === 'approved' && (await flowRow.getByTestId('arch-approve').count()) === 0, '1: its nodes are approved, the button gone');
    await shot(page, '01-approved');

    // ── 2. the diagram edited: 재검토 필요, approved again ──
    fs.writeFileSync(design, DESIGN.replace('Web app', 'Web client'));
    fs.utimesSync(design, old(), old());
    await eventually('the edit scanned', async () => (await arch()).diagrams[0]?.standing === 'review', 60_000);
    await eventually('the page shows 재검토 필요', async () => (await flowRow.getAttribute('data-standing')) === 'review');
    check(((await flowRow.getByTestId('arch-diagram-standing').textContent()) ?? '') === '재검토 필요' && (await node('API server').getAttribute('data-standing')) === 'review', '2: the edited diagram and its nodes read 재검토 필요');
    check(((await counts()) ?? '').startsWith('승인한 구조 0'), `2: nothing counts as approved now (${await counts()})`);
    await shot(page, '02-review');
    await flowRow.getByTestId('arch-approve').click();
    await eventually('approved again', async () => (await flowRow.getAttribute('data-standing')) === 'approved');
    check(((await counts()) ?? '').startsWith('승인한 구조 5') && (await node('Web client').count()) === 1, '2: approved again (the new label drawn)');

    // ── 3. a kind changed to store ──
    const before = await node('API server').evaluate((e) => getComputedStyle(e).clipPath);
    await node('API server').click();
    await eventually('the pop', async () => (await pop.getAttribute('data-id')) === uid(await arch(), 'API server'));
    await pop.getByTestId('arch-kind').selectOption('store');
    await eventually('store', async () => (await node('API server').getAttribute('data-kind')) === 'store');
    const after = await node('API server').evaluate((e) => getComputedStyle(e).clipPath);
    check((await node('API server').getAttribute('class'))?.includes('ag-n--store') && before !== after && after.startsWith('polygon'), `3: API server is a store, drawn as one (clip-path ${before} → ${after.slice(0, 20)}…)`);
    check(((await pop.getByTestId('arch-pop-standing').textContent()) ?? '').startsWith('저장소 · 승인함'), '3: the detail reads 저장소 · 승인함');
    await shot(page, '03-kind-store');
    await pop.getByRole('button', { name: '닫기' }).click();

    // ── 4. a component and a relation by hand ──
    await g.getByTestId('arch-add-comp').click();
    await eventually('dialog', async () => (await dialog.getAttribute('data-kind')) === 'comp');
    await dialog.getByTestId('arch-dialog-label').fill('Payments');
    await dialog.getByTestId('arch-dialog-kind').selectOption('external');
    await dialog.getByTestId('arch-dialog-note').fill('외부 결제 대행');
    await dialog.getByTestId('arch-dialog-ok').click();
    await eventually('Payments', async () => (await node('Payments').count()) === 1);
    check((await node('Payments').getAttribute('data-kind')) === 'external' && (await node('Payments').getAttribute('data-standing')) === 'approved', '4: Payments added by hand: external, approved');
    const a4 = await arch();
    await g.getByTestId('arch-add-rel').click();
    await eventually('rel dialog', async () => (await dialog.getAttribute('data-kind')) === 'rel');
    await dialog.getByTestId('arch-dialog-from').selectOption(uid(a4, 'API server'));
    await dialog.getByTestId('arch-dialog-to').selectOption(uid(a4, 'Payments'));
    await dialog.getByTestId('arch-dialog-label').fill('결제 요청');
    await dialog.getByTestId('arch-dialog-ok').click();
    await eventually('the relation drawn', async () => (await g.locator('.react-flow__edge-text', { hasText: '결제 요청' }).count()) === 1);
    const rel = (await arch()).edges.find((e) => e.owner);
    check(rel?.from === uid(a4, 'API server') && rel.to === uid(a4, 'Payments'), '4: API server → Payments, a relation by hand, drawn with its label');
    await shot(page, '04-by-hand');

    // ── 5. the same component in two diagrams ──
    await node('Auth service').click();
    await eventually('the pop', async () => (await pop.getAttribute('data-id')) === uid(a4, 'Auth service'));
    await pop.getByTestId('arch-same').click();
    await eventually('alias dialog', async () => (await dialog.getAttribute('data-kind')) === 'alias');
    await dialog.getByTestId('arch-dialog-from').selectOption(uid(a4, 'Auth'));
    await dialog.getByTestId('arch-dialog-ok').click();
    await eventually('merged', async () => (await node('Auth service').count()) === 0);
    await node('Auth').first().click();
    await eventually('Auth pop', async () => (await pop.getByTestId('arch-merged').count()) === 1);
    check(((await pop.getByTestId('arch-merged').textContent()) ?? '').startsWith('Auth service') && (await pop.getByTestId('arch-source').count()) === 2, '5: Auth shows Auth service merged into it, with both sources');
    await shot(page, '05-merged');

    // ── 6. proposals ──
    await g.getByTestId('arch-proposals-toggle').click();
    const rows = g.getByTestId('arch-proposal');
    await eventually('proposals', async () => (await rows.count()) === 8);
    const paths = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-path')));
    check(paths.join(',') === 'core/,docs/,docs/design/,server/,server/src/,sub/,webview-ui/,webview-ui/src/', `6: the top folders and one level below (${paths.join(' ')})`);
    check(((await rows.filter({ hasText: 'server/' }).first().textContent()) ?? '').includes('파일 3개') && (await g.locator('[data-testid="arch-node"][data-standing="proposed"]').count()) === 8, '6: with file counts, drawn dimmed');
    const dim = await g.locator('[data-testid="arch-node"][data-standing="proposed"]').first().evaluate((e) => getComputedStyle(e).opacity);
    check(Number(dim) < 1, `6: a proposal is dimmed (opacity ${dim})`);
    await shot(page, '06-proposals');
    const row = (p: string) => g.locator(`[data-testid="arch-proposal"][data-path="${p}"]`);
    await row('server/').getByTestId('arch-sk-approve').click();
    await eventually('server/ approved', async () => (await row('server/').count()) === 0);
    await row('webview-ui/').getByTestId('arch-sk-rename').click();
    await eventually('rename dialog', async () => (await dialog.getAttribute('data-kind')) === 'rename');
    await dialog.getByTestId('arch-dialog-label').fill('Web UI');
    await dialog.getByTestId('arch-dialog-ok').click();
    await eventually('webview-ui/ renamed', async () => (await node('Web UI').count()) === 1);
    await row('docs/').getByTestId('arch-sk-remove').click();
    await eventually('docs/ removed', async () => (await row('docs/').count()) === 0 && (await row('docs/design/').count()) === 0);
    const a6 = await arch();
    const server = a6.nodes.find((n) => n.folder === 'server/' && n.standing === 'approved');
    check(server?.id.startsWith('c_') && server.label === 'server/' && a6.nodes.find((n) => n.label === 'Web UI')?.folder === 'webview-ui/', '6: server/ is a component with a c_ UID, webview-ui/ approved as Web UI');
    const c6 = (await counts()) ?? '';
    check(c6 === '승인한 구조 8 · 제안 4 · 문서에서 읽음 1', `6: docs/ and below gone from the proposals; the count line (${c6})`);
    const serverNode = g.locator(`[data-testid="arch-node"][data-id="${server!.id}"]`);
    check((await serverNode.getAttribute('data-standing')) === 'approved' && (await serverNode.getAttribute('data-kind')) === 'component', '6: server/ drawn as a normal component node');
    await shot(page, '07-proposals-decided');
    const archJson = path.join(cfg, 'spec/p_aaaaaaaaaa/arch.json');
    check((fs.statSync(archJson).mode & 0o777) === 0o600 && !fs.readFileSync(archJson, 'utf-8').includes('export {}'), '6: arch.json is 0600 and holds no file contents');
    check(repo.git(['status', '--porcelain']).trim() === 'M docs/design/system.md', '6: the repository has only the test\'s own edit (nothing written by the daemon)');

    // ── 7. a project with no diagrams ──
    await picker.selectOption('beta');
    await tab('지도').click();
    await toArch(win, (l) => l.click());
    const empty = win.getByTestId('arch-empty');
    await eventually('empty state', async () => (await empty.count()) === 1);
    check((await empty.textContent()) === '아키텍처 정보 없음 · 설계 문서에 Mermaid 순서도를 넣거나 여기서 구성요소를 추가하세요', '7: beta shows the empty state');
    await win.getByTestId('arch-empty-add').click();
    await eventually('the add dialog', async () => (await dialog.getAttribute('data-kind')) === 'comp');
    await dialog.getByTestId('arch-dialog-label').fill('Gateway');
    await shot(page, '08-empty-add');
    await dialog.getByTestId('arch-dialog-ok').click();
    await eventually('Gateway', async () => (await win.getByTestId('arch-graph').locator('[data-testid="arch-node"]', { hasText: 'Gateway' }).count()) === 1);
    check(((await win.getByTestId('arch-counts').textContent()) ?? '').startsWith('승인한 구조 1') && (await empty.count()) === 0, '7: [추가] adds Gateway; the empty state is gone');
    await shot(page, '09-empty-added');
    const state = await ctx.storageState();
    await ctx.close();

    // ── 8. phone ──
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
    await eventually('phone nodes', async () => (await pg.getByTestId('arch-node').count()) === 9);
    await wait(400); // fitView
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '8: no horizontal page scroll at 390 px');
    await shot(phone, '10-phone-arch');
    await pg.getByTestId('arch-item').filter({ hasText: 'Payments' }).tap();
    const ppop = phone.getByTestId('arch-node-pop');
    await eventually('phone detail', async () => (await ppop.count()) === 1);
    const pb = await ppop.boundingBox();
    check(pb && pb.x <= 1 && pb.width >= 388 && pb.height >= 800, `8: the detail takes the full screen (${pb?.width}x${pb?.height})`);
    check(((await ppop.textContent()) ?? '').includes('외부 결제 대행') && (await ppop.getByTestId('arch-delete').count()) === 1 && (await ppop.getByTestId('arch-kind').count()) === 1, '8: the same actions there (kind, 같은 구성요소, 지우기) and the note');
    await shot(phone, '11-phone-detail');
    await ppop.getByRole('button', { name: '닫기' }).tap();
    await pg.getByTestId('arch-add-comp').tap();
    const pdialog = phone.getByTestId('arch-dialog');
    await eventually('phone dialog', async () => (await pdialog.count()) === 1);
    const db = await phone.locator('[role="dialog"]').boundingBox();
    check(db && db.width >= 360 && db.height >= 780, `8: [구성요소 추가] takes the full screen (${db?.width}x${db?.height})`);
    await shot(phone, '12-phone-dialog');
    await pdialog.getByRole('button', { name: '취소' }).tap();
    await pg.getByTestId('arch-proposals-toggle').tap();
    const prow = pg.locator('[data-testid="arch-proposal"][data-path="core/"]');
    await eventually('phone proposals', async () => (await prow.count()) === 1);
    await prow.getByTestId('arch-sk-approve').tap();
    await eventually('core/ approved on the phone', async () => (await prow.count()) === 0);
    check((await arch('alpha', phone)).nodes.some((n) => n.folder === 'core/' && n.standing === 'approved'), '8: [승인] on the phone approves core/');
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '8: still no horizontal scroll with the proposals open');
    await pg.getByTestId('arch-proposals').scrollIntoViewIfNeeded();
    await shot(phone, '13-phone-proposals');
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
