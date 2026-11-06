/**
 * RQ4 visual and behaviour check: dist/cli.js in a temp HOME (the engine's fake `claude`, and a fake
 * `uvx` first on PATH that records its argv and writes what Spec Kit would: never the real uv,
 * specify or network), two engine projects in temp git repositories:
 *  - alpha: an SRS table, read; the ⚙ sheet's "에이전트가 쓰는 모양" block: the switch, the install
 *    plan it offers, consent, the result line;
 *  - beta: no requirements document; the empty screen's [에이전트가 Spec Kit 모양으로 쓰게 하기].
 * Photos in cld/artifacts/feat-reqs-engine-path/: 모던 at 1600x1000, 픽셀 감성, a phone at 390x844.
 *
 *   npx tsx cld/test/run-reqs-engine-path.ts [port 19220-19229]
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SPEC_KIT_COMMIT, SPEC_KIT_SOURCE, SPEC_KIT_VERSION } from '../../server/src/constants.js';
import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo, type TempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import {
  assertPortFree,
  type Daemon,
  DEV_WINDOW,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openWorkbenchTab,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]) || 19220;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/feat-reqs-engine-path');
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

const SRS = ['# SRS', '', '### 3.1 엔진(ENG)', '', '| ID | 요구사항 |', '|---|---|', '| FR-ENG-001 | 엔진이 세션을 이어 받는다 |', ''].join('\n');
/** What `uvx --from … specify …` would write, in its cwd; every call logged. */
const FAKE_UVX = (log: string) => `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: a, cwd: process.cwd() }) + '\\n');
const skills = { claude: '.claude/skills', codex: '.agents/skills' };
const key = a.includes('init') ? a[a.indexOf('--integration') + 1] : a.includes('install') ? a[a.indexOf('install') + 1] : null;
if (a.includes('init')) {
  fs.mkdirSync('.specify/templates', { recursive: true });
  fs.mkdirSync('.specify/memory', { recursive: true });
  fs.writeFileSync('.specify/templates/spec-template.md', '# Feature Specification: [FEATURE NAME]\\n');
  fs.writeFileSync('.specify/memory/constitution.md', '# Constitution\\n');
}
if (key) for (const c of ['plan', 'specify', 'tasks']) {
  fs.mkdirSync(skills[key] + '/speckit-' + c, { recursive: true });
  fs.writeFileSync(skills[key] + '/speckit-' + c + '/SKILL.md', '---\\nname: speckit-' + c + '\\n---\\n');
}
`;

function repoWith(files: Record<string, string>): TempRepo {
  const repo = makeTempRepo({ push: false });
  for (const [rel, text] of Object.entries(files)) repo.write(rel, text);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs: start']);
  return repo;
}

