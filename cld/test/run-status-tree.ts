/**
 * T-0029 check: the 현황판 tree on dist/cli.js with an isolated HOME whose `claude` is
 * the engine fake (as run-messenger.ts), eight engine projects in three rooms
 * (four revived by the engine and played: alpha and eta think, beta asks a question,
 * delta reads; four off), --engine on --allow-actions on a spare port. Headless Chromium
 * logs in and, on a 1280×960 desktop: the default tree (rooms open, every
 * orchestrator folded to one look: name, badge, ring, activity), all eight
 * orchestrators on one screen; a room folded to its summary and worst badge;
 * an orchestrator opened (지금 하는 일, 최근 활동 from the engine's events file, a closed
 * 프로젝트 현황: no statusView yet); 프로젝트 현황 opened and closed (one statusView on,
 * then one off, the local report polled while open and not after), folded away with
 * its orchestrator and with its room (off each time); 모두 펼치기 / 모두 접기; the
 * filter chips; all of it kept across a reload. Then a 393×852 phone with iPhone
 * insets: the same tree, ≥ 44 px tap targets, nothing in the inset strips. Two
 * transcripts get a tool call first (beta asks a question, delta reads), so every
 * filter has rows. Every statusView sent is saved; screenshots use Hangul from
 * malgun.ttf (read only). The top bar's usage strip (a fake claude-dashboard plugin)
 * folds to one line ("Claude 5h 42% · 7d 16% Codex 5h 35% · 7d 6%") and stays folded
 * across a reload, on both screens. A hard deadline and SIGINT/SIGTERM/SIGHUP kill
 * the server and the fake's sessions too.
 *
 *   npx tsx cld/test/run-status-tree.ts <port 18256-18259>
 */
import type { Browser, Locator, Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
import {
  assertPortFree,
  hostHealth,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openOfficeWindow,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';
import { configDirectory } from '../../server/src/cld/configPath.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0029');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
// Hangul from Malgun Gothic, everything else still the pixel font: for its
// range, the @font-face defined last is tried first.
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0029/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 300_000;
// iPhone 15/16 Home-Screen PWA (viewport-fit=cover), portrait; the side
// insets are a notch's, to prove the panel keeps to the --cld-safe-* vars.
const INSETS = { top: 59, bottom: 34, left: 20, right: 20 };
const HEAD = '최근 커밋 (펼쳐 둔 동안 10초마다 갱신)';
const ROWS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
// The roster with the two tool calls below: who shows which ring.
const ROOMS: Record<string, string> = {
  alpha: 'orch-alpha',
  beta: 'orch-alpha',
  gamma: 'orch-alpha',
  delta: 'orch-beta',
  epsilon: 'orch-beta',
  zeta: 'orch-beta',
  eta: 'orch-gamma',
  theta: 'orch-gamma',
};
const LIVE = ['alpha', 'beta', 'delta', 'eta'];
const REPORT_OUTPUT = '돌고 있는 작업 없음';
const RINGS: Record<string, string> = {
  alpha: 'working',
  beta: 'waiting',
  gamma: 'off',
  delta: 'working',
  epsilon: 'off',
  zeta: 'off',
  eta: 'working',
  theta: 'off',
};

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

const said = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  message: { model: 'claude-haiku-4-5', content: [{ type: 'tool_use', id, name, input }] },
});
const answered = (id: string) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});

