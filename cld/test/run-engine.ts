/**
 * T-0018 visual check: dist/cli.js with --engine on --allow-actions
 * in an isolated HOME whose `claude` is the engine fake (cld/test/fake-claude/
 * engine.cjs), on a spare port. Desktop: 오케스트레이터 추가 (T-0032; was 프로젝트 추가) with a folder that does
 * not exist (폴더가 없어요. 만들까요?), 켜기, 재시작 (a --resume wake), 끄기,
 * 삭제. Phone with iPhone Home-Screen insets through the --cld-safe-* vars:
 * the form, a confirmation and a running project, with T-0008's strip rule.
 * Records the daemon's RSS without and with viewers. A hard deadline and
 * SIGINT/SIGTERM/SIGHUP kill the server and the fake's sessions.
 *
 *   npx tsx cld/test/run-engine.ts <port 18256-18259>
 */
import type { Browser, Locator, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
import {
  assertPortFree,
  engineCalls,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openOfficeWindow,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0018');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0018/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 240_000;
const INSETS = { top: 59, bottom: 34 };
const SESSION_VAR = /^(CLAUDE|OFFICE_)|^TMUX/;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

const rssMb = (pid: number, field = 'VmRSS'): number => {
  const m = new RegExp(`${field}:\\s+(\\d+) kB`).exec(
    fs.readFileSync(`/proc/${pid}/status`, 'utf-8'),
  );
  return m ? Math.round(Number(m[1]) / 1024) : -1;
};

/** T-0008's rule: nothing tappable or text-bearing in an inset strip. */
function stripViolations(page: Page): Promise<{ checked: number; out: string[] }> {
  return page.evaluate((ins) => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const out: string[] = [];
    let checked = 0;
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (el.closest('[data-testid="agent-overlay"], [data-testid="ez-mood"], canvas')) continue;
      const tappable = el.matches(
        'button, a[href], input, select, textarea, [role="button"], [role="tab"]',
      );
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
      const hits = [y0 < ins.top && 'top', y1 > H - ins.bottom && 'bottom'].filter(Boolean);
      if (hits.length) {
        const what = (el.textContent ?? '').trim().slice(0, 24) || el.tagName;
        out.push(
          `${hits.join('+')}: <${el.tagName.toLowerCase()}> "${what}" y ${Math.round(y0)}-${Math.round(y1)}`,
        );
      }
    }
    return { checked, out };
  }, INSETS);
}

