/**
 * NOTICE-B capture: the 알림 list (layout B) on the phone (390x844) and the PC window (1280x800).
 * dist/cli.js in a temp HOME on a spare port, headless Chromium (no GPU). Seeds notices of every
 * kind (permission, question, done, job, failed job, reply; unread and read, today and earlier)
 * into localStorage and shoots `<label>-phone.png`, `<label>-desktop.png` and `<label>-window.png`
 * (and `<label>-phone-end.png`, scrolled to the earlier days) into cld/artifacts/notice-b/
 * (label: before | after).
 *
 *   npx tsx cld/test/run-notice-b.ts <port 18268> <label>
 */
import type { BrowserContext, Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { configDirectory } from '../../server/src/cld/configPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const label = process.argv[3] ?? 'after';
const OUT = path.join(REPO_ROOT, 'cld/artifacts/notice-b');
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
    n(1, 'permission', lead, 'lead', '허락을 기다려요', 3, false),
    n(2, 'question', vet, 'veteran', '질문이 있어요 · 배포 전에 스테이징부터 볼까요?', 9, false),
    n(3, 'turnEnd', lead, 'lead', '일을 마쳤어요 · 메시지가 이전 입력으로 바뀐 버그', 12, true),
    n(4, 'job', vet, 'veteran', '배포 검사가 끝났어요', 31, true, { open: 'job', id: '4242' }),
    n(5, 'job', null, 'ops', '관리 세션 이름 바꾸기 확인(최대 15분)이 실패했어요', 55, false),
    n(6, 'reply', lead, 'lead', '답장이 왔어요 · 내일 아침에 이어서 할게요', 80, true),
    n(
      7,
      'turnEnd',
      lead,
      'lead',
      '일을 마쳤어요 · 배포 검사·설치 이름 바꾸기·삭제 정리 + 순환 import 고침과 다음 단계 계획까지 정리해서 보고',
      26 * 60,
      true,
    ),
    n(8, 'job', vet, 'veteran', '야간 백업이 끝났어요', 27 * 60, true, { open: 'job', id: '4100' }),
    n(9, 'question', vet, 'veteran', '질문이 있어요', 3 * 24 * 60, true),
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
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;');
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
    for (const kind of ['phone', 'desktop'] as const) {
      const phone = kind === 'phone';
      const { ctx, page } = await open(
        phone
          ? {
              viewport: { width: 390, height: 844 },
              isMobile: true,
              hasTouch: true,
              deviceScaleFactor: 2,
            }
          : { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
      );
      if (phone) {
        await page.goto(loginUrl);
        await page.waitForURL(`http://127.0.0.1:${port}/`);
      } else {
        await ctx.addCookies(cookies);
        await page.goto(`http://127.0.0.1:${port}/`);
      }
      await ready(page);
      cookies = await ctx.cookies();
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
        (items) => localStorage.setItem('cld.notices', JSON.stringify(items)),
        seed(ids.lead, ids.veteran),
      );
      await page.reload();
      await ready(page);
      const bell = page.locator('[data-testid="notice-bell"], [data-testid="cc-seg-notices"]');
      if (phone) await bell.tap();
      else await bell.click();
      await page.locator('[data-testid="notice-list"]').waitFor();
      await page.waitForTimeout(800);
      // The "updated" toast covers the page header: its x first.
      const toastX = page.getByRole('button', { name: '닫기', exact: true });
      if (await toastX.count()) await toastX.first().click();
      await page.waitForTimeout(600);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      if (overflow) throw new Error(`${kind}: horizontal overflow`);
      await page.screenshot({ path: path.join(OUT, `${label}-${kind}.png`) });
      if (phone) {
        await page.locator('[data-testid="notice-list"] > li').last().scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(OUT, `${label}-phone-end.png`) });
      }
      if (!phone)
        await page
          .locator('[data-testid="notice-panel"]')
          .screenshot({ path: path.join(OUT, `${label}-window.png`) });
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
