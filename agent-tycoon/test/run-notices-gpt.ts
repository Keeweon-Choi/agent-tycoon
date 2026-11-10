/**
 * A4 capture: the 알림 window in the GPT mock-up's composition. dist/cli.js in a temp HOME on a spare
 * port, headless Chromium (no GPU). Seeds notices of every cause (unread and read, today and earlier)
 * into localStorage and shoots the window at 1600x1000 and 1024x700 (its default size, then maximized
 * for the filter column) and the phone page at 390x844 into agent-tycoon/artifacts/feat-notices-gpt-look/
 * (label: before | after).
 *
 *   npx tsx agent-tycoon/test/run-notices-gpt.ts <port 18780-18789 | 18890-18899> <label>
 *   (NOTICES_OUT=<dir under the repo> to shoot somewhere else)
 */
import type { BrowserContext, Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';
import { outDir, themePort, UI_THEME_INIT } from './uiTheme.js';

const port = Number(process.argv[2]);
if (!((port >= 18780 && port <= 18789) || (port >= 18890 && port <= 18899) || themePort(port)))
  throw new Error('port must be 18780-18789, 18830-18839 or 18890-18899');
const label = process.argv[3] ?? 'after';
const OUT = outDir(path.join(REPO_ROOT, process.env.NOTICES_OUT ?? 'agent-tycoon/artifacts/feat-notices-gpt-look'));
/** Emoji from Segoe UI Emoji (Windows font, read only): the headless shell has none. */
const EMOJI = '/mnt/c/Windows/Fonts/seguiemj.ttf';
const FONT_CSS = `
@font-face { font-family: 'FS Pixel Sans'; src: url('/__nb/emoji.ttf');
  unicode-range: U+2300-23FF, U+2600-27BF, U+FE0F, U+1F000-1FAFF; }`;
const MAX_MS = 180_000;

/** `lead` as a live session (a `sleep`) so it has a face in the office. */
function startLead(home: string) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = 'c0390000-0000-4000-8000-000000000002';
  const cwd = '/work/alpha';
  const dir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), '');
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId,
      cwd,
      startedAt: Date.now() - 600_000,
      procStart,
      version: '2.1.306',
      kind: 'interactive',
      name: 'lead',
      status: 'busy',
    }),
  );
  return proc;
}

