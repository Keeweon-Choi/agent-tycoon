/**
 * BRN K8 UI end to end: dist/cli.js in a temp HOME, project `alpha` = THIS repository's folder with
 * spec tracking on (the sidecar lives in the temp HOME; the repository is only read).
 *  1. desktop 1600x1000, 지도 > 아키텍처: 코드 (no design asked), 설계, 겹쳐 보기
 *  2. the number row: each number opened, an example opens its card
 *  3. phone 390x844: the switch, 겹쳐 보기 and the number row
 * Screenshots in cld/artifacts/feat-brain-design-map-ui/.
 *
 *   npx tsx cld/test/run-devroom-design-map.ts [port 18800..18809]
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import { type Browser, devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import type { TraceMap } from '../../core/src/cld/spec/trace.js';
import { configDirectory } from '../../server/src/cld/configPath.js';
import { assertPortFree, type Daemon, DEV_WINDOW, killFakeSessions, launchBrowser, makeEngineHome, openOfficeWindow, REPO_ROOT, startDaemon } from '../../server/src/cld/testHome.js';
import { outDir, themePort, UI_THEME_INIT } from './uiTheme.js';

const port = Number(process.argv[2]) || 18800;
const OUT = outDir(path.join(REPO_ROOT, 'cld/artifacts/feat-brain-design-map-ui'));
const DEADLINE_MS = 420_000;
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
  if (!((port >= 18800 && port <= 18809) || themePort(port))) throw new Error('port 18800..18729');
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
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
    if (UI_THEME_INIT) await ctx.addInitScript(UI_THEME_INIT);
    const page = await ctx.newPage();
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
    const api = async <T>(route: string): Promise<T> => {
      const r = await page.request.get(`http://127.0.0.1:${port}/api/cld/spec/alpha/${route}`);
      if (!r.ok()) throw new Error(`${route}: ${r.status()} ${await r.text()}`);
      return (await r.json()) as T;
    };
    const docs = ['CLAUDE.md', 'docs/reference/architecture.md', ...fs.readdirSync(path.join(REPO_ROOT, 'cld/docs/design')).filter((f) => f.endsWith('.md')).map((f) => `cld/docs/design/${f}`)];
    const enabled = await page.evaluate(async (b) => (await fetch('/api/cld/spec/alpha/enable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).status, { docs });
    check(enabled === 200, `spec tracking on for alpha with ${docs.length} documents`);
    const m = await eventually('the structure', async () => {
      const x = await api<TraceMap>('map');
      return x.structure ? x : null;
    }, 90_000);
    const s = m.structure!;
    const cells = s.blocks.filter((b) => b.kind !== 'rail');
    console.log(`scan: ${s.files} files, ${s.imports} imports, ${s.ms} ms, peak RSS ${s.rssKb} kB; cells ${cells.map((b) => b.name).join(', ')}`);

    // ── 1. desktop ──
    const requests: string[] = [];
    page.on('request', (r) => r.url().includes('/spec/alpha/map') && requests.push(r.url()));
    await openOfficeWindow(page);
    const win = page.locator(DEV_WINDOW);
    await win.getByRole('button', { name: '프로젝트', exact: true }).click();
    const picker = win.getByRole('combobox', { name: '개발 프로젝트' });
    await eventually('alpha in the picker', async () => (await picker.locator('option[value="alpha"]').count()) > 0);
    await picker.selectOption('alpha');
    await win.getByTestId('hud-title-office').dblclick(); // maximized
    await win.getByRole('navigation', { name: '개발 메뉴' }).getByRole('button', { name: '지도', exact: true }).click();
    await eventually('the code cards', async () => (await win.getByTestId('arch-card').count()) === cells.length);
    check((await win.getByTestId('dm-switch').getAttribute('data-view')) === 'code', '1: opens on 코드');
    check(requests.length > 0 && requests.every((u) => !u.includes('design=1')), '1: 코드 asks for no design');
    check((await win.getByTestId('dm-bar').count()) === 0, '1: 코드 has no number row');
    await wait(600);
    await shot(page, '01-desktop-code');

    const design = await api<TraceMap>('map?design=1');
    const drift = design.drift!;
    console.log(`drift ${JSON.stringify(drift.counts)}; design modules ${design.design!.modules.length}, design cells ${design.design!.structure?.blocks.length}, design arrows (pairs) ${design.design!.structure?.pairs.length}, edges ${design.design!.edges.length}`);
    await win.locator('[data-testid="dm-view"][data-view="design"]').click();
    await eventually('the design cards', async () => (await win.getByTestId('arch-card').count()) === design.design!.structure!.blocks.filter((b) => b.kind !== 'rail').length);
    check(requests.some((u) => u.includes('design=1')), '1: 설계 asks with design=1');
    const dLines = Number(await win.getByTestId('arch-cards-flow').getAttribute('data-lines'));
    console.log(`design: ${await win.getByTestId('arch-card').count()} cards, ${dLines} arrows`);
    check((await win.getByTestId('dm-num').count()) === 4, '1: 설계 shows the four numbers');
    await wait(600);
    await shot(page, '02-desktop-design');
    await win.locator('.ac-main').screenshot({ path: path.join(OUT, '02z-design-map.png') });

    await win.locator('[data-testid="dm-view"][data-view="overlay"]').click();
    const ghostN = new Set(drift.items.filter((i) => i.kind === 'designOnly').map((i) => i.module)).size;
    await eventually('the overlay', async () => (await win.getByTestId('dm-ghost').count()) === ghostN && (await win.getByTestId('arch-card').count()) === cells.length);
    const markN = await win.getByTestId('dm-mark').count();
    check(markN >= cells.length, `1: 겹쳐 보기: ${cells.length} code cards marked (${markN} marks), ${ghostN} ghost cards`);
    await wait(600);
    await shot(page, '03-desktop-overlay');
    await win.locator('.ac-main').screenshot({ path: path.join(OUT, '03z-overlay-map.png') });

    // ── 2. the number row ──
    for (const n of await win.getByTestId('dm-num').all()) {
      const kind = (await n.getAttribute('data-kind')) as keyof typeof drift.counts;
      check(Number(await n.getAttribute('data-n')) === drift.counts[kind], `2: ${kind} shows ${drift.counts[kind]}`);
    }
    const designOnly = win.locator('[data-testid="dm-num"][data-kind="designOnly"]');
    await designOnly.click();
    await eventually('the examples', async () => (await win.getByTestId('dm-ex').count()) === drift.items.filter((i) => i.kind === 'designOnly').length);
    await wait(300);
    await shot(page, '04-desktop-examples');
    await win.locator('.ac-main').screenshot({ path: path.join(OUT, '04z-examples.png') });
    await win.getByTestId('dm-ex').first().click();
    await eventually('the ghost detail', async () => (await win.getByTestId('dm-ghost-detail').count()) === 1);
    check((await win.locator('[data-testid="dm-ghost"][data-picked], [data-testid="dm-ghost"][data-selected]').count()) === 1, '2: an example opens its ghost card');
    await wait(300);
    await shot(page, '05-desktop-ghost-open');
    await win.locator('.ac-detail').screenshot({ path: path.join(OUT, '05z-ghost-detail.png') });
    const first = win.getByTestId('arch-card').first();
    await first.click();
    await eventually('the code detail', async () => (await win.getByTestId('dm-note').count()) === 1);
    await shot(page, '06-desktop-card-note');
    await win.locator('.ac-detail').screenshot({ path: path.join(OUT, '06z-card-note.png') });

    // ── 3. phone ──
    const state = await ctx.storageState();
    const pctx = await browser.newContext({ ...PHONE, storageState: { cookies: state.cookies, origins: state.origins.map((o) => ({ ...o, localStorage: o.localStorage.filter((x) => !x.name.includes('workbench')) })) } });
    const phone = await pctx.newPage();
    await phone.goto(`http://127.0.0.1:${port}/`);
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
    await phone.locator('[data-testid="dm-view"][data-view="overlay"]').tap();
    await eventually('phone overlay', async () => (await phone.getByTestId('dm-ghost').count()) === ghostN);
    check(await noScroll(), '3: phone: 겹쳐 보기, no horizontal scroll at 390 px');
    await wait(600);
    await shot(phone, '07-phone-overlay');
    await phone.locator('[data-testid="dm-num"][data-kind="designOnly"]').tap();
    await phone.getByTestId('dm-list').scrollIntoViewIfNeeded();
    check(await noScroll(), '3: phone: the number row opened, no horizontal scroll');
    await wait(300);
    await shot(phone, '08-phone-numbers');
    await phone.locator('[data-testid="dm-view"][data-view="design"]').tap();
    await eventually('phone design', async () => (await phone.getByTestId('arch-card').count()) > 0 && (await phone.getByTestId('dm-ghost').count()) === 0);
    await wait(600);
    await shot(phone, '09-phone-design');
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
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