async function noStrips(page: Page, view: string): Promise<void> {
  const { checked, out } = await stripViolations(page);
  check(
    checked > 0 && out.length === 0,
    `inset strips empty (${view}, ${checked} on-screen elements)${out.map((l) => `\n  ${l}`).join('')}`,
  );
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  // Our own temp HOME: its daemon's port is the spare one, never the live daemon's.
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/config.json'),
    JSON.stringify({ accessChosen: true, port }),
  );
  const daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, [
    '--engine',
    'on',
    '--no-terminal',
    '--allow-actions',
  ]);
  const { child: server, log: serverLog } = daemon;
  const loginUrl = daemon.loginUrl();
  const cleanupHome = () => {
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  };
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    cleanupHome();
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  const sent: Array<Record<string, unknown>> = [];
  const received: Array<Record<string, unknown>> = [];
  const rss: Record<string, number> = {};
  let browser: Browser | undefined;
  let font: Buffer | undefined;
  const open = async (opts: Parameters<Browser['newContext']>[0]) => {
    const ctx = await browser!.newContext(opts);
    // T-0029: the 현황판 folds rooms and orchestrators; these checks press
    // buttons inside the cards, so a fresh profile starts with all open (모두 펼치기).
    await ctx.addInitScript(() => {
      if (!localStorage.getItem('cld.status-tree'))
        localStorage.setItem('cld.status-tree', '{"rooms":true,"orchs":true}');
    });
    await ctx.route('**/__t0018/malgun.ttf', (route) =>
      route.fulfill({ body: font, contentType: 'font/ttf' }),
    );
    const page = await ctx.newPage();
    page.on('websocket', (ws) => {
      const log = (into: typeof sent) => (f: { payload: string | Buffer }) => {
        try {
          into.push(JSON.parse(String(f.payload)) as Record<string, unknown>);
        } catch {
          /* binary */
        }
      };
      ws.on('framesent', log(sent));
      ws.on('framereceived', log(received));
    });
    return { ctx, page };
  };
  const hangul = async (page: Page, insets?: typeof INSETS) => {
    await page.addStyleTag({ content: FONT_CSS });
    if (insets) {
      await page.addStyleTag({
        // This injected test overlay deliberately distinguishes the unsafe area from app UI.
        // eslint-disable-next-line pixel-agents/no-inline-colors
        content: `:root { --cld-safe-top: ${insets.top}px !important; --cld-safe-bottom: ${insets.bottom}px !important; }
          .t0018-strip { position: fixed; left: 0; right: 0; z-index: 2147483647; pointer-events: none; background: rgba(255, 0, 64, 0.3); }`,
      });
      await page.evaluate((ins) => {
        for (const [edge, px] of Object.entries(ins)) {
          const strip = document.createElement('div');
          strip.className = 't0018-strip';
          strip.style.cssText = `${edge}: 0; height: ${px}px;`;
          document.body.append(strip);
        }
      }, insets);
    }
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
  };
  const card = (scope: Locator, page: Page, name: string) =>
    scope.locator('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const engineActions = () => sent.filter((m) => m.type === 'engineAction');
  const lastState = () =>
    [...received].reverse().find((m) => m.type === 'engineState') as
      { projects: Array<{ name: string; sessionId?: string; bgId?: string }> } | undefined;
  const sessionCalls = () =>
    engineCalls(home).filter((c) => c.argv[0] === '--bg' || c.argv[0] === 'stop');
  const toast = (page: Page, text: string) =>
    page.getByRole('status').filter({ hasText: text }).waitFor({ timeout: 15_000 });

  try {
    font = fs.readFileSync(FONT);
    await loginUrl;
    await new Promise((r) => setTimeout(r, 4_000));
    rss.noViewer = rssMb(server.pid!);
    browser = await launchBrowser();

    // ── Desktop ──
    const { ctx: desk, page } = await open({
      viewport: { width: 1400, height: 900 },
      deviceScaleFactor: 1,
    });
    await page.goto(await loginUrl);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await openOfficeWindow(page); // T-0108: a desktop starts with icons only
    await hangul(page);
    // Without office the drawer is the office's (T-0016).
    const drawer = page.getByRole('complementary', { name: '사무실 정보' });
    const addButton = drawer.getByRole('button', { name: '오케스트레이터 추가', exact: true });
    await addButton.waitFor();
    await addButton.click();
    const form = page.getByRole('form', { name: '오케스트레이터 추가' });
    await form.waitFor();
    const folder = path.join(home, 'projects', 'alpha-app');
    await form.getByLabel('폴더').fill(folder);
    check(
      (await form.getByLabel('이름').inputValue()) === 'alpha-app',
      'the name follows the folder until edited',
    );
    await form.getByLabel('사무실').fill('연구실');
    check(
      // LEAD-DEFAULT (d2ceb3a8): a new Lead starts with the Leads' model and effort (Opus · max).
      (await form.getByLabel('모델').inputValue()) === 'opus' &&
        (await form.getByLabel('노력').inputValue()) === 'max',
      "a new Lead's choices start at the Leads' model and effort (opus, max)",
    );
    check(
      (await form.getByLabel('모델').locator('option').allTextContents()).some((text) =>
        text.startsWith('opus'),
      ) && (await form.getByLabel('노력').locator('option').allTextContents()).includes('high'),
      'fake Claude fills the model and effort dropdowns',
    );
    await form.getByLabel('모델').selectOption('opus');
    check(
      (await form.getByLabel('모델').inputValue()) === 'opus',
      'a listed model can be selected',
    );
    await form.getByLabel('모델').selectOption('__custom__');
    await form.locator('input[placeholder="새 모델 이름"]').fill('claude-opus-next');
    await form.getByLabel('노력').selectOption('high');
    await form.getByLabel('휴식 몇 번 뒤 교대').selectOption('2');
    await form.getByRole('button', { name: /고급/ }).click();
    await shot(page, 'desktop-add-form');
    await form.getByRole('button', { name: '추가', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    check(
      (await dialog.textContent())?.includes('폴더가 없어요. 만들까요?') &&
        (await dialog.textContent())?.includes(folder),
      'a missing folder asks first, with its path',
    );
    check(!fs.existsSync(folder), 'nothing created before the answer');
    await shot(page, 'desktop-mkdir-confirm');
    await dialog.getByRole('button', { name: '만들기', exact: true }).click();
    await toast(page, '추가했어요');
    const savedAdd = engineActions().at(-1)!;
    check(
      savedAdd.model === 'claude-opus-next' &&
        savedAdd.effort === 'high' &&
        savedAdd.compactionNudge === 2,
      'custom model plus selected effort and compaction nudge save through the add action',
    );
    check(fs.statSync(folder).isDirectory(), 'the folder exists after 만들기');
    const alpha = card(drawer, page, 'alpha-app');
    await alpha.getByRole('button', { name: '켜기', exact: true }).waitFor();
    check(
      (await alpha.textContent())?.includes('엔진') &&
        (await alpha.textContent())?.includes('꺼짐'),
      'the new project card: 엔진, 꺼짐',
    );
    await shot(page, 'desktop-added');

    await alpha.getByRole('button', { name: '켜기', exact: true }).click();
    await dialog.waitFor();
    check(
      /alpha-app[을를] 켤까요\?/.test((await dialog.textContent()) ?? ''),
      'start asks in Korean (T-0010’s text)',
    );
    await shot(page, 'desktop-start-confirm');
    await dialog.getByRole('button', { name: '켜기', exact: true }).click();
    await toast(page, '켰어요');
    await alpha.getByRole('button', { name: '끄기', exact: true }).waitFor({ timeout: 15_000 });
    check(
      (await alpha.getByRole('button', { name: '재시작', exact: true }).count()) === 1,
      'running: 끄기 and 재시작',
    );
    const overlay = page.locator('[data-testid="agent-overlay"]').filter({ hasText: 'alpha-app' });
    await overlay.first().waitFor({ timeout: 15_000 });
    // The owner's call (10-24): 엔진 is a detail line now, not a badge over the plate.
    check(
      (await overlay.first().getByText('엔진', { exact: true }).count()) === 0,
      'the character carries no 엔진 badge (it is in the details)',
    );
    await page.waitForTimeout(800);
    await shot(page, 'desktop-running');
    rss.viewing = rssMb(server.pid!);

    // The conversation has a transcript once something was said: restart wakes it.
    const sid = lastState()?.projects.find((p) => p.name === 'alpha-app')?.sessionId;
    check(sid, 'engineState carries the session id');
    const t = transcriptPath(folder, sid!, home);
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(t, '{}\n');
    await alpha.getByRole('button', { name: '재시작', exact: true }).click();
    await dialog.getByRole('button', { name: '재시작', exact: true }).click();
    await toast(page, '재시작했어요');
    await shot(page, 'desktop-restarted');

    await alpha.getByRole('button', { name: '끄기', exact: true }).click();
    await dialog.waitFor();
    check(
      (await dialog.textContent())?.includes('하던 일이 멈출 수 있어요.'),
      'stop warns like T-0010',
    );
    await dialog.getByRole('button', { name: '끄기', exact: true }).click();
    await toast(page, '껐어요');
    await alpha.getByRole('button', { name: '켜기', exact: true }).waitFor({ timeout: 15_000 });
    await shot(page, 'desktop-stopped');

    await alpha.getByRole('button', { name: '삭제', exact: true }).click();
    await dialog.waitFor();
    check(
      /alpha-app[을를] 삭제할까요\?/.test((await dialog.textContent()) ?? '') &&
        (await dialog.textContent())?.includes('대화 기록은 남아요'),
      'delete says the conversation stays',
    );
    await shot(page, 'desktop-remove-confirm');
    await dialog.getByRole('button', { name: '삭제', exact: true }).click();
    await toast(page, '삭제했어요. 대화 기록은 남아요');
    await alpha.waitFor({ state: 'detached', timeout: 15_000 });
    check(fs.existsSync(t), 'the transcript is still there');
    await shot(page, 'desktop-removed');

    // ── Phone with iPhone Home-Screen insets ──
    const { page: phone } = await open({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      storageState: await desk.storageState(),
    });
    await phone.goto(`http://127.0.0.1:${port}/`);
    await hangul(phone, INSETS);
    await phone
      .locator('[data-hud-id^="icon:"]')
      .getByRole('button', { name: '현황판', exact: true })
      .click();
    const panel = phone.getByLabel('현황판 화면');
    await panel.getByRole('button', { name: '오케스트레이터 추가', exact: true }).tap();
    const pform = phone.getByRole('form', { name: '오케스트레이터 추가' });
    await pform.waitFor();
    const beta = path.join(home, 'projects', 'beta-app');
    fs.mkdirSync(beta, { recursive: true });
    await pform.getByLabel('폴더').fill('~/projects/beta-app');
    await pform.getByRole('button', { name: /고급/ }).tap();
    await phone.waitForTimeout(300);
    await shot(phone, 'phone-form');
    await noStrips(phone, 'add form');
    await pform.getByRole('button', { name: '추가', exact: true }).tap();
    await toast(phone, '추가했어요');
    const betaCard = card(panel, phone, 'beta-app');
    await betaCard.getByRole('button', { name: '켜기', exact: true }).tap();
    const pdialog = phone.getByRole('alertdialog');
    await pdialog.waitFor();
    await shot(phone, 'phone-confirm');
    await noStrips(phone, 'confirmation');
    await pdialog.getByRole('button', { name: '켜기', exact: true }).tap();
    await toast(phone, '켰어요');
    await betaCard.getByRole('button', { name: '끄기', exact: true }).waitFor({ timeout: 15_000 });
    await betaCard.scrollIntoViewIfNeeded();
    await phone.waitForTimeout(500);
    await shot(phone, 'phone-running');
    await noStrips(phone, 'running project');
    rss.viewingTwo = rssMb(server.pid!);

    // ── What ran ──
    const calls = sessionCalls();
    const ids = calls.filter((c) => c.argv[0] === 'stop').map((c) => c.argv[1]);
    check(
      JSON.stringify(calls.map((c) => c.argv.slice(0, 3))) ===
        JSON.stringify([
          ['--bg', '-n', 'alpha-app'],
          ['stop', ids[0]],
          ['--bg', '--resume', sid],
          ['stop', ids[1]],
          ['--bg', '-n', 'beta-app'],
        ]),
      `claude ran start, restart (stop + --resume alone), stop, then beta's start: ${calls.map((c) => c.argv.join(' ')).join(' | ')}`,
    );
    check(
      calls.every((c) => c.env.every((k) => !SESSION_VAR.test(k))),
      'no CLAUDE*/OFFICE_*/TMUX variable reached claude (the daemon itself has them)',
    );
    check(
      calls
        .filter((c) => c.argv[0] === '--bg')
        .every((c) => c.cwd.startsWith(path.join(home, 'projects'))),
      'each start ran in its project folder',
    );
    check(
      JSON.stringify(engineActions().map((a) => [a.action, a.name, a.mkdir ?? null])) ===
        JSON.stringify([
          ['add', 'alpha-app', null],
          ['add', 'alpha-app', true],
          ['start', 'alpha-app', null],
          ['restart', 'alpha-app', null],
          ['stop', 'alpha-app', null],
          ['remove', 'alpha-app', null],
          ['add', 'beta-app', null],
          ['start', 'beta-app', null],
        ]),
      'one engineAction per confirmation (the mkdir one only after 만들기)',
    );
    // D2: the project in projects.json v2, its agent (wantRunning, launch options) in assignments.json.
    const file = JSON.parse(
      fs.readFileSync(path.join(home, '.config/cld-gui/projects.json'), 'utf-8'),
    ) as { v: number; projects: Array<Record<string, unknown>> };
    const agents = JSON.parse(
      fs.readFileSync(path.join(home, '.config/cld-gui/assignments.json'), 'utf-8'),
    ) as { v: number; assignments: Array<Record<string, unknown>> };
    const registry = file.projects;
    const lead = agents.assignments;
    check(
      file.v === 2 &&
        registry.length === 1 &&
        /^p_[a-z2-7]{10}$/.test(String(registry[0].projectId)) &&
        registry[0].name === 'beta-app' &&
        registry[0].folder === beta &&
        agents.v === 1 &&
        lead.length === 1 &&
        lead[0].assignmentId === registry[0].leadAssignmentId &&
        lead[0].projectId === registry[0].projectId &&
        lead[0].role === 'lead' &&
        lead[0].wantRunning === true &&
        // LEAD-DEFAULT (d2ceb3a8): the Lead record carries the Leads' model and effort.
        lead[0].model === 'opus' &&
        lead[0].effort === 'max',
      'projects.json + assignments.json: beta-app only, wantRunning, the Leads\' model and effort',
    );
    rss.peak = rssMb(server.pid!, 'VmHWM');
    console.log(`rss MB: ${JSON.stringify(rss)}`);
    fs.writeFileSync(path.join(OUT, 'rss.json'), `${JSON.stringify(rss, null, 1)}\n`);
    fs.writeFileSync(
      path.join(OUT, 'ws-engine-actions.json'),
      `${JSON.stringify(engineActions(), null, 1)}\n`,
    );
    fs.writeFileSync(
      path.join(OUT, 'ws-engine-results.json'),
      `${JSON.stringify(
        received.filter((m) => m.type === 'engineActionResult'),
        null,
        1,
      )}\n`,
    );
    fs.writeFileSync(
      path.join(OUT, 'fake-claude-calls.txt'),
      `${calls.map((c) => `${c.argv.join(' ')}  (cwd ${c.cwd.replace(home, '<home>')})`).join('\n')}\n`,
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
      path.join(OUT, 'server-log.txt'), // *.log is ignored by git
      serverLog
        .join('')
        .replaceAll(home, '<fake-home>')
        .replace(/code=[^\s&]+/g, 'code=<redacted>'),
    );
    cleanupHome();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
