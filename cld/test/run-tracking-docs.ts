/**
 * U-48 phase 2a check: dist/cli.js in an isolated HOME on a spare port, headless
 * Chromium with --disable-gpu, no claude at all. The HOME holds one engine project
 * whose folder is a git repository with a ROADMAP.md (checkboxes under headings, one
 * naming DD-2), a BACKLOG.md (a status table with ids DD-1..DD-3) and notes/plan.md
 * (not a conventional name; changed in git today, so a "켤까요?" candidate, with a short
 * id row Q7), and two board Tasks DD-1 (doing; the document says 완료) and DD-2 (doing).
 * The 작업실 Task tab's 업무 board must:
 * - show ROADMAP.md as a document card with its lines under their headings, the marks
 *   reported, [~] unknown with its raw mark;
 * - show BACKLOG.md as a card holding DD-3 (no Task), its status word inferred;
 * - put DD-1's row under the Task DD-1 card as a source line with 어긋남 and the Task's own
 *   line, DD-2's row under DD-2 without 어긋남, DD-2's mention as a link only;
 * - in 문서 출처: list the conventional documents, offer notes/plan.md, and turning it on
 *   add its card; the short-id switch makes Q7 an id;
 * - follow a checkbox change in ROADMAP.md, hide a card with 숨기기 (tracking.json 0600);
 * - fit a phone screen (393x852). Screenshots go to cld/artifacts/u48b/; the daemon's RSS
 *   is recorded with nobody viewing, while viewing, and after the last viewer left.
 *
 *   npx tsx cld/test/run-tracking-docs.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  openWorkbenchTab,
  REPO_ROOT,
  sparePort,
  startDaemon,
  writeEngineProjects,
} from '../../server/src/cld/testHome.js';
import { configDirectory } from '../../server/src/cld/configPath.js';

const OUT = path.join(REPO_ROOT, 'cld/artifacts/u48b');
const CLI = path.join(REPO_ROOT, 'cld/bin/cld-gui');
const FONTS = {
  malgun: '/mnt/c/Windows/Fonts/malgun.ttf',
  emoji: '/mnt/c/Windows/Fonts/seguiemj.ttf',
};
const FONT_CSS = `
@font-face { font-family: 'FS Pixel Sans'; src: url('/__fonts/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }
@font-face { font-family: 'FS Pixel Sans'; src: url('/__fonts/emoji.ttf');
  unicode-range: U+2300-23FF, U+2600-27BF, U+FE0F, U+1F000-1FAFF; }`;
const DEADLINE_MS = 240_000;
const PROJECT = 'docdemo';

let checks = 0;
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  checks += 1;
  console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => Promise<boolean> | boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
}

const rssKb = (pid: number): number => {
  const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf-8'));
  return m ? Number(m[1]) : 0;
};
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ROADMAP = `# Roadmap

## Phase one
- [x] Sketch the data model
- [ ] Wire the parser
- [~] Maybe a cache

## Phase two
- [ ] Ship the board (DD-2)

\`\`\`
- [ ] not an item: inside a code block
\`\`\`
`;
const BACKLOG = `# Backlog

| ID | 내용 | 상태 |
| --- | --- | --- |
| DD-1 | Parser rewrite | 완료 |
| DD-2 | Board cards | 진행 중 |
| DD-3 | Export to CSV | 예정 |
`;
const PLAN = `# Plan notes

- [ ] Write the onboarding copy

| ID | What | 상태 |
| --- | --- | --- |
| Q7 | Short id row | 진행 |
`;

async function main() {
  const port = sparePort();
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({});
  const home = fake.home;
  const config = path.join(configDirectory(home), 'config.json');
  fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, 'utf-8')), port }));
  const folder = path.join(home, 'work', PROJECT);
  fs.mkdirSync(path.join(folder, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'ROADMAP.md'), ROADMAP);
  fs.writeFileSync(path.join(folder, 'BACKLOG.md'), BACKLOG);
  fs.writeFileSync(path.join(folder, 'notes/plan.md'), PLAN);
  fs.writeFileSync(path.join(folder, 'notes/prose.md'), '# Just prose\n\nNothing to track here.\n');
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', folder, '-c', 'user.name=runner', '-c', 'user.email=runner@example.invalid', ...args], {
      env: { PATH: process.env.PATH, HOME: home },
      encoding: 'utf-8',
    });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'plans');
  writeEngineProjects(home, [{ name: PROJECT, folder, room: 'orch-docs' }]);
  const seed = path.join(home, 'seed.json');
  const now = new Date().toISOString();
  fs.writeFileSync(
    seed,
    JSON.stringify({
      v: 1,
      tasks: [
        { id: 'DD-1', project: PROJECT, title: 'Parser rewrite', status: 'doing', goal: 'Security', source: 'reported', updatedAt: now },
        { id: 'DD-2', project: PROJECT, title: 'Board cards', status: 'doing', goal: 'Security', source: 'reported', updatedAt: now },
      ],
    }),
  );
  const snapshot = (dir: string) =>
    Object.fromEntries(
      fs.readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && !e.parentPath.includes('.git'))
        .map((e) => {
          const p = path.join(e.parentPath, e.name);
          const st = fs.statSync(p);
          return [p, `${st.mtimeMs}:${st.size}`];
        }),
    );

  const started = startDaemon(fake, port, ['--no-terminal']);
  const daemon = started.child;
  const cleanup = () => {
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  };
  const deadline = setTimeout(() => {
    console.error(`aborted: deadline ${DEADLINE_MS / 1000} s\n${started.log.join('')}`);
    cleanup();
    process.exit(1);
  }, DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.once(sig, () => {
      cleanup();
      process.exit(1);
    });
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, HOME: home }, cwd: home, encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`cld-gui ${args.join(' ')}: ${r.status} ${r.stderr}`);
    return r.stdout;
  };

  const fonts = fs.existsSync(FONTS.malgun)
    ? { malgun: fs.readFileSync(FONTS.malgun), emoji: fs.readFileSync(FONTS.emoji) }
    : null;
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  const received: Array<Record<string, unknown>> = [];
  const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript('globalThis.__name = (fn) => fn;');
    if (fonts)
      await ctx.route('**/__fonts/*.ttf', (route) =>
        route.fulfill({ body: route.request().url().endsWith('emoji.ttf') ? fonts.emoji : fonts.malgun, contentType: 'font/ttf' }),
      );
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('websocket', (ws) =>
      ws.on('framereceived', (f) => {
        try {
          received.push(JSON.parse(String(f.payload)) as Record<string, unknown>);
        } catch {
          /* binary */
        }
      }),
    );
    return { ctx, page };
  };
  const ready = async (page: Page, url: string) => {
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    if (fonts) {
      await page.addStyleTag({ content: FONT_CSS });
      await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가📖'));
    }
  };
  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const docCard = (page: Page, rel: string) => page.locator(`[data-testid="task-card"][data-tracked="doc:${PROJECT}/${rel}"]`);
  const taskCard = (page: Page, id: string) => page.locator(`[data-testid="task-card"][data-task-id="${id}"]`);
  const line = (scope: ReturnType<Page['locator']>, text: string) =>
    scope.locator('[data-testid="tracked-line"]').filter({ hasText: text });

  try {
    const loginUrl = await started.loginUrl();
    cli('task', 'import', seed);
    const untouched = snapshot(folder);
    await settle(3_000);
    const rssNoViewer = rssKb(daemon.pid!);
    console.log(`daemon RSS, no viewer: ${rssNoViewer} kB`);
    check(!received.some((m) => m.type === 'trackedItems'), 'no tracked items were sent while nobody viewed');

    // ── desktop ──
    const { ctx: deskCtx, page: desk } = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await ready(desk, loginUrl);
    await openWorkbenchTab(desk, 'Task', { project: PROJECT });
    await desk.getByTestId('task-board').waitFor();
    await until('desktop: the ROADMAP.md card appears', async () => (await docCard(desk, 'ROADMAP.md').count()) === 1);
    const road = docCard(desk, 'ROADMAP.md');
    check((await road.getByTestId('tracked-kind').innerText()) === '문서', 'desktop: the card is a 문서 card');
    check((await road.getAttribute('data-task-status')) === 'todo', 'desktop: ROADMAP.md sits under 할 일 (its lines: done, todo, unknown)');
    const heads = await road.getByTestId('tracked-heading').allInnerTexts();
    check(JSON.stringify(heads) === JSON.stringify(['Phase one', 'Phase two']), `desktop: the headings group the lines (${heads.join(', ')})`);
    check(
      (await line(road, 'Sketch the data model').getAttribute('data-tracked-status')) === 'done' &&
        (await line(road, 'Sketch the data model').getAttribute('data-tracked-source')) === 'reported',
      'desktop: [x] is 끝남, 보고',
    );
    check((await line(road, 'Wire the parser').getAttribute('data-tracked-status')) === 'todo', 'desktop: [ ] is 할 일');
    check(
      (await line(road, 'Maybe a cache').getAttribute('data-tracked-status')) === 'unknown' &&
        (await line(road, 'Maybe a cache').innerText()).includes('[~]'),
      'desktop: [~] is 모름 with its raw mark',
    );
    check((await road.locator('[data-testid="tracked-line"]', { hasText: 'not an item' }).count()) === 0, 'desktop: a fenced code block makes no line');
    check((await line(road, 'Wire the parser').innerText()).includes('ROADMAP.md:5'), 'desktop: a line says where it was seen (path:line)');

    const backlog = docCard(desk, 'BACKLOG.md');
    check((await backlog.count()) === 1, 'desktop: BACKLOG.md is a card');
    check(
      (await line(backlog, 'Export to CSV').getAttribute('data-tracked-status')) === 'todo' &&
        (await line(backlog, 'Export to CSV').getAttribute('data-tracked-source')) === 'inferred',
      'desktop: the 예정 row is 할 일, 추정 (a free-text status cell)',
    );
    check((await line(backlog, 'Parser rewrite').count()) === 0, 'desktop: a row whose id is a Task is not in the document card');

    const dd1 = taskCard(desk, 'DD-1');
    const dd1Source = dd1.getByTestId('tracked-doc-source');
    check((await dd1.getAttribute('data-task-status')) === 'doing', 'desktop: the Task DD-1 keeps its own status (진행 중)');
    check((await dd1Source.count()) === 1 && (await dd1Source.getAttribute('data-tracked-status')) === 'done', 'desktop: DD-1 shows the document line 끝남');
    check((await dd1Source.innerText()).includes('BACKLOG.md'), 'desktop: the source line names its relative path');
    check((await dd1.getByTestId('tracked-drift').innerText()) === '어긋남', 'desktop: DD-1 is marked 어긋남');
    check((await dd1.getByTestId('tracked-task-line').count()) === 1, 'desktop: DD-1 shows the Task’s own line next to the document’s');
    const dd2 = taskCard(desk, 'DD-2');
    check((await dd2.getByTestId('tracked-doc-source').count()) === 1, 'desktop: DD-2 shows its document line');
    check((await dd2.getByTestId('tracked-drift').count()) === 0, 'desktop: DD-2 agrees with its document: no 어긋남');
    check((await dd2.getByTestId('tracked-mentions').count()) === 1, 'desktop: ROADMAP.md’s mention of DD-2 is a link on DD-2 only');
    check((await line(road, 'Ship the board').count()) === 1, 'desktop: …and the mentioning line stays in its document');
    const mvp = await desk.getByTestId('mvp-progress').innerText();
    check(/0\/2/.test(mvp), `desktop: the MVP summary counts the Tasks only (${mvp.replace(/\n/g, ' | ')})`);
    const rssViewing = rssKb(daemon.pid!);
    console.log(`daemon RSS, viewing with document items: ${rssViewing} kB`);
    await shot(desk, 'desktop-board');
    await dd1.scrollIntoViewIfNeeded();
    await shot(desk, 'desktop-task-drift');

    // ── 문서 출처: the candidate from git, turned on; short ids ──
    const sources = desk.getByTestId('doc-sources');
    await sources.scrollIntoViewIfNeeded();
    await sources.getByRole('button', { name: '문서 출처' }).click();
    await until('desktop: the found documents are listed', async () => (await sources.getByTestId('doc-found').count()) === 2);
    const found = await sources.getByTestId('doc-found').evaluateAll((els) => els.map((e) => e.getAttribute('data-path')));
    check(JSON.stringify(found) === JSON.stringify(['ROADMAP.md', 'BACKLOG.md']), `desktop: the conventional documents are found (${found.join(', ')})`);
    const candidate = sources.locator('[data-testid="doc-candidate"][data-path="notes/plan.md"]');
    await until('desktop: notes/plan.md is offered', async () => (await candidate.count()) === 1);
    check((await sources.locator('[data-testid="doc-candidate"][data-path="notes/prose.md"]').count()) === 0, 'desktop: a document without items is not offered');
    await shot(desk, 'desktop-settings');
    await candidate.getByRole('button', { name: '켜기' }).click();
    await until('desktop: notes/plan.md’s card appears', async () => (await docCard(desk, 'notes/plan.md').count()) === 1);
    const plan = docCard(desk, 'notes/plan.md');
    check((await line(plan, 'Write the onboarding copy').count()) === 1, 'desktop: turning the candidate on adds its items');
    check((await plan.locator('[data-tracked-key$="#Q7"]').count()) === 0, 'desktop: with short ids off, Q7 is no id');
    await sources.getByTestId('doc-short-ids').click(); // the box follows the daemon's answer, not the click
    await until('desktop: with short ids on, Q7 is an id', async () => (await plan.locator('[data-tracked-key$="#Q7"]').count()) === 1);
    await plan.scrollIntoViewIfNeeded();
    await shot(desk, 'desktop-after-candidate');

    // ── a document change arrives without a reload (the office's 30 s check at the latest) ──
    fs.writeFileSync(path.join(folder, 'ROADMAP.md'), ROADMAP.replace('- [ ] Wire the parser', '- [x] Wire the parser'));
    await until(
      'desktop: the checkbox change shows',
      async () => (await line(road, 'Wire the parser').getAttribute('data-tracked-status')) === 'done',
      45_000,
    );
    check(true, 'desktop: a checkbox change shows without a reload');

    // ── 숨기기 ──
    await road.locator('button[aria-expanded]').first().click();
    await road.getByTestId('tracked-hide').click();
    await until('desktop: the hidden card leaves the board', async () => (await docCard(desk, 'ROADMAP.md').count()) === 0);
    const stored = path.join(configDirectory(home), 'tracking.json');
    const st = fs.statSync(stored);
    const json = JSON.parse(fs.readFileSync(stored, 'utf-8')) as { v: number; projects: Record<string, { docs: { on: string[] }; shortIds: boolean; hidden: string[] }> };
    check((st.mode & 0o777) === 0o600, 'tracking.json is 0600');
    check(
      json.v === 1 &&
        json.projects[PROJECT].docs.on.includes('notes/plan.md') &&
        json.projects[PROJECT].shortIds === true &&
        json.projects[PROJECT].hidden.includes(`doc:${PROJECT}/ROADMAP.md`),
      `tracking.json holds the settings only (${JSON.stringify(json)})`,
    );
    const after = snapshot(folder);
    delete untouched[path.join(folder, 'ROADMAP.md')]; // the runner's own edit
    delete after[path.join(folder, 'ROADMAP.md')];
    check(JSON.stringify(after) === JSON.stringify(untouched), 'the project folder was not written (only the runner’s own edit)');
    check(!(await desk.getByTestId('task-board').innerText()).includes(folder), 'no absolute path reaches the screen');

    // ── phone ──
    const { ctx: phoneCtx, page: phone } = await open({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    await phoneCtx.addCookies(await deskCtx.cookies());
    await ready(phone, `http://127.0.0.1:${port}/`);
    await openWorkbenchTab(phone, 'Task', { project: PROJECT, tap: true });
    await phone.getByTestId('task-board').waitFor();
    await until('phone: the document cards show', async () => (await docCard(phone, 'BACKLOG.md').count()) === 1);
    const widths = await phone.evaluate(() => {
      const board = document.querySelector('[data-testid="task-board"]') as HTMLElement;
      const wide = [...board.querySelectorAll<HTMLElement>('*')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1);
      return { doc: document.documentElement.scrollWidth, view: window.innerWidth, wide: wide.length };
    });
    check(widths.doc <= widths.view && widths.wide === 0, `phone: nothing wider than the screen (${JSON.stringify(widths)})`);
    await shot(phone, 'phone-board');
    await taskCard(phone, 'DD-1').scrollIntoViewIfNeeded();
    await shot(phone, 'phone-task-drift');

    await phone.close();
    await desk.close();
    await settle(3_000);
    const rssAfter = rssKb(daemon.pid!);
    console.log(`RSS kB: no viewer ${rssNoViewer} -> viewing ${rssViewing} -> left ${rssAfter}`);
    check(pageErrors.length === 0, `no page errors${pageErrors.map((e) => `\n  ${e}`).join('')}`);
    console.log(`all ${checks} checks passed`);
  } finally {
    clearTimeout(deadline);
    await browser.close();
    cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