function seed(lead: number, vet: number) {
  const now = Date.now();
  const min = 60_000;
  const n = (
    i: number,
    cause: string,
    agentId: number | null,
    name: string,
    text: string,
    ago: number,
    read: boolean,
    target?: unknown,
  ) => ({
    id: `nb-${i}`,
    cause,
    agentId,
    name,
    text,
    at: now - ago * min,
    read,
    ...(target ? { target } : {}),
  });
  return [
    n(
      1,
      'permission',
      lead,
      'lead',
      '허락을 기다려요 · Bash: rm -rf dist/ 를 실행해도 될까요?',
      3,
      false,
    ),
    n(2, 'question', vet, 'veteran', '질문이 있어요 · 배포 전에 스테이징부터 볼까요?', 9, false),
    n(3, 'turnEnd', lead, 'lead', '일을 마쳤어요 · 메시지가 이전 입력으로 바뀐 버그', 12, true),
    n(4, 'job', vet, 'veteran', '배포 검사가 끝났어요', 31, true, { open: 'job', id: '4242' }),
    n(5, 'job', null, 'ops', '관리 세션 이름 바꾸기 확인(최대 15분)이 실패했어요', 55, false),
    n(6, 'reply', lead, 'lead', '답장이 왔어요 · 내일 아침에 이어서 할게요', 80, false),
    n(
      7,
      'turnEnd',
      vet,
      'veteran',
      '일을 마쳤어요 · 설치 이름 바꾸기와 삭제 정리 + 순환 import 고침',
      130,
      true,
    ),
    n(
      8,
      'turnEnd',
      lead,
      'lead',
      '일을 마쳤어요 · 배포 검사·설치 이름 바꾸기·삭제 정리 + 순환 import 고침과 다음 단계 계획까지 정리해서 보고',
      26 * 60,
      true,
    ),
    n(9, 'job', vet, 'veteran', '야간 백업이 끝났어요', 27 * 60, true, { open: 'job', id: '4100' }),
    n(10, 'question', vet, 'veteran', '질문이 있어요', 3 * 24 * 60, true),
    // A Codex run that ended: the same kind as a Claude run's end (#3), its agent only in the meta line.
    n(11, 'job', vet, 'codex-worker', '일을 마쳤어요 · 로그인 시험 정리', 20, true, {
      open: 'codex',
      id: 'cx1',
    }),
  ];
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const vetDir = path.join(home, 'work', 'veteran');
  fs.mkdirSync(vetDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify([{ name: 'veteran', folder: vetDir, wantRunning: false }]),
  );
  const proc = startLead(home);
  const started = startDaemon({ home, claudePath }, port, ['--no-terminal', '--engine', 'on']);
  const daemon = started.child;
  const emoji = fs.existsSync(EMOJI) ? fs.readFileSync(EMOJI) : null;
  const browser = await launchBrowser();
  const timer = setTimeout(() => {
    console.error('capture timed out');
    process.exit(1);
  }, MAX_MS);
  const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;' + UI_THEME_INIT);
    if (emoji)
      await ctx.route('**/__nb/emoji.ttf', (route) =>
        route.fulfill({ body: emoji, contentType: 'font/ttf' }),
      );
    return { ctx, page: await ctx.newPage() };
  };
  const ready = async (page: Page) => {
    if (emoji) await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("18px 'FS Pixel Sans'", 'a가🔔'));
    await page.waitForFunction(
      () => {
        const t = [...document.querySelectorAll('[data-testid="agent-name"]')].map(
          (x) => x.textContent,
        );
        return t.includes('lead') && t.includes('veteran');
      },
      undefined,
      { timeout: 25_000 },
    );
    const close = page.getByRole('button', { name: '정보 창 닫기' });
    if (await close.count()) await close.click();
  };
  try {
    const loginUrl = await started.loginUrl();
    let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
    const shots = [
      { kind: 'phone', w: 390, h: 844 },
      { kind: 'pc1600', w: 1600, h: 1000 },
      { kind: 'pc1024', w: 1024, h: 700 },
    ] as const;
    for (const { kind, w, h } of shots) {
      const phone = kind === 'phone';
      const { ctx, page } = await open(
        phone
          ? {
              viewport: { width: w, height: h },
              isMobile: true,
              hasTouch: true,
              deviceScaleFactor: 2,
            }
          : { viewport: { width: w, height: h }, deviceScaleFactor: 1 },
      );
      if (cookies.length === 0) {
        await page.goto(loginUrl);
        await page.waitForURL(`http://127.0.0.1:${port}/`);
        cookies = await ctx.cookies();
      } else {
        await ctx.addCookies(cookies);
        await page.goto(`http://127.0.0.1:${port}/`);
      }
      await ready(page);
      const ids = await page.evaluate(() => {
        const m: Record<string, number> = {};
        for (const el of document.querySelectorAll('[data-testid="agent-name"]')) {
          const id = el.closest('[data-agent-id]')?.getAttribute('data-agent-id');
          if (id !== undefined && id !== null) m[el.textContent ?? ''] = Number(id);
        }
        return m;
      });
      if (ids.lead === undefined || ids.veteran === undefined)
        throw new Error(`agent ids: ${JSON.stringify(ids)}`);
      await page.evaluate(
        (items) => localStorage.setItem('agty.notices', JSON.stringify(items)),
        seed(ids.lead, ids.veteran),
      );
      await page.reload();
      await ready(page);
      // The PC has no corner bell: the control center's notifications target opens and folds the panel (the phone's tab keeps the bell).
      const bell = page.locator(phone ? '[data-testid="notice-bell"]' : '[data-testid="cc-seg-notices"]');
      const toastX = page.getByRole('button', { name: '닫기', exact: true });
      if (!phone) {
        // The folded control center: its one-line preview of the latest entry and the unread count.
        await page.waitForTimeout(800);
        if (await toastX.count()) await toastX.first().click();
        await page.waitForTimeout(400);
        const bar = await page.locator('[data-testid="cc-tile"]').boundingBox();
        await page.screenshot({
          path: path.join(OUT, `${label}-${kind}-folded.png`),
          clip: { x: 0, y: h - 180, width: Math.min(w, 700), height: 180 },
        });
        if (label === 'after') {
          const unreadOnBar = await page
            .locator('[data-testid="cc-seg-notices"] .cc-count')
            .textContent();
          if (unreadOnBar !== '4')
            throw new Error(`${kind}: the bar shows ${unreadOnBar} unread, not 4`);
          if (!bar || bar.width > 362)
            throw new Error(`${kind}: the folded bar is ${bar?.width} wide`);
        }
      }
      if (phone) await bell.tap();
      else await bell.click();
      await page.locator('[data-testid="notice-list"]').waitFor();
      await page.waitForTimeout(800);
      if (await toastX.count()) await toastX.first().click();
      await page.waitForTimeout(600);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      if (overflow) throw new Error(`${kind}: horizontal overflow`);
      await page.screenshot({ path: path.join(OUT, `${label}-${kind}.png`) });
      if (phone && label === 'after') {
        await page.locator('[data-testid="notice-filters-toggle"]').tap();
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(OUT, `${label}-phone-filters.png`) });
      }
      if (!phone && label === 'after') {
        const panel = await page.locator('[data-testid="cc-tile"]').boundingBox();
        const dock = await page.locator('[data-testid="hud-dock"]').boundingBox();
        if (!panel || !dock) throw new Error(`${kind}: no panel or dock`);
        if (panel.x + panel.width > dock.x - 4 && panel.y + panel.height > dock.y)
          throw new Error(`${kind}: the panel covers the dock`);
        if (panel.width > 760 * 0.8 + 2 || panel.height > 720 * 0.8 + 2)
          throw new Error(`${kind}: the panel is ${panel.width} x ${panel.height}, over 80 % of 760 x 720`);
        // Filters, fold, sort by importance, and the bell folds the panel again.
        await page.locator('[data-testid="notice-filter-attention"]').click();
        const attention = await page.locator('[data-testid="notice-item"]').count();
        if (attention !== 4) throw new Error(`${kind}: 확인 필요 shows ${attention}, not 4`);
        await page.locator('[data-testid="notice-filter-all"]').click();
        await page.locator('[data-testid="notice-sort"]').selectOption('importance');
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(OUT, `${label}-${kind}-importance.png`) });
        // The read cards at the foot keep their importance's hue; the column's kind rows list what happened.
        await page.locator('.nc-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
        await page.waitForTimeout(200);
        await page.screenshot({ path: path.join(OUT, `${label}-${kind}-normal.png`) });
        await page.locator('[data-testid="notice-filters-toggle"]').click();
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(OUT, `${label}-${kind}-kinds.png`) });
        await page.locator('[data-testid="notice-filters-toggle"]').click();
        await page.locator('[data-testid="notice-sort"]').selectOption('time');
        await page.locator('[data-testid="notice-group"]').first().click();
        const folded = await page.locator('[data-testid="notice-item"]').count();
        if (folded !== 3) throw new Error(`${kind}: a folded today shows ${folded} items, not 3`);
        // mark all read empties the bar's count
        await page.locator('[data-testid="notice-mark-all"]').click();
        if (await page.locator('[data-testid="notice-unread"]').count())
          throw new Error(`${kind}: unread left after mark all`);
        await bell.click();
        await page.locator('[data-testid="notice-list"]').waitFor({ state: 'detached' });
        console.log(`ok - ${kind} filters, fold, sort, mark all and the bell fold work`);
      }
      console.log(`ok - ${label} ${kind}`);
      await ctx.close();
    }
  } finally {
    clearTimeout(timer);
    await browser.close();
    if (daemon.exitCode === null) {
      daemon.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 2_000));
      if (daemon.exitCode === null) daemon.kill('SIGKILL');
    }
    proc.kill('SIGKILL');
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
