/**
 * The 지도's 아키텍처 그래프 (ArchCards.tsx) end to end: dist/cli.js in a temp HOME, project `alpha`
 * = THIS repository's folder with spec tracking on (the sidecar lives in the temp HOME; the
 * repository is only read). No server change: the cards read the same `GET …/map` as 모듈 지도.
 *  1. desktop 1600x1000, the 개발 window maximized: the 지도 tab opens on 아키텍처 그래프, one card per
 *     cell, the lines with many imports drawn
 *  2. a card picked: its detail (counts, recent changes, requirement areas, relations), its lines lit
 *  3. [단계별 들어가기]: 모듈 지도 one level inside it
 *  4. phone 390x844: the graph, a card tapped opens the sheet, no horizontal scroll
 *  5. the window mocks (v3-2, v3-5) and ours side by side
 * Screenshots in agent-tycoon/artifacts/feat-devroom-architecture-cards/.
 *
 *   npx tsx agent-tycoon/test/run-devroom-arch-cards.ts [port 18720..18729]
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import { type Browser, devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import type { TraceMap } from '../../core/src/agent-tycoon/spec/trace.js';
import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { assertPortFree, type Daemon, DEV_WINDOW, killFakeSessions, launchBrowser, makeEngineHome, openOfficeWindow, REPO_ROOT, startDaemon } from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]) || 18720;
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/feat-devroom-architecture-cards');
const MOCKS = path.resolve(REPO_ROOT, '../docs-ui-window-layout-mockup/mock/windows-v3');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__sp/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 300_000;
const ENGINE = 'server/src/agent-tycoon/engine';
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

async function main() {
  if (!(port >= 18720 && port <= 18729)) throw new Error('port 18720..18729');
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  const put = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(cfg, rel)), { recursive: true });
    fs.writeFileSync(path.join(cfg, rel), JSON.stringify(data));
  };
  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  put('projects.json', { v: 2, projects: [{ projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: REPO_ROOT, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }] });
  put('assignments.json', { v: 1, assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: false }] });
  const daemon: Daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-actions', '--no-terminal']);
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}, alpha = ${REPO_ROOT}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL'); // our own daemon only
  }, DEADLINE_MS);
  try {
    await daemon.loginUrl();
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
    const api = async <T>(route: string): Promise<T> => {
      const r = await page.request.get(`http://127.0.0.1:${port}/api/agty/spec/alpha/${route}`);
      if (!r.ok()) throw new Error(`${route}: ${r.status()} ${await r.text()}`);
      return (await r.json()) as T;
    };
    const cand = await api<{ docs: Array<{ path: string; preselect: boolean }> }>('candidates');
    const docs = [...new Set([...cand.docs.filter((d) => d.preselect).map((d) => d.path), 'agent-tycoon/docs/requirements/SRS.md'])];
    const enabled = await page.evaluate(async (b) => (await fetch('/api/agty/spec/alpha/enable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).status, { docs });
    check(enabled === 200, `spec tracking on for alpha with ${docs.length} documents`);
    const m = await eventually('the structure', async () => {
      const x = await api<TraceMap>('map');
      return x.structure && x.features.length ? x : null;
    });
    const s = m.structure!;
    const cells = s.blocks.filter((b) => b.kind !== 'rail');
    console.log(`scan: ${s.files} files, ${s.imports} imports, ${s.ms} ms, peak RSS ${s.rssKb} kB; cells ${cells.map((b) => b.name).join(', ')}`);

    // ── 1. desktop ──
    await openOfficeWindow(page);
    const win = page.locator(DEV_WINDOW);
    await win.getByRole('button', { name: '프로젝트', exact: true }).click();
    const picker = win.getByRole('combobox', { name: '개발 프로젝트' });
    await eventually('alpha in the picker', async () => (await picker.locator('option[value="alpha"]').count()) > 0);
    await picker.selectOption('alpha');
    await win.getByTestId('hud-title-office').dblclick(); // maximized
    await win.getByRole('navigation', { name: '개발 메뉴' }).getByRole('button', { name: '지도', exact: true }).click();
    const flow = win.getByTestId('arch-cards-flow');
    await eventually('the cards', async () => (await win.getByTestId('arch-card').count()) === cells.length);
    check((await win.locator('[data-testid="map-sub"][data-sub="arch"]').getAttribute('aria-selected')) === 'true', '1: 지도 opens on 아키텍처 그래프');
    const lines = Number(await flow.getAttribute('data-lines'));
    const bold = s.pairs.filter((p) => Math.max(p.ab, p.ba) >= 50).length;
    check(lines === bold && (await win.locator('.react-flow__edge').count()) === bold, `1: ${cells.length} cards, ${lines} lines (the pairs with 50+ imports)`);
    await wait(600);
    await shot(page, '01-desktop');

    // ── 2. a card picked ──
    const engineCell = s.blocks.find((b) => b.id === ENGINE);
    check(engineCell, '2: the engine folder is a cell');
    await win.locator(`[data-testid="arch-card"][data-id="${ENGINE}"]`).click();
    const detail = win.getByTestId('arch-card-detail');
    await eventually('the recent changes', async () => (await detail.getByTestId('arch-card-recent').count()) === 1);
    const partners = s.pairs.filter((p) => p.a === ENGINE || p.b === ENGINE).length;
    check((await detail.getByTestId('arch-card-partners').textContent())?.includes(String(partners)), `2: engine's detail: ${partners} relations, recent changes`);
    const on = await win.locator('.react-flow__edge.ac-e--on').count();
    check(on === partners, `2: engine's ${on} lines lit (every pair of the picked card)`);
    check((await win.getByTestId('arch-card-sum').textContent())?.includes(String(engineCell!.files)), '2: the summary line names its files');
    await wait(300);
    await shot(page, '02-desktop-engine');

    // ── 3. [단계별 들어가기] ──
    await detail.getByTestId('arch-card-into').click();
    await eventually('inside engine', async () => (await win.getByTestId('map-crumbs').getByRole('button').count()) === 2);
    check((await win.getByTestId('map-cell').count()) > 1, `3: 모듈 지도 inside engine: ${await win.getByTestId('map-cell').count()} cells`);
    await shot(page, '03-desktop-into-modules');

    // ── 4. phone ──
    const state = await ctx.storageState();
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
    await eventually('phone cards', async () => (await phone.getByTestId('arch-card').count()) === cells.length);
    const noScroll = () => phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    check(await noScroll(), '4: phone: the cards, no horizontal scroll at 390 px');
    await wait(600);
    await shot(phone, '04-phone');
    await phone.locator(`[data-testid="arch-card"][data-id="${ENGINE}"]`).tap();
    await eventually('the sheet', async () => (await phone.getByTestId('arch-card-sheet').getByTestId('arch-card-recent').count()) === 1);
    await phone.getByTestId('arch-card-sheet').scrollIntoViewIfNeeded();
    check(await noScroll(), '4: phone: a card tapped opens its sheet, no horizontal scroll');
    await shot(phone, '05-phone-sheet');
    await pctx.close();

    // ── 5. the mocks and ours ──
    const img = (f: string) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
    const pairs: Array<[string, string, string, number]> = [
      ['v3-2-devroom-architecture-max.png', '02-desktop-engine.png', '06-compare-desktop', 1000],
      ['v3-5-phone-devroom.png', '05-phone-sheet.png', '07-compare-phone', 390],
    ];
    for (const [mock, ours, name, w] of pairs) {
      if (!fs.existsSync(path.join(MOCKS, mock))) continue;
      const cmp = await ctx.newPage();
      await cmp.setViewportSize({ width: w * 2 + 40, height: 900 });
      await cmp.setContent(
        `<body style="margin:0;font:14px sans-serif;display:flex;gap:16px;padding:8px;background:#fff"><figure style="margin:0"><figcaption>mock ${mock}</figcaption><img src="${img(path.join(MOCKS, mock))}" width="${w}"></figure><figure style="margin:0"><figcaption>this run</figcaption><img src="${img(path.join(OUT, ours))}" width="${w}"></figure></body>`,
      );
      await cmp.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
      await cmp.close();
    }
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
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