async function main() {
  if (port < 19220 || port > 19229) throw new Error('port 19220-19229');
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const uvBin = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-fake-uvx-'));
  const uvLog = path.join(uvBin, 'calls.jsonl');
  fs.writeFileSync(path.join(uvBin, 'uvx'), FAKE_UVX(uvLog), { mode: 0o755 });
  const cfg = configDirectory(home);
  const put = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(cfg, rel)), { recursive: true });
    fs.writeFileSync(path.join(cfg, rel), JSON.stringify(data));
  };
  const alpha = repoWith({ 'docs/requirements/SRS.md': SRS, 'CLAUDE.md': "# alpha's own\n" });
  const beta = repoWith({ 'README.md': '# beta\n' });
  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  const projects = [
    ['p_aaaaaaaaaa', 'alpha', alpha],
    ['p_bbbbbbbbbb', 'beta', beta],
  ] as const;
  put('projects.json', {
    v: 2,
    projects: projects.map(([projectId, name, r], i) => ({ projectId, name, folder: r.folder, room: '개발실', leadAssignmentId: `a_${'ab'[i].repeat(10)}` })),
  });
  put('assignments.json', {
    v: 1,
    assignments: projects.map(([projectId], i) => ({ assignmentId: `a_${'ab'[i].repeat(10)}`, projectId, role: 'lead', provider: 'claude', wantRunning: false })),
  });
  const daemon: Daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'], {
    PATH: uvBin,
  });
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  let current: Page | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL'); // our own daemon only
  }, DEADLINE_MS);
  const calls = () => (fs.existsSync(uvLog) ? fs.readFileSync(uvLog, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; cwd: string }) : []);
  const pinned = ['--from', `${SPEC_KIT_SOURCE}@${SPEC_KIT_COMMIT}`, 'specify', 'init', '--here', '--force', '--non-interactive', '--ignore-agent-tools', '--script', 'sh', '--integration', 'claude', '--integration-options=--events false'];
  try {
    browser = await launchBrowser();
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await ctx.newPage();
    current = page;
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    const enable = await page.evaluate(
      async (url) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ docs: ['docs/requirements/SRS.md'] }) })).status,
      `/api/cld/spec/alpha/enable`,
    );
    check(enable === 200, 'alpha reads its SRS');
    const win = page.locator(DEV_WINDOW);

    // ── beta: the empty screen's button ──
    await openWorkbenchTab(page, '요구사항', { project: 'beta' });
    await win.getByTestId('hud-title-office').dblclick(); // maximized
    const more = win.getByTestId('reqs-empty-workflow');
    await more.waitFor();
    check((await more.innerText()).includes('요구사항 문서를 아직 쓰지 않았다면'), 'empty: the line for a project with no requirement documents');
    await shot(page, '01-empty-desktop');
    await more.getByTestId('reqs-empty-workflow-open').click();
    const block = more.getByTestId('reqs-workflow');
    await block.waitFor();
    check((await block.getByTestId('reqs-workflow-what').getAttribute('open')) !== null, 'the button opens the block with 무엇이 바뀌나요? unfolded');
    check((await block.innerText()).includes('CLAUDE.md'), 'it says the app writes none of .claude/settings.json, CLAUDE.md, AGENTS.md');
    await shot(page, '02-empty-open-desktop');

    // ── alpha: the ⚙ sheet's block, the switch, the plan, consent, the result ──
    await win.getByRole('combobox', { name: '개발 프로젝트' }).selectOption('alpha');
    await win.getByTestId('reqs-gear').click();
    const sheet = win.getByTestId('reqs-sheet');
    const wf = sheet.getByTestId('reqs-workflow');
    await wf.waitFor();
    check((await wf.getByTestId('reqs-workflow-switch').getAttribute('aria-checked')) === 'false', 'the switch is off by default');
    await wf.scrollIntoViewIfNeeded();
    await shot(page, '03-sheet-off-desktop');
    await wf.getByTestId('reqs-workflow-switch').click();
    const plan = wf.getByTestId('reqs-workflow-plan');
    await plan.waitFor();
    const files = await plan.getByTestId('reqs-workflow-plan-files').innerText();
    const untouched = await plan.getByTestId('reqs-workflow-plan-untouched').innerText();
    check((await wf.getByTestId('reqs-workflow-switch').getAttribute('aria-checked')) === 'true', 'switched on');
    check(files.includes('.specify/') && files.includes('.claude/skills/speckit-specify/SKILL.md'), 'the plan lists what Spec Kit would create');
    check(['.claude/settings.json', 'CLAUDE.md', 'AGENTS.md'].every((f) => untouched.includes(f)), 'and the files it leaves alone');
    check((await plan.innerText()).includes(SPEC_KIT_VERSION), `and the pinned version ${SPEC_KIT_VERSION}`);
    check(calls().length === 0, 'a plan runs nothing');
    const reg = JSON.parse(fs.readFileSync(path.join(cfg, 'projects.json'), 'utf-8')) as { projects: Array<{ name: string; specWorkflow?: string }> };
    check(reg.projects.find((p) => p.name === 'alpha')?.specWorkflow === 'speckit', "the switch is kept on alpha's project record");
    await plan.scrollIntoViewIfNeeded();
    await shot(page, '04-sheet-plan-desktop');
    await plan.getByTestId('reqs-workflow-consent').click();
    const result = wf.getByTestId('reqs-workflow-result');
    await result.waitFor({ timeout: 30_000 });
    check((await result.getAttribute('data-ok')) !== null && (await result.innerText()).includes('설치했어요'), `the result line: ${(await result.innerText()).split('\n')[0]}`);
    const c = calls();
    check(c.length === 1 && JSON.stringify(c[0].argv) === JSON.stringify(pinned) && fs.realpathSync(c[0].cwd) === fs.realpathSync(alpha.folder), 'uvx got exactly the pinned argv, in alpha\'s folder');
    check(fs.readFileSync(path.join(alpha.folder, 'CLAUDE.md'), 'utf-8') === "# alpha's own\n" && !fs.existsSync(path.join(alpha.folder, '.claude/settings.json')) && !fs.existsSync(path.join(alpha.folder, 'AGENTS.md')), 'CLAUDE.md as it was; no .claude/settings.json, no AGENTS.md');
    await result.scrollIntoViewIfNeeded();
    await shot(page, '05-sheet-result-desktop');

    // ── 픽셀 감성: the block once Spec Kit is there ──
    await page.evaluate(() => localStorage.setItem('cld.ui-theme', 'pixel'));
    await page.reload();
    // the 현황판 may come back open (remembered) or not yet: wait for either before opening the tab
    await page.locator(`${DEV_WINDOW}, [data-hud-id="icon:office"] button`).first().waitFor({ timeout: 30_000 });
    await openWorkbenchTab(page, '요구사항', { project: 'alpha' });
    await win.getByTestId('reqs-gear').click();
    const wf2 = win.getByTestId('reqs-sheet').getByTestId('reqs-workflow');
    await wf2.getByTestId('reqs-workflow-uninstall').waitFor();
    check((await page.locator('html').getAttribute('data-ui-theme')) === 'pixel', '픽셀 감성 on');
    check((await wf2.getByTestId('reqs-workflow-kit').innerText()).includes('.specify/'), 'installed: it says Spec Kit is there and offers its uninstall');
    await wf2.scrollIntoViewIfNeeded();
    await shot(page, '06-pixel-sheet-installed');
    await page.evaluate(() => localStorage.setItem('cld.ui-theme', 'modern'));
    const state = await ctx.storageState();

    // ── the phone: beta's empty screen, switch on, the plan, consent, the result ──
    const pctx = await browser.newContext({ ...PHONE, storageState: state });
    const phone = await pctx.newPage();
    current = phone;
    await phone.goto(`http://127.0.0.1:${port}/`);
    await openWorkbenchTab(phone, '요구사항', { project: 'beta', tap: true });
    const pw = phone.locator(DEV_WINDOW);
    await pw.getByTestId('reqs-empty-workflow-open').tap();
    await pw.getByTestId('reqs-workflow-switch').tap();
    const pplan = pw.getByTestId('reqs-workflow-plan');
    await pplan.waitFor();
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'phone: no horizontal scroll');
    await pplan.scrollIntoViewIfNeeded();
    await shot(phone, '07-phone-plan');
    await pplan.getByTestId('reqs-workflow-consent').tap();
    const presult = pw.getByTestId('reqs-workflow-result');
    await presult.waitFor({ timeout: 30_000 });
    check(fs.existsSync(path.join(beta.folder, '.specify')), 'phone: Spec Kit installed in beta');
    await presult.scrollIntoViewIfNeeded();
    await shot(phone, '08-phone-result');
    await pctx.close();
    console.log(`\n${oks} checks passed; photos in ${OUT}`);
  } catch (err) {
    await current?.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => undefined);
    console.error(daemon.log.join('').split('\n').filter((l) => /spec|error/i.test(l)).slice(-20).join('\n'));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(uvBin, { recursive: true, force: true });
    for (const r of [alpha, beta]) r.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
