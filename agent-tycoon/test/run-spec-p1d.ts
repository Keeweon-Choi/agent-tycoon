/**
 * SPT-P1D visual check: dist/cli.js in a temp HOME (the engine fake as `claude`, no real agent),
 * one project `alpha` whose folder is a temp git repository with an SRS table and two specs.
 *  1. Turn spec tracking on.
 *  2. Remove the project keeping its data (`agty project remove`): only registry.json stays; add
 *     it again from the same folder (the add dialog): the 개요 card offers 이어받기, nothing moved.
 *  3. 이어받기: the same document and item UIDs; one audit.jsonl entry, no document text.
 *  4. `agty backup` (the Registry in, the match cache and the key out), then remove with
 *     데이터까지 지우기 (`--purge`): spec/<projectId>/ is gone.
 *  5. Stop the daemon, `agty restore --yes`, start it again: the project and its UIDs are back,
 *     the match cache rebuilt on the first read.
 *  6. Phone 390x844: the offer card (step 2) and the 요구사항 tab, no horizontal page scroll.
 * The daemon changes no repository byte (.git included). Screenshots in agent-tycoon/artifacts/spec-p1d/.
 *
 *   npx tsx agent-tycoon/test/run-spec-p1d.ts [port 18284] (18285 after the restore)
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { makeTempRepo } from '../../server/src/agent-tycoon/engine/git/testRepo.js';
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
} from '../../server/src/agent-tycoon/testHome.js';
import { ADMIN, AUTH, SRS } from './run-spec-p1c.js';

const port = Number(process.argv[2]) || 18284;
const port2 = port + 1;
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/spec-p1d');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__sp/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
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
async function eventually<T>(what: string, test: () => Promise<T | null | undefined | false>, timeout = 30_000): Promise<T> {
  for (const end = Date.now() + timeout; ; await wait(250)) {
    const v = await test();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}
function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of fs.readdirSync(root, { recursive: true }).map(String).sort()) {
    const abs = path.join(root, rel);
    if (fs.lstatSync(abs).isFile()) out[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  }
  return out;
}
const diff = (a: Record<string, string>, b: Record<string, string>) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);
type Item = { uid: string; displayId?: string };
type Doc = { uid: string; path: string };

async function main() {
  if (port !== 18284) throw new Error('port 18284 (and 18285)');
  await assertPortFree(port, port2);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  const put = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(cfg, rel)), { recursive: true });
    fs.writeFileSync(path.join(cfg, rel), JSON.stringify(data));
  };
  const repo = makeTempRepo({ push: false });
  const old = () => new Date(Date.now() - 60_000);
  const write = (rel: string, text: string) => {
    repo.write(rel, text);
    fs.utimesSync(path.join(repo.folder, rel), old(), old());
  };
  write('docs/requirements/SRS.md', SRS);
  write('docs/specs/auth.md', AUTH);
  write('docs/specs/admin.md', ADMIN);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs: SRS and specs']);
  const before = hashTree(repo.folder);

  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  put('projects.json', { v: 2, projects: [{ projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: repo.folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }] });
  put('assignments.json', { v: 1, assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true }] });
  const args = ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'];
  let daemon: Daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, args);
  let base = `http://127.0.0.1:${port}`;
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}, repo ${repo.folder}`);
  const cli = (...a: string[]) => {
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'agent-tycoon/bin/agty'), ...a], { env: { ...process.env, HOME: home, AGTY_OUTPUT: 'json' }, encoding: 'utf8', timeout: 60_000 });
    try {
      return JSON.parse(r.stdout || '{}') as Record<string, unknown>;
    } catch {
      return { ok: false, out: r.stdout, err: r.stderr };
    }
  };
  const projectId = () => (JSON.parse(fs.readFileSync(path.join(cfg, 'projects.json'), 'utf8')) as { projects: Array<{ name: string; projectId: string }> }).projects.find((p) => p.name === 'alpha')?.projectId;
  const specDir = (id: string) => path.join(cfg, 'spec', id);
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
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
    const api = async (p: Page, route: string) => {
      const r = await p.request.get(`${base}/api/agty/spec/alpha/${route}`);
      if (!r.ok()) throw new Error(`${route}: ${r.status()} ${await r.text()}`);
      return r.json();
    };
    const uidsOf = async (p: Page) => ({
      docs: Object.fromEntries(((await api(p, 'docs')).docs as Doc[]).map((d) => [d.path, d.uid])),
      items: ((await api(p, 'items?kind=&limit=500')).items as Item[]).map((i) => i.uid).sort(),
    });
    const login = async (opts: BrowserContextOptions) => {
      const o = await open(opts);
      await o.page.goto(await daemon.loginUrl());
      await o.page.waitForURL(`${base}/`);
      await hangul(o.page);
      return o;
    };
    const devTab = async (page: Page) => {
      await openOfficeWindow(page);
      const win = page.locator(DEV_WINDOW);
      await win.getByRole('button', { name: '프로젝트', exact: true }).click();
      const picker = win.getByRole('combobox', { name: '개발 프로젝트' });
      await eventually('alpha in the picker', async () => (await picker.locator('option[value="alpha"]').count()) > 0);
      await picker.selectOption('alpha');
      return { win, tab: (name: string) => win.getByRole('button', { name, exact: true }) };
    };

    // ── 1. Enable ──
    let { ctx: desk, page } = await login({ viewport: { width: 1400, height: 1000 } });
    let { win, tab } = await devTab(page);
    await tab('개요').click();
    await win.getByTestId('spec-turn-on').click();
    const wizard = page.getByTestId('spec-wizard');
    await eventually('candidates', async () => (await wizard.getByTestId('spec-candidate').count()) === 3);
    await wizard.getByTestId('spec-wizard-confirm').click();
    await eventually('enabled', async () => (await wizard.getByTestId('spec-wizard-done').count()) > 0);
    await wizard.getByRole('button', { name: '닫기' }).click();
    const first = await uidsOf(page);
    const p1 = projectId()!;
    check(Object.keys(first.docs).length === 3 && first.items.length >= 6, `1: 3 documents and ${first.items.length} items tracked`);
    check(fs.readdirSync(specDir(p1)).sort().join() === 'match-cache.json.gz,registry.json', '1: registry.json and the match cache');
    await shot(page, '01-enabled');

    // ── 2. Remove keeping the data, add again from the same folder: offered ──
    const removed = cli('project', 'remove', 'alpha');
    check(removed.ok === true, `2: removed without the purge box (${JSON.stringify(removed).slice(0, 100)})`);
    check(fs.readdirSync(specDir(p1)).join() === 'registry.json', '2: the match cache went, registry.json stayed');
    await page.getByRole('button', { name: '오케스트레이터 추가', exact: true }).first().click();
    const form = page.getByRole('form', { name: '오케스트레이터 추가' });
    await form.waitFor();
    await form.getByLabel('폴더', { exact: true }).fill(repo.folder);
    await form.getByLabel('이름', { exact: true }).fill('alpha');
    await form.getByRole('button', { name: '추가', exact: true }).click();
    await form.waitFor({ state: 'detached', timeout: 30_000 });
    const p2 = await eventually('the new projectId', async () => projectId());
    check(p2 !== p1, `2: added again with a new projectId (${p2})`);
    ({ win, tab } = await devTab(page));
    await tab('개요').click();
    const offer = win.getByTestId('spec-inherit-offer');
    await eventually('the 이어받기 offer', async () => (await offer.count()) === 1);
    const offerText = (await offer.innerText()).replace(/\s+/g, ' ');
    check((await offer.getAttribute('data-from')) === p1 && offerText.includes("'alpha'") && offerText.includes(`항목 ${first.items.length}개`), `2: the 개요 card offers it (${offerText.slice(0, 90)})`);
    check(!fs.existsSync(specDir(p2)) && fs.existsSync(path.join(specDir(p1), 'registry.json')), '2: nothing moved before the owner chose');
    await win.getByTestId('spec-inherit').scrollIntoViewIfNeeded();
    await shot(page, '02-offer');
    const phoneState = await desk.storageState();
    {
      const { ctx, page: phone } = await open({ ...PHONE, storageState: phoneState });
      await phone.goto(`${base}/`);
      await hangul(phone);
      await phone.locator('[data-dock="board"]').tap();
      const pw = phone.locator('[aria-label="현황판 화면"]');
      const dev = pw.getByRole('button', { name: '프로젝트', exact: true });
      if ((await dev.count()) && (await dev.getAttribute('aria-pressed')) !== 'true') await dev.tap();
      await pw.getByRole('navigation', { name: '개발 메뉴' }).getByRole('button', { name: '개요', exact: true }).tap();
      await eventually('phone offer', async () => (await pw.getByTestId('spec-inherit-offer').count()) === 1);
      await pw.getByTestId('spec-inherit').scrollIntoViewIfNeeded();
      check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '6: no horizontal page scroll on the offer at 390 px');
      await phone.screenshot({ path: path.join(OUT, '06a-phone-offer.png') });
      await ctx.close();
    }

    // ── 3. 이어받기 ──
    await win.getByTestId('spec-inherit-accept').click();
    await eventually('tracking on again', async () => (await win.locator('[data-testid="spec-card"][data-enabled="true"]').count()) === 1);
    const after = await uidsOf(page);
    check(JSON.stringify(after) === JSON.stringify(first), '3: the same document and item UIDs');
    check(!fs.existsSync(specDir(p1)) && fs.existsSync(path.join(specDir(p2), 'registry.json')), `3: spec/${p1} moved to spec/${p2}`);
    const audit = fs.readFileSync(path.join(cfg, 'audit.jsonl'), 'utf8');
    check(audit.includes(`"detail":"inherit ${p2} accept ${p1}"`) && !/FR-OFC|사무실|SRS/.test(audit), '3: one audit.jsonl entry, no document text');
    await shot(page, '03-inherited');

    // ── 4. Backup, then remove with 데이터까지 지우기 ──
    await eventually('the match cache rebuilt', async () => fs.existsSync(path.join(specDir(p2), 'match-cache.json.gz')));
    const archive = path.join(home, 'backup.json.gz');
    const made = cli('backup', '--out', archive);
    check(made.ok === true, `4: agty backup (${JSON.stringify(made).slice(0, 80)})`);
    const files = Object.keys((JSON.parse(zlib.gunzipSync(fs.readFileSync(archive)).toString('utf8')) as { files: object }).files);
    check(files.includes(`spec/${p2}/registry.json`) && !files.some((f) => /match-cache|spec\.key/.test(f)), `4: the archive holds the Registry, not the cache or the key (${files.filter((f) => f.startsWith('spec')).join(', ')})`);
    check(cli('project', 'remove', 'alpha', '--purge').ok === true, '4: removed with 데이터까지 지우기');
    check(!fs.existsSync(specDir(p2)) && fs.existsSync(path.join(cfg, 'spec.key')), `4: spec/${p2} is gone (the key outside it stays)`);
    await page.reload();
    await hangul(page);
    await openOfficeWindow(page);
    await page.locator(DEV_WINDOW).getByRole('button', { name: '프로젝트', exact: true }).click();
    await shot(page, '04-purged');
    await desk.close();

    // ── 5. Restore ──
    await daemon.stop();
    killFakeSessions(home);
    const restored = cli('restore', archive, '--yes');
    check(restored.ok === true, `5: agty restore --yes (${JSON.stringify(restored).slice(0, 80)})`);
    check(fs.readdirSync(specDir(p2)).join() === 'registry.json', '5: the Registry is back, no cache');
    put('config.json', { accessChosen: true, port: port2 });
    daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port2, args);
    base = `http://127.0.0.1:${port2}`;
    ({ ctx: desk, page } = await login({ viewport: { width: 1400, height: 1000 } }));
    ({ win, tab } = await devTab(page));
    check(projectId() === p2, '5: the project is registered again under its projectId');
    const back = await uidsOf(page);
    check(JSON.stringify(back) === JSON.stringify(first), '5: the UIDs came back');
    await eventually('the cache rebuilt', async () => fs.existsSync(path.join(specDir(p2), 'match-cache.json.gz')));
    check(true, '5: the match cache was rebuilt on the first read');
    await tab('요구사항').click();
    await eventually('the list', async () => (await win.getByTestId('spec-item').count()) > 0);
    await shot(page, '05-restored-reqs');
    check(diff(before, hashTree(repo.folder)).length === 0, 'the daemon changed no repository byte (.git included)');
    const state = await desk.storageState();
    await desk.close();

    // ── 6. Phone ──
    const { page: phone } = await open({ ...PHONE, storageState: state });
    await phone.goto(`${base}/`);
    await hangul(phone);
    await phone.locator('[data-dock="board"]').tap();
    const pw = phone.locator('[aria-label="현황판 화면"]');
    const dev = pw.getByRole('button', { name: '프로젝트', exact: true });
    if ((await dev.count()) && (await dev.getAttribute('aria-pressed')) !== 'true') await dev.tap();
    await pw.getByRole('navigation', { name: '개발 메뉴' }).getByRole('button', { name: '요구사항', exact: true }).tap();
    await eventually('phone list', async () => (await pw.getByTestId('spec-item').count()) > 0);
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '6: no horizontal page scroll on 요구사항 at 390 px');
    await shot(phone, '06b-phone-reqs');
    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    console.error(daemon.log.join('').split('\n').filter((l) => /spec|error/i.test(l)).slice(-20).join('\n'));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    try {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (err) {
      console.warn(`temp HOME not removed (the PTY host may still be writing): ${String(err)}`); // not a check
    }
    repo.cleanup();
  }
}

if (process.argv[1]?.endsWith('run-spec-p1d.ts'))
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