/** Elements of the 현황판 panel (or the whole page) drawn inside an inset strip. */
function stripViolations(page: Page): Promise<{ checked: number; out: string[] }> {
  // No named functions inside evaluate: tsx's keepNames would inject __name.
  return page.evaluate((ins) => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const out: string[] = [];
    let checked = 0;
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (el.closest('[data-testid="agent-overlay"], [data-testid="ez-mood"], canvas')) continue;
      const tappable = el.matches('button, a[href], input, select, textarea, [role="button"]');
      const texty = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim());
      if (!tappable && !texty) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
        continue;
      }
      const r = el.getBoundingClientRect();
      let [x0, x1, y0, y1] = [
        Math.max(r.left, 0),
        Math.min(r.right, W),
        Math.max(r.top, 0),
        Math.min(r.bottom, H),
      ];
      for (let a = el.parentElement; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
        const c = a.getBoundingClientRect();
        [x0, x1, y0, y1] = [
          Math.max(x0, c.left),
          Math.min(x1, c.right),
          Math.max(y0, c.top),
          Math.min(y1, c.bottom),
        ];
      }
      if (x1 - x0 < 1 || y1 - y0 < 1) continue;
      checked += 1;
      // Side insets: the 현황판's own content only (the office and its card
      // bar are upstream's).
      const inPanel = !!el.closest('[aria-label="현황판 화면"]');
      const hits = [
        y0 < ins.top && 'top',
        y1 > H - ins.bottom && 'bottom',
        inPanel && x0 < ins.left && 'left',
        inPanel && x1 > W - ins.right && 'right',
      ].filter(Boolean);
      if (hits.length) {
        const what = (el.textContent ?? '').trim().slice(0, 24) || el.tagName;
        out.push(
          `${hits.join('+')}: <${el.tagName.toLowerCase()}> "${what}" x ${Math.round(x0)}-${Math.round(x1)} y ${Math.round(y0)}-${Math.round(y1)}`,
        );
      }
    }
    return { checked, out };
  }, INSETS);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const H = home;
  // The roster: eight engine projects in three rooms; four were on, so the engine revives them.
  const folders = Object.fromEntries(ROWS.map((n) => [n, path.join(home, 'work', n)]));
  for (const f of Object.values(folders)) fs.mkdirSync(f, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify(
      ROWS.map((name) => ({
        name,
        folder: folders[name],
        room: ROOMS[name],
        wantRunning: LIVE.includes(name),
      })),
    ),
  );
  // alpha is a git repository with a commit and two files not committed: the local 프로젝트 현황.
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
      { cwd: folders.alpha, stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(folders.alpha, 'train.py'), 'print(1)\n');
  git('add', 'train.py');
  git('commit', '-q', '-m', 'train: cosine lr');
  const commitHash = git('rev-parse', 'HEAD').trim().slice(0, 7);
  fs.writeFileSync(path.join(folders.alpha, 'a.txt'), 'x\n');
  fs.writeFileSync(path.join(folders.alpha, 'b.txt'), 'x\n');
  // What the 최근 활동 of alpha shows: the engine's own event file, read at start.
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  fs.writeFileSync(
    path.join(configDirectory(home), 'events.jsonl'),
    [
      { type: 'orch_start', ts: ago(30), source: 'engine', name: 'alpha', resumed: true },
      { type: 'job_start', ts: ago(20), source: 'cli', project: 'alpha', id: 'j-1', label: '학습' },
      { type: 'codex_start', ts: ago(10), source: 'cli', project: 'alpha', id: 'c-1' },
    ]
      .map((e) => `${JSON.stringify({ v: 1, ...e })}\n`)
      .join(''),
  );
  // The claude-dashboard plugin: the top bar's usage strip.
  const plugin = path.join(
    home,
    '.claude/plugins/cache/claude-dashboard/claude-dashboard/9.9.9/dist/check-usage.js',
  );
  fs.mkdirSync(path.dirname(plugin), { recursive: true });
  fs.writeFileSync(
    plugin,
    `const at = (h) => new Date(Date.now() + h * 3600_000).toISOString();
console.log(JSON.stringify({
  claude: { fiveHourPercent: 42, sevenDayPercent: 16, fiveHourReset: at(2), sevenDayReset: at(60) },
  codex: { fiveHourPercent: 35, sevenDayPercent: 6, fiveHourReset: at(3), sevenDayReset: at(100) },
}));\n`,
  );
  const fake = { home, claudePath: path.join(bin, 'claude') };
  const daemon = startDaemon(fake, port, ['--engine', 'on', '--no-terminal', '--allow-actions'], {
    FAKE_TURN_MS: '600',
  });
  const { child: server, log: serverLog } = daemon;
  const loginUrl = daemon.loginUrl();
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  const sent: Array<Record<string, unknown>> = [];
  const reportsSeen: string[] = [];
  let browser: Browser | undefined;
  let font: Buffer | undefined;
  const open = async (opts: Parameters<Browser['newContext']>[0]) => {
    const ctx = await browser!.newContext(opts);
    await ctx.route('**/__t0029/malgun.ttf', (route) =>
      route.fulfill({ body: font, contentType: 'font/ttf' }),
    );
    const page = await ctx.newPage();
    page.on('websocket', (ws) => {
      ws.on('framereceived', (f: { payload: string | Buffer }) => {
        const text = String(f.payload);
        if (!text.startsWith('{"type":"statusOutput"')) return;
        try {
          reportsSeen.push((JSON.parse(text) as { name: string }).name);
        } catch {
          /* binary */
        }
      });
      ws.on('framesent', (f: { payload: string | Buffer }) => {
        try {
          sent.push(JSON.parse(String(f.payload)) as Record<string, unknown>);
        } catch {
          /* binary */
        }
      });
    });
    return { ctx, page };
  };
  const hangul = async (page: Page, insets?: typeof INSETS) => {
    await page.addStyleTag({ content: FONT_CSS });
    if (insets) {
      await page.addStyleTag({
        content: `:root { ${Object.entries(insets)
          .map(([edge, px]) => `--cld-safe-${edge}: ${px}px !important;`)
          .join(' ')} }
          .t0029-strip { position: fixed; z-index: 2147483647; pointer-events: none; background: rgba(255, 0, 64, 0.3); }`,
      });
      await page.evaluate((ins) => {
        for (const [edge, px] of Object.entries(ins)) {
          const strip = document.createElement('div');
          strip.className = 't0029-strip';
          const across = edge === 'top' || edge === 'bottom';
          strip.style.cssText = across
            ? `${edge}: 0; left: 0; right: 0; height: ${px}px;`
            : `${edge}: 0; top: 0; bottom: 0; width: ${px}px;`;
          document.body.append(strip);
        }
      }, insets);
    }
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
  };
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const views = () =>
    sent
      .filter((m) => m.type === 'statusView')
      .map((m) => `${String(m.name)} ${m.on ? 'on' : 'off'}`);
  const reports = () => reportsSeen.filter((n) => n === 'alpha');

  try {
    font = fs.readFileSync(FONT);
    const login = await loginUrl;
    // The engine revives the four projects that were on, 2 s apart.
    const sessions = path.join(home, '.claude/sessions');
    type Sess = { pid: number; sessionId: string; cwd: string; name: string };
    const sessionFile = (name: string): [string, Sess] | null => {
      for (const f of fs.readdirSync(sessions)) {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8')) as Sess;
          if (s.name === name) return [path.join(sessions, f), s];
        } catch {
          /* being written */
        }
      }
      return null;
    };
    for (const end = Date.now() + 40_000; LIVE.some((n) => !sessionFile(n));) {
      if (Date.now() > end) throw new Error('the engine did not revive the sessions');
      await new Promise((r) => setTimeout(r, 300));
    }
    // alpha and eta are in a turn that has used no tool yet: 🤔 생각 중.
    for (const n of ['alpha', 'eta']) {
      const [file, s] = sessionFile(n)!;
      fs.writeFileSync(file, JSON.stringify({ ...s, status: 'busy', statusUpdatedAt: Date.now() }));
    }
    const health = await hostHealth(port, fake.home);
    check(
      health.pid === server.pid,
      `port ${port} answers for this run's server (pid ${server.pid})`,
    );
    browser = await launchBrowser();

    // ── Desktop ──
    const { ctx: desk, page } = await open({
      // Taller than before: the engine's 추가 buttons take two lines above the tree.
      viewport: { width: 1280, height: 960 },
      deviceScaleFactor: 1,
    });
    await page.goto(login);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await openOfficeWindow(page); // T-0108: a desktop starts with icons only
    await hangul(page);
    const drawer = page.getByRole('complementary', { name: '사무실 정보' });
    const card = (name: string, scope: Locator = drawer) =>
      scope
        .locator('article')
        .filter({ has: scope.page().getByRole('heading', { name, exact: true }) });
    const head = (name: string, scope: Locator = drawer) =>
      card(name, scope).getByRole('button', { name, exact: true });
    const room = (name: string, scope: Locator = drawer) =>
      scope
        .locator('section')
        .filter({ has: scope.page().getByRole('heading', { level: 2, name, exact: true }) });
    const roomHead = (name: string, scope: Locator = drawer) =>
      room(name, scope).getByRole('heading', { level: 2 }).getByRole('button');
    const expanded = async (button: Locator) =>
      (await button.getAttribute('aria-expanded')) === 'true';
    const shownRows = (scope: Locator = drawer) =>
      scope
        .locator('article h3')
        .allTextContents()
        .then((t) => t.map((s) => s.trim()));
    const ringOf = (name: string) => card(name).getAttribute('data-ring');
    const until = async (what: () => Promise<boolean> | boolean, label: string, ms = 10_000) => {
      for (const end = Date.now() + ms; Date.now() < end && !(await what());)
        await page.waitForTimeout(100);
      check(await what(), label);
    };
    await card('alpha').waitFor();

    // Two tool calls, so 기다림 and 일하는 중 have rows of their own.
    const transcript = (name: string) => {
      const s = sessionFile(name)![1];
      const file = transcriptPath(s.cwd, s.sessionId, home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      return file;
    };
    fs.appendFileSync(
      transcript('beta'),
      `${JSON.stringify(said('tu-ask', 'AskUserQuestion', { questions: [] }))}\n`,
    );
    fs.appendFileSync(
      transcript('delta'),
      `${JSON.stringify(said('tu-read', 'Read', { file_path: '/work/delta/README.md' }))}\n${JSON.stringify(answered('tu-read'))}\n`,
    );
    await until(
      async () =>
        (await Promise.all(ROWS.map(async (n) => (await ringOf(n)) === RINGS[n]))).every(Boolean),
      `rings as the office wears them: ${ROWS.map((n) => `${n} ${RINGS[n]}`).join(', ')}`,
      20_000,
    );
    await page.waitForTimeout(800);

    // The default tree: rooms open, every orchestrator folded to its look.
    const all = await shownRows();
    check(
      JSON.stringify(all) === JSON.stringify(ROWS),
      `every orchestrator listed, room by room (${all.join(', ')})`,
    );
    for (const r of ['orch-alpha', 'orch-beta', 'orch-gamma'])
      check(await expanded(roomHead(r)), `room ${r} starts open`);
    check(
      (await Promise.all(all.map((n) => expanded(head(n))))).every((e) => !e),
      'every orchestrator starts folded',
    );
    check((await page.getByText('상태 보기').count()) === 0, 'no 상태 보기 button anywhere');
    const alpha = card('alpha');
    check(
      (await alpha.innerText()).includes('🤔 생각 중') &&
        (await alpha.getByText('엔진', { exact: true }).count()) === 1 &&
        (await alpha.locator('[data-ring="working"] canvas').count()) === 1,
      'folded alpha: name, 엔진 badge, ring colour and its EZ line',
    );
    check(
      (await card('beta').innerText()).includes('✋ 사장님 답을 기다림') &&
        (await card('delta').innerText()).includes('📖 자료 읽는 중') &&
        (await card('gamma').innerText()).includes('💤 꺼져 있음'),
      'folded lines: beta asks, delta reads, gamma is off',
    );
    check(
      (await alpha.getByRole('button', { name: '저장소' }).count()) === 0 &&
        (await alpha.getByText('지금 하는 일').count()) === 0,
      'a folded orchestrator hides its details and buttons',
    );
    await shot(page, 'desktop-tree');
    const list = drawer.locator('.overflow-y-auto');
    const fit = await list.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const bottom = Math.min(box.bottom, window.innerHeight);
      return [...el.querySelectorAll('article')]
        .filter((a) => a.querySelector('[data-ring]'))
        .map((a) => {
          const r = a.getBoundingClientRect();
          return {
            name: a.querySelector('h3')?.textContent ?? '',
            in: r.top >= box.top && r.bottom <= bottom,
          };
        });
    });
    check(
      ROWS.every((n) => fit.find((f) => f.name === n)?.in),
      `PC: all eight folded orchestrators on one screen without scrolling (${
        fit
          .filter((f) => !f.in)
          .map((f) => f.name)
          .join(', ') || 'none cut off'
      })`,
    );

    // A room folds to its summary and worst badge.
    await roomHead('orch-alpha').click();
    const folded = async (name: string) => ({
      counts: (await room(name).getByTestId('room-summary').innerText()).trim(),
      worst: (await room(name).getByTestId('room-worst').innerText()).trim(),
      ring: await room(name)
        .getByTestId('room-worst')
        .locator('[data-ring]')
        .getAttribute('data-ring'),
      line: Math.round((await room(name).getByTestId('room-summary').boundingBox())!.height),
    });
    await room('orch-alpha').getByTestId('room-summary').waitFor();
    const fa = await folded('orch-alpha');
    check(
      fa.counts === '일하는 중 1 · 기다림 1 · 꺼짐 1' &&
        fa.worst === '답을 기다림' &&
        fa.ring === 'waiting' &&
        fa.line < 30 &&
        (await card('alpha').count()) === 0,
      `orch-alpha folded: "${fa.counts}" on one line (${fa.line} px), worst badge ${fa.worst} (${fa.ring})`,
    );
    await roomHead('orch-beta').click();
    const fb = await folded('orch-beta');
    check(
      fb.counts === '일하는 중 1 · 기다림 0 · 꺼짐 2' &&
        fb.worst === '일하는 중' &&
        fb.ring === 'working',
      `orch-beta folded: "${fb.counts}", worst badge ${fb.worst} (${fb.ring})`,
    );
    await shot(page, 'desktop-rooms-folded');
    await roomHead('orch-beta').click();
    await roomHead('orch-alpha').click();
    await card('alpha').waitFor();
    check(views().length === 0, 'folding and unfolding rooms sends no statusView');

    // An orchestrator opens: its sections, with 프로젝트 현황 still closed.
    await head('alpha').click();
    const status = alpha.getByRole('button', { name: /^프로젝트 현황/ });
    await status.waitFor();
    const body = await alpha.innerText();
    check(
      body.includes('지금 하는 일') &&
        body.includes('🤔 생각 중') &&
        body.includes('최근 활동') &&
        body.includes('alpha 이어서 시작') &&
        body.includes('학습을 시작했어요') &&
        body.includes('Codex 작업을 시작했어요'),
      "open alpha: 지금 하는 일 (EZ) and 최근 활동 from the engine's event feed",
    );
    check(
      (await status.innerText()).replace(/\s+/g, ' ').includes(`프로젝트 현황 — ${HEAD}`) &&
        !(await expanded(status)),
      `the section explains itself: "프로젝트 현황 — ${HEAD}", closed`,
    );
    check(
      (await alpha.getByRole('button', { name: '작업실', exact: true }).count()) === 1 &&
        (await alpha.getByRole('button', { name: '끄기', exact: true }).count()) === 1 &&
        (await alpha.getByRole('button', { name: '설정', exact: true }).count()) === 1,
      "open alpha: 작업실 and the engine's buttons behind --allow-actions",
    );
    await page.waitForTimeout(500);
    check(views().length === 0, 'opening an orchestrator sends no statusView');

    // 프로젝트 현황 open: one statusView on, the report shows; closed: one off.
    const reportsBefore = reports().length;
    await status.click();
    await alpha.getByText('돌고 있는 작업 없음').waitFor();
    check(
      JSON.stringify(views()) === JSON.stringify(['alpha on']),
      `opening 프로젝트 현황: exactly one statusView on (${views().join(', ')})`,
    );
    const shownStatus = await alpha.innerText();
    check(
      shownStatus.includes('브랜치 main · 변경 2건') &&
        shownStatus.includes(`${commitHash} train: cosine lr`),
      "the local report: the engine's jobs, branch, changes and the latest commit",
    );
    await shot(page, 'desktop-project-status');
    await until(
      () => reports().length >= reportsBefore + 2,
      'the report is read again 10 s later while it stays open',
      15_000,
    );
    await status.click();
    await alpha.getByText('돌고 있는 작업 없음').waitFor({ state: 'detached' });
    await page.waitForTimeout(300);
    check(
      JSON.stringify(views()) === JSON.stringify(['alpha on', 'alpha off']),
      `closing it: exactly one statusView off (${views().join(', ')})`,
    );
    const reportsAtClose = reports().length;
    await page.waitForTimeout(11_500);
    check(
      reports().length === reportsAtClose,
      `closed: no more reports (${reportsAtClose} in all)`,
    );

    // Open, then fold the orchestrator, then the room: off each time.
    await status.click();
    await alpha.getByText('돌고 있는 작업 없음').waitFor();
    await head('alpha').click();
    await status.waitFor({ state: 'detached' });
    await page.waitForTimeout(300);
    check(
      views().slice(2).join(', ') === 'alpha on, alpha off',
      `folding alpha with 프로젝트 현황 open turns statusView off (${views().slice(2).join(', ')})`,
    );
    await head('alpha').click();
    await status.waitFor();
    check(!(await expanded(status)), '프로젝트 현황 starts closed again when alpha reopens');
    await status.click();
    await alpha.getByText('돌고 있는 작업 없음').waitFor();
    await roomHead('orch-alpha').click();
    await card('alpha').waitFor({ state: 'detached' });
    await page.waitForTimeout(300);
    check(
      views().slice(4).join(', ') === 'alpha on, alpha off',
      `folding its room turns it off too (${views().slice(4).join(', ')})`,
    );
    await roomHead('orch-alpha').click();
    await card('alpha').waitFor();
    check(
      (await expanded(head('alpha'))) && !(await expanded(status)),
      'alpha stays open with its room; 프로젝트 현황 does not reopen by itself',
    );
    check(views().length === 6, 'no statusView besides the ones asked for');

    // 모두 펼치기 / 모두 접기.
    await drawer.getByRole('button', { name: '모두 펼치기', exact: true }).click();
    check(
      (await Promise.all((await shownRows()).map((n) => expanded(head(n))))).every(Boolean) &&
        (await shownRows()).length === ROWS.length,
      '모두 펼치기 opens every room and orchestrator',
    );
    await shot(page, 'desktop-all-open');
    await drawer.getByRole('button', { name: '모두 접기', exact: true }).click();
    check(
      (await drawer.locator('article').count()) === 0 &&
        (await drawer.getByTestId('room-summary').count()) === 3,
      '모두 접기 folds every room to its summary line',
    );
    check(views().length === 6, 'and neither sends statusView');
    await shot(page, 'desktop-all-folded');
    await drawer.getByRole('button', { name: '모두 펼치기', exact: true }).click();

    // The filter chips.
    const chip = (label: string) =>
      drawer.getByRole('group', { name: '필터' }).getByRole('button', { name: label, exact: true });
    const filtered = async (label: string, want: string[]) => {
      await chip(label).click();
      await page.waitForTimeout(150);
      const rows = await shownRows();
      check(
        (await chip(label).getAttribute('aria-pressed')) === 'true' &&
          JSON.stringify(rows) === JSON.stringify(want),
        `filter ${label}: ${rows.join(', ') || '(none)'}`,
      );
    };
    await filtered('일하는 중', ['alpha', 'delta', 'eta']);
    await filtered('기다림', ['beta']);
    await shot(page, 'desktop-filter-waiting');
    await filtered('꺼짐', ['gamma', 'epsilon', 'zeta', 'theta']);
    check((await drawer.getByText('운영', { exact: true }).count()) === 0, '운영 only under 전체');
    await filtered('전체', ROWS);

    // EZ is the only mode: no toggle; the tool's own words are the line's tooltip.
    check(
      (await page.getByRole('button', { name: 'EZ', exact: true }).count()) === 0,
      'no EZ button',
    );
    check(
      (await card('delta').locator('[title="Reading README.md"]').count()) > 0 &&
        (await card('delta').innerText()).includes('📖 자료 읽는 중'),
      'folded delta reads 📖 자료 읽는 중, its tooltip "Reading README.md"',
    );

    // Kept across a reload: one room folded, one orchestrator open, a filter.
    await drawer.getByRole('button', { name: '모두 접기', exact: true }).click();
    await roomHead('orch-alpha').click();
    await head('beta').click();
    await chip('기다림').click();
    const before = await drawer.innerText();
    const stored = await page.evaluate(() => localStorage.getItem('cld.status-tree'));
    await page.reload();
    await hangul(page);
    await card('beta').waitFor();
    await page.waitForTimeout(800);
    check(
      (await chip('기다림').getAttribute('aria-pressed')) === 'true' &&
        (await expanded(head('beta'))) &&
        (await drawer.getByTestId('room-summary').count()) === 0 &&
        JSON.stringify(await shownRows()) === JSON.stringify(['beta']),
      `after a reload: the filter, the open room and the open beta are as left (${stored})`,
    );
    check(
      (await drawer.innerText()).replace(/\d+분 전|방금/g, '') ===
        before.replace(/\d+분 전|방금/g, ''),
      'the panel reads the same after the reload',
    );
    await chip('전체').click();
    await page.waitForTimeout(300);
    check(
      (await roomHead('orch-beta').getAttribute('aria-expanded')) === 'false' &&
        (await room('orch-beta').getByTestId('room-summary').count()) === 1,
      'the other rooms are still folded after the reload',
    );
    await shot(page, 'desktop-after-reload');

    // The usage strip (T-0029 addition): folds to one line, kept across a
    // reload; a click on the line unfolds it.
    const foldUsage = page.getByRole('button', { name: '사용량 접기', exact: true });
    const foldedUsage = page.getByTestId('usage-folded');
    const countdowns = () => page.getByText(/뒤 초기화|곧 초기화/).count();
    const usageLine = async () => (await foldedUsage.innerText()).replace(/\s+/g, ' ').trim();
    check(
      (await foldUsage.getAttribute('aria-expanded')) === 'true' && (await countdowns()) > 0,
      'the usage strip starts open, with its reset countdowns',
    );
    await foldUsage.click();
    await foldedUsage.waitFor();
    check(
      (await usageLine()) === 'Claude 5h 42% · 7d 16% Codex 5h 35% · 7d 6%' &&
        (await countdowns()) === 0 &&
        (await foldedUsage.getAttribute('aria-expanded')) === 'false' &&
        Math.round((await foldedUsage.boundingBox())!.height) < 30,
      `usage folded: one line "${await usageLine()}", both figures each, no countdowns`,
    );
    await shot(page, 'desktop-usage-folded');
    await page.reload();
    await hangul(page);
    await foldedUsage.waitFor();
    check(
      (await page.evaluate(() => localStorage.getItem('cld.usage-folded'))) === '1' &&
        (await countdowns()) === 0,
      'usage: still folded after a reload',
    );
    await foldedUsage.click();
    await foldUsage.waitFor();
    await page.reload();
    await hangul(page);
    await foldUsage.waitFor();
    check(
      (await foldedUsage.count()) === 0 && (await countdowns()) > 0,
      'usage: a click on the line unfolds it, kept across a reload',
    );

    // ── Phone with iPhone Home-Screen insets: the same tree, by finger ──
    const { ctx: phoneCtx, page: phone } = await open({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    await phoneCtx.addCookies(await desk.cookies());
    await phone.goto(`http://127.0.0.1:${port}/`);
    await hangul(phone, INSETS);
    await phone
      .locator('[data-hud-id^="icon:"]')
      .getByRole('button', { name: '현황판', exact: true })
      .tap();
    const panel = phone.getByLabel('현황판 화면');
    await card('alpha', panel).waitFor();
    await phone.waitForTimeout(800);
    check(
      (await expanded(roomHead('orch-alpha', panel))) && !(await expanded(head('alpha', panel))),
      'phone: a fresh device starts from the defaults (rooms open, orchestrators folded)',
    );
    await shot(phone, 'phone-tree');
    const tall = async (loc: Locator, what: string) => {
      const heights = await loc.evaluateAll((els) =>
        els.map((el) => Math.round(el.getBoundingClientRect().height)),
      );
      check(
        heights.length > 0 && heights.every((h) => h >= 44),
        `phone: ${what} at least 44 px tall (${heights.join(', ')})`,
      );
    };
    await tall(
      panel.getByRole('button', { name: /^모두 (펼치기|접기)$/ }),
      '모두 펼치기 / 모두 접기',
    );
    await tall(panel.getByRole('group', { name: '필터' }).getByRole('button'), 'the filter chips');
    await tall(
      panel.locator('section:has(> div h2) > div > div.cursor-pointer'),
      'every room head',
    );
    await tall(panel.locator('article > div:first-child'), 'every folded orchestrator');
    const strips = await stripViolations(phone);
    check(
      strips.checked > 0 && strips.out.length === 0,
      `phone: nothing in the inset strips, the panel inside the side insets (${strips.checked} on-screen elements)${strips.out.map((l) => `\n  ${l}`).join('')}`,
    );
    await head('alpha', panel).tap();
    const pstatus = card('alpha', panel).getByRole('button', { name: /^프로젝트 현황/ });
    await pstatus.scrollIntoViewIfNeeded();
    await tall(pstatus, '프로젝트 현황');
    const phoneViews = views().length;
    await pstatus.tap();
    await card('alpha', panel).getByText('돌고 있는 작업 없음').waitFor();
    await card('alpha', panel).getByText('돌고 있는 작업 없음').scrollIntoViewIfNeeded();
    await phone.waitForTimeout(300);
    await shot(phone, 'phone-project-status');
    const pstrips = await stripViolations(phone);
    check(
      pstrips.out.length === 0,
      `phone: alpha open with its report, still clear of the insets${pstrips.out.map((l) => `\n  ${l}`).join('')}`,
    );
    await pstatus.tap();
    await phone.waitForTimeout(300);
    check(
      views().slice(phoneViews).join(', ') === 'alpha on, alpha off',
      `phone: tapping 프로젝트 현황 open and closed sends on, then off (${views().slice(phoneViews).join(', ')})`,
    );
    await panel.getByRole('button', { name: '모두 접기', exact: true }).tap();
    await phone.waitForTimeout(300);
    await shot(phone, 'phone-all-folded');

    // The usage line on the phone (U-45): alone at the bottom, folded until the viewer
    // opens it; a tap opens it, its fold button folds it again, and the choice survives
    // a reload. Its tap areas stay 44 px and nothing of it reaches the insets.
    const pfold = phone.getByRole('button', { name: '사용량 접기', exact: true });
    const pfolded = phone.locator('[data-testid="mobile-bottom"] [data-testid="usage-folded"]');
    await pfolded.waitFor();
    check(
      (await pfold.count()) === 0 &&
        (await phone.locator('div.pixel-panel').filter({ has: pfolded }).count()) === 0 &&
        (await pfolded.innerText()).replace(/\s+/g, ' ').trim() ===
          'Claude 5h 42% · 7d 16% Codex 5h 35% · 7d 6%',
      'phone: the usage line sits folded at the bottom: "Claude 5h 42% · 7d 16% Codex 5h 35% · 7d 6%"',
    );
    // The tap area is what a finger reaches, not the drawing: how far the button answers hits.
    const hitHeight = (loc: Locator) =>
      loc.evaluate((el) => {
        const button = el.closest('button')!;
        const r = button.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        let up = 0;
        while (up < 80 && document.elementFromPoint(cx, cy - up - 1)?.closest('button') === button)
          up++;
        let down = 0;
        while (
          down < 80 &&
          document.elementFromPoint(cx, cy + down + 1)?.closest('button') === button
        )
          down++;
        return up + down + 1;
      });
    const reach = await hitHeight(pfolded);
    check(reach >= 44, `phone: the folded usage line's tap area is at least 44 px tall (${reach})`);
    const ustrips = await stripViolations(phone);
    check(
      ustrips.out.length === 0,
      `phone: the folded usage line clears the insets${ustrips.out.map((l) => `\n  ${l}`).join('')}`,
    );
    await shot(phone, 'phone-usage-folded');
    await pfolded.tap();
    await pfold.waitFor();
    await phone.waitForTimeout(300);
    check((await pfolded.count()) === 0, 'phone: a tap on the line unfolds it');
    const openReach = await hitHeight(pfold);
    check(
      openReach >= 44,
      `phone: the usage fold button's tap area is at least 44 px tall (${openReach})`,
    );
    const ostrips = await stripViolations(phone);
    check(
      ostrips.out.length === 0,
      `phone: the open usage line clears the insets${ostrips.out.map((l) => `\n  ${l}`).join('')}`,
    );
    await shot(phone, 'phone-usage-open');
    await pfold.tap();
    await pfolded.waitFor();
    await phone.reload();
    await hangul(phone, INSETS);
    await pfolded.waitFor();
    check((await pfold.count()) === 0, 'phone: usage still folded after a reload');

    fs.writeFileSync(
      path.join(OUT, 'ws-status-views.json'),
      `${JSON.stringify(views(), null, 1)}\n`,
    );
  } finally {
    await browser?.close();
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((r) => server.once('exit', r));
      server.kill('SIGTERM');
      const force = setTimeout(() => server.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(force);
    }
    clearTimeout(deadline);
    fs.writeFileSync(
      path.join(OUT, 'server-log.txt'),
      serverLog
        .join('')
        .replaceAll(home, '<fake-home>')
        .replace(/code=[^\s&]+/g, 'code=<redacted>'),
    );
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
