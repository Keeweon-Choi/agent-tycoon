/**
 * T-0041 check: dist/cli.js with an isolated HOME on a spare port, in headless
 * Chromium (no GPU), desktop (1280x800) and phone (393x852), a fake clock in
 * the page (Playwright's clock: Date only, the game loop keeps running).
 *
 * The office: the engine project `veteran` (idle; four finished Codex tasks,
 * background jobs) and one running Codex task no orchestrator owns (외주); Claude sessions
 * `lead` and `helper` in /work/alpha (a room of 2) and b1..b6 in /work/beta (a
 * room of 6). The daemon runs on Seoul time, the pages on UTC: office hours
 * must follow the daemon.
 * - a sub-agent walks in from the door, works, lingers after its lead's turn
 *   and walks out after the linger time; the 알림 list says so;
 * - "+N" on the lead's card opens the list, a row goes to the character;
 * - 외주 gathers the unowned Codex worker; the 현황판 folds and counts;
 * - at 18:00 the idle veteran goes home (퇴근 plate, card marked) while the
 *   busy lead stays with 야근; at 09:00 the veteran comes back.
 * Screenshots go to cld/artifacts/t0041/.
 *
 *   npx tsx cld/test/run-temps.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { maskSecrets } from '../../server/src/cld/engine/jobs.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  seedCodexTask,
  seedJob,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0041');
/** U-10 / U-27 screenshots. */
const UI_OUT = path.join(REPO_ROOT, 'cld/artifacts/ui-b2');
const FONTS = {
  malgun: '/mnt/c/Windows/Fonts/malgun.ttf',
  emoji: '/mnt/c/Windows/Fonts/seguiemj.ttf',
};
const FONT_CSS = `
@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0041/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }
@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0041/emoji.ttf');
  unicode-range: U+2300-23FF, U+2600-27BF, U+FE0F, U+1F000-1FAFF; }`;
/** Host clock (Asia/Seoul, +09:00): Wednesday 2026-10-21. */
const KST = (day: number, hh: number, mm = 0) =>
  new Date(`2026-10-${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+09:00`);

type Rec = Record<string, unknown>;
const call = (id: string, name: string, input: Rec) => ({ type: 'tool_use', id, name, input });
const said = (content: Rec[]): Rec => ({
  type: 'assistant',
  message: { model: 'claude-opus-4-5', content },
});
const userResult = (id: string, text: string): Rec => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
});
const sub = (parent: string, msg: Rec): Rec => ({
  type: 'progress',
  parentToolUseID: parent,
  data: { type: 'agent_progress', message: msg },
});
const turnEnd: Rec = { type: 'system', subtype: 'turn_duration', durationMs: 1000 };

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
}

/** A live Claude Code session (a `sleep` of ours) named `name` in `cwd`; its transcript. */
function session(home: string, k: number, name: string, cwd: string) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = `c0410000-0000-4000-8000-${String(k).padStart(12, '0')}`;
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  const transcript = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(transcript, '');
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
      name,
      status: 'idle',
    }),
  );
  return { proc, transcript };
}

interface Anchor {
  id: number;
  kind: string;
  phase: string;
  x: number;
  y: number;
}
const anchors = (page: Page): Promise<Anchor[]> =>
  page.$$eval('[data-testid="status-icon-anchor"]', (nodes) =>
    nodes.map((n) => {
      const r = n.getBoundingClientRect();
      return {
        id: Number(n.getAttribute('data-agent-id')),
        kind: n.getAttribute('data-kind') ?? '',
        phase: n.getAttribute('data-phase') ?? '',
        x: r.left,
        y: r.top,
      };
    }),
  );
const names = (page: Page): Promise<string[]> =>
  page.$$eval('[data-testid="agent-name"]', (nodes) => nodes.map((n) => n.textContent ?? ''));
const cardFor = (page: Page, name: string) =>
  page.locator('[data-testid="agent-card"]').filter({
    has: page.locator('[data-testid="card-name"]', { hasText: new RegExp(`^${name}$`) }),
  });
/** The overlay of the orchestrator named `name` (its id). */
const idOf = async (page: Page, name: string): Promise<number | null> => {
  const overlay = page.locator('[data-testid="agent-overlay"]').filter({
    has: page.locator('[data-testid="agent-name"]', { hasText: new RegExp(`^${name}$`) }),
  });
  if (!(await overlay.count())) return null;
  return Number(await overlay.first().getAttribute('data-agent-id'));
};

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  // The engine: `veteran` (a project the engine revives, idle; four finished Codex tasks and eight
  // background jobs), one running Codex task no project owns (외주).
  const { home, claudePath } = makeEngineHome();
  const fake = { home };
  const vetDir = path.join(home, 'work', 'veteran');
  fs.mkdirSync(vetDir, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/projects.json'),
    JSON.stringify([{ name: 'veteran', folder: vetDir, wantRunning: true }]),
  );
  const done = (id: string, state: 'done' | 'failed', spec: string) =>
    seedCodexTask(home, {
      id,
      project: 'veteran',
      state,
      spec: path.basename(spec),
      started: new Date(Date.now() - 4 * 3600_000).toISOString(), // the engine lists a day back
      ended: new Date(Date.now() - 3 * 3600_000).toISOString(),
      exit: state === 'done' ? 0 : 1,
    });
  done('1021-100000-veteran', 'done', 'tasks/T-0101-login-page.md');
  done('1021-100100-veteran', 'done', 'tasks/T-0102-api.md');
  done('1021-100200-veteran', 'done', 'tasks/T-0103-docs.md');
  done('1021-100300-veteran', 'failed', 'tasks/T-0104-deploy.md');
  const sleepers = Array.from({ length: 9 }, () => spawn('sleep', ['900'], { stdio: 'ignore' }));
  seedCodexTask(home, {
    id: '1021-230000-alpha',
    project: 'alpha',
    state: 'running',
    spec: 'T-36.md',
    model: 'terra', // the model the task names (Codex's own), shown as its badge
    started: new Date(Date.now() - 600_000).toISOString(),
    pid: sleepers[8].pid!,
  });
  const jobCmds = [
    ...[1, 2, 3, 4, 5].map((k) => `bash -c 'make build-${k} TOKEN=secret${k}'`),
    ...[1, 2, 3].map((k) => `python train.py --run ${k}`),
  ];
  jobCmds.forEach((cmd, k) =>
    seedJob(home, {
      pid: sleepers[k].pid!,
      project: 'veteran',
      cmd: maskSecrets(cmd),
      started: new Date(Date.now() - 3600_000).toISOString(),
    }),
  );
  const sessions = [
    session(fake.home, 1, 'lead', '/work/alpha'),
    session(fake.home, 2, 'helper', '/work/alpha'),
    ...[1, 2, 3, 4, 5, 6].map((k) => session(fake.home, 10 + k, `b${k}`, '/work/beta')),
  ];
  const lead = sessions[0];
  const started = startDaemon({ home, claudePath }, port, ['--no-terminal', '--engine', 'on', '--allow-chat'], {
    TZ: 'Asia/Seoul',
  });
  const daemon = started.child;
  const log = started.log;
  const pageErrors: string[] = [];
  const fonts = { malgun: fs.readFileSync(FONTS.malgun), emoji: fs.readFileSync(FONTS.emoji) };
  // Office hours are what this runner tests: left on (launchBrowser turns them off by default).
  const browser = await launchBrowser({ officeHours: true });
  const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
    const ctx = await browser.newContext({ ...opts, timezoneId: 'UTC' });
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true;');
    await ctx.route('**/__t0041/*.ttf', (route) =>
      route.fulfill({
        body: route.request().url().endsWith('emoji.ttf') ? fonts.emoji : fonts.malgun,
        contentType: 'font/ttf',
      }),
    );
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    return { ctx, page };
  };
  const ready = async (page: Page, url: string) => {
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가📖'));
  };
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const append = (records: Rec[]) => {
    for (const r of records) fs.appendFileSync(lead.transcript, JSON.stringify(r) + '\n');
  };
  const at = async (pages: Page[], when: Date) => {
    for (const p of pages) await p.clock.setFixedTime(when);
  };

  try {
    const loginUrl = await started.loginUrl();
    const { ctx: desk, page } = await open({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    await page.clock.setFixedTime(KST(21, 14));
    await ready(page, loginUrl);
    const { ctx: phoneCtx, page: phone } = await open({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    await phoneCtx.addCookies(await desk.cookies());
    await phone.clock.setFixedTime(KST(21, 14));
    await ready(phone, `http://127.0.0.1:${port}/`);
    const both = [page, phone];
    for (const p of both)
      await until('the orchestrators and the 외주 Codex worker are in', async () => {
        const n = await names(p);
        return ['veteran', 'lead', 'helper', 'b6'].every((x) => n.includes(x));
      }).catch(async (err) => {
        await shot(p, 'debug');
        console.error(JSON.stringify(await names(p)), JSON.stringify(await anchors(p)));
        throw err;
      });
    await page.waitForTimeout(4_000); // past the director's start-up window
    const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
    if (await closeInfo.count()) await closeInfo.click();
    await page.waitForTimeout(1_000);
    await shot(page, 'desktop-office-rooms');
    await shot(phone, 'phone-office');

    // An off character (a finished Codex worker lingering) is dimmed, and in full while selected.
    const offIds = await page.$$eval('[data-testid="agent-overlay"]', (ns) =>
      ns.filter((n) => (n as HTMLElement).style.opacity === '0.55').map((n) => Number(n.getAttribute('data-agent-id'))),
    );
    if (offIds.length) {
      const sel = (id: number | null) =>
        page.evaluate((id) => {
          (
            window as unknown as { __pixelAgentsTestHooks: { selectAgent: (id: number | null) => void } }
          ).__pixelAgentsTestHooks.selectAgent(id as number);
        }, id);
      const look = () =>
        page.$eval(`[data-testid="agent-overlay"][data-agent-id="${offIds[0]}"]`, (n) => (n as HTMLElement).style.opacity);
      await sel(offIds[0]);
      await page.waitForTimeout(400);
      const selected = await look();
      await sel(null);
      await page.waitForTimeout(400);
      const after = await look();
      check(
        selected === '1' && after === '0.55',
        `an off character's plate is in full while selected (${selected}), dimmed again after (${after})`,
      );
    } else console.log('(no off character on screen to select)');

    // 0. Bigger rooms: beta (6) is wider than alpha (2); cards have no temps.
    const leadId = (await idOf(page, 'lead'))!;
    const vetId = (await idOf(page, 'veteran'))!;
    check(leadId && vetId, `lead is #${leadId}, veteran is #${vetId}`);
    const cards = await page.$$eval('[data-testid="card-name"]', (n) =>
      n.map((x) => x.textContent),
    );
    check(
      cards.includes('외주') && !cards.some((c) => c?.startsWith('codex')),
      `temps have no card; the unowned Codex worker is under 외주 (${cards.join(', ')})`,
    );
    const outsourced = cardFor(page, '외주').locator('[data-testid="temp-chip"]');
    check((await outsourced.textContent()) === '+1', '외주 shows +1');
    await outsourced.click();
    const list = page.locator('[data-testid="temp-list"]');
    await list.waitFor();
    const codexRow = await list.locator('[data-testid="temp-row"]').first().textContent();
    check(
      // TEMP-PLATES: under its roster employee's name, not codex·<project>.
      !codexRow?.includes('codex·') && !!codexRow?.includes('T-36'),
      `the 외주 list names the Codex worker and its spec, not its id (${codexRow})`,
    );
    check(
      (await list.locator('[data-testid="model-badge"][data-model="terra"]').count()) === 1,
      'the Codex worker wears its model (Terra)',
    );
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 5);

    // 1. A sub-agent arrives from the door and works.
    append([
      said([call('tu-fix', 'Task', { description: 'fix login', prompt: 'x', model: 'sonnet' })]),
      sub('tu-fix', said([call('tu-fix-1', 'Grep', { pattern: 'login' })])),
    ]);
    const trail: Anchor[] = [];
    await until(
      'the sub-agent comes in',
      async () => {
        const a = (await anchors(page)).find((x) => x.kind === 'subagent');
        if (a) trail.push(a);
        return trail.length > 0 && trail.length >= 12;
      },
      30_000,
    );
    const subId = trail[0].id;
    check(trail.at(-1)!.phase === 'working', 'it is working');
    // TEMP-PLATES: a roster sub-agent has a nameplate: its rank icon is on the plate.
    const plateRank = page.locator(
      `[data-testid="agent-overlay"][data-agent-id="${subId}"] [data-testid="rank-icon"]`,
    );
    check(
      (await plateRank.getAttribute('data-rank')) === 'intern' &&
        (await plateRank.getAttribute('aria-label')) === '인턴 · Sonnet',
      'its plate shows its rank (인턴 · Sonnet)',
    );
    // It sits down at a spare desk in its lead's room (the director's own
    // view, an e2e-only hook in staff.ts).
    type Seen = { id: number; seat?: string; at: number[]; path: number; state: string };
    const staff = async () =>
      JSON.parse(
        await page.evaluate(() => JSON.stringify(Reflect.get(window, '__cldStaff') ?? [])),
      ) as Seen[];
    let seated: Seen | undefined;
    await until(
      'it reaches its desk',
      async () => {
        seated = (await staff()).find((x) => x.id === subId);
        return !!seated?.seat?.startsWith('seat:spare@alpha') && seated.state === 'type';
      },
      60_000,
    ).catch(async (err) => {
      console.error(JSON.stringify(await staff()));
      throw err;
    });
    check(true, `it sat down at a spare desk in alpha, its lead's room (${seated!.seat})`);
    await page.waitForTimeout(500);
    const seat = (await anchors(page)).find((x) => x.id === subId)!;
    const walked = Math.max(...trail.map((t) => Math.hypot(t.x - seat.x, t.y - seat.y)));
    check(walked > 200, `it walked there from the door (${Math.round(walked)} px)`);
    await shot(page, 'desktop-subagent-working');

    // 2. "+N" on the lead's card opens the list; a row goes to the character.
    const chip = cardFor(page, 'lead').locator('[data-testid="temp-chip"]');
    check((await chip.textContent()) === '+1', "the lead's card shows +1");
    await chip.click();
    await list.waitFor();
    const row = list.locator(`[data-testid="temp-row"][data-agent-id="${subId}"]`);
    const rowText = (await row.textContent()) ?? '';
    check(
      rowText.includes('fix login') && rowText.includes('일하는 중'),
      `the list says who and what (${rowText})`,
    );
    await shot(page, 'desktop-plus-n-list');
    await row.click();
    await until('the row went to the sub-agent', async () => {
      const o = page.locator(`[data-testid="agent-overlay"][data-agent-id="${subId}"]`);
      return (await o.locator('[data-testid="agent-details"]').count()) > 0;
    });
    check(true, 'tapping the row selects the sub-agent (its details are up)');
    const details = page.locator(`[data-testid="agent-details"]`).filter({ hasText: '등급: 사원' });
    check(
      (await details.count()) === 1 && (await details.textContent())?.includes('모델: Sonnet'),
      'the selected temp stat card shows its rank and full model',
    );
    await page.waitForTimeout(800);
    await shot(page, 'desktop-row-to-character');
    // The phone: the same +1 on the lead's card, its list.
    await phone.locator('[data-testid="agent-card"]').first().waitFor();
    // The phone's cards are compact by default; the +N chip waits for the full ones.
    if ((await phone.getByTestId('cards-toggle').getAttribute('aria-expanded')) !== 'true')
      await phone.getByTestId('cards-toggle').tap();
    const phoneChip = cardFor(phone, 'lead').locator('[data-testid="temp-chip"]');
    await until('the phone shows +1', async () => (await phoneChip.textContent()) === '+1');
    await phoneChip.tap();
    await phone.locator('[data-testid="temp-list"]').waitFor();
    check(true, "the phone's lead card opens the list too");
    await shot(phone, 'phone-plus-n-list');
    await phone.keyboard.press('Escape');

    // 3. The lead's turn ends: the sub-agent lingers in the lounge.
    append([userResult('tu-fix', 'done'), said([{ type: 'text', text: 'ok' }]), turnEnd]);
    await until(
      'it lingers',
      async () => (await anchors(page)).find((x) => x.id === subId)?.phase === 'lingering',
      30_000,
    );
    check(true, 'after the lead turn ends it lingers');
    await page.waitForTimeout(3_000);
    await shot(page, 'desktop-subagent-lingering');
    await at(both, KST(21, 14, 9));
    await page.waitForTimeout(1_500);
    check(
      (await anchors(page)).some((x) => x.id === subId),
      'nine minutes on, it is still there',
    );

    // 4. Past the linger time: it walks out and the feed says so.
    await at(both, KST(21, 14, 12));
    await until(
      'it walks out',
      async () => !(await anchors(page)).some((x) => x.id === subId),
      30_000,
    );
    check(true, 'past the linger time it walks out and is gone');
    // T-0077: the 현황판 icon opens its window (open already on a desktop's first load).
    if (!(await page.getByRole('navigation', { name: '사무실 메뉴' }).isVisible()))
      await page
        .locator('[data-hud-id^="icon:"]')
        .getByRole('button', { name: '현황판', exact: true })
        .click();
    await page.getByTestId('notice-bell').click(); // T-0070: the events are in the 알림 list
    // TEMP-PLATES: the line names the employee (its roster name).
    const feedLine = page.getByText(/ · 끝 \(\d+분\)/);
    await feedLine.first().waitFor({ timeout: 5_000 });
    check(true, `the 알림 list says "${await feedLine.first().textContent()}"`);
    await shot(page, 'desktop-feed');
    await page.getByRole('button', { name: '알림 닫기' }).click();

    // 5. The 현황판: veteran's row folds its finished Codex tasks and counts its jobs.
    await page
      .getByRole('navigation', { name: '사무실 메뉴' })
      .getByRole('button', { name: '현황판', exact: true })
      .click();
    const vet = page
      .locator('article')
      .filter({ has: page.getByRole('heading', { name: 'veteran', exact: true }) });
    await vet.getByRole('button', { name: 'veteran', exact: true }).click();
    const fold = vet.locator('[data-testid="codex-fold"]');
    await fold.waitFor();
    check(
      (await fold.textContent())?.includes('Codex 완료 3 · 실패 1'),
      `finished Codex tasks fold (${await fold.textContent()})`,
    );
    const jobs = (await vet.locator('[data-testid="job-summary"]').textContent()) ?? '';
    check(
      /⏳ 작업 중 8/.test(jobs) && !jobs.includes('make') && !jobs.includes('secret'),
      `the eight running jobs are counted by state, in EZ words only (${jobs})`,
    );
    await vet.locator('[data-testid="job-summary"]').click();
    const each = (await vet.locator('[data-testid="job-list"]').textContent()) ?? '';
    check(
      !each.includes('secret') && !each.includes('train.py'),
      'the job list never shows a command',
    );
    await shot(page, 'desktop-status-board');

    // 6. 18:00: the lead is busy (overtime), the idle veteran goes home.
    append([said([call('tu-late', 'Bash', { command: 'npm test' })])]);
    await at(both, KST(21, 18, 0));
    await page.waitForTimeout(1_500);
    await at(both, KST(21, 18, 1)); // past the grace
    await until(
      'the veteran goes home',
      async () =>
        (await page.locator(`[data-testid="off-duty-plate"][data-agent-id="${vetId}"]`).count()) >
        0,
      40_000,
    );
    check(
      !(await anchors(page)).some((x) => x.id === vetId),
      'at 18:00 the idle veteran walked out (its desk shows 퇴근)',
    );
    await until(
      'the lead does overtime',
      async () =>
        (await page
          .locator(`[data-testid="feet-badges"][data-agent-id="${leadId}"]`)
          .textContent()) === '야근',
    );
    check(true, 'the busy lead stays with 야근');
    check(
      (await cardFor(page, 'veteran').locator('[data-testid="duty-mark"]').textContent()) ===
        '퇴근',
      "the veteran's card still lists it, marked 퇴근",
    );
    // U-10 + U-27: the card and the plate of the one at home open its info sheet and chat.
    fs.mkdirSync(UI_OUT, { recursive: true });
    const sheet = page.getByTestId('off-duty-sheet');
    await cardFor(page, 'veteran').click();
    await sheet.waitFor({ timeout: 5_000 });
    const sheetText = (await sheet.textContent()) ?? '';
    check(
      sheetText.includes('퇴근했어요') && sheetText.includes('Lv 1') && sheetText.includes('환생 0회'),
      `a tap on the card of the veteran at home opens its sheet (${sheetText.slice(0, 80)})`,
    );
    check(
      (await sheet.getByTestId('off-duty-chat').count()) === 1,
      'the sheet offers the chat (a message wakes a resting session through the messenger)',
    );
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(UI_OUT, 'desktop-off-duty-sheet.png') });
    await page.getByRole('button', { name: 'x', exact: true }).click();
    await sheet.waitFor({ state: 'detached' });
    // The plate stands at the veteran's desk, maybe off screen: dispatch the click to it.
    await page.locator(`[data-testid="off-duty-plate"][data-agent-id="${vetId}"]`).dispatchEvent('click');
    await sheet.waitFor({ timeout: 5_000 });
    check(true, 'its 퇴근 plate on the desk opens the sheet too');
    await sheet.getByTestId('off-duty-chat').click();
    await sheet.waitFor({ state: 'detached' });
    await page.getByRole('textbox', { name: '보낼 글' }).waitFor({ timeout: 10_000 });
    check(true, '대화 열기 opens the messenger on its conversation');
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(UI_OUT, 'desktop-off-duty-chat.png') });
    await page.locator('[data-hud-window="messenger"]').getByRole('button', { name: '메신저 닫기' }).click();
    await page.waitForTimeout(1_000);
    await shot(page, 'desktop-1800');
    await until(
      'the phone shows the plate',
      async () => (await phone.locator('[data-testid="off-duty-plate"]').count()) > 0,
    );
    await phone.waitForTimeout(1_000);
    await shot(phone, 'phone-1800');

    // 7. 09:00 the next day: the veteran comes back in.
    await at(both, KST(22, 9, 0));
    await until(
      'the veteran is back',
      async () =>
        (await anchors(page)).some((x) => x.id === vetId) &&
        (await page.locator('[data-testid="off-duty-plate"]').count()) === 0,
      40_000,
    );
    check(true, 'at 09:00 the veteran came back in');
    await page.waitForTimeout(3_000);
    await shot(page, 'desktop-0900');
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ') || 'none'})`);
  } finally {
    await browser.close();
    if (daemon.exitCode === null) {
      const exited = new Promise((r) => daemon.once('exit', r));
      daemon.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      if (daemon.exitCode === null) daemon.kill('SIGKILL');
    }
    for (const s of [...sessions.map((x) => x.proc), ...sleepers]) s.kill('SIGKILL');
    killFakeSessions(fake.home);
    fs.rmSync(fake.home, { recursive: true, force: true });
  }
  fs.writeFileSync(
    path.join(OUT, 'server.log'),
    log
      .join('')
      .replace(/code=[\w-]+/g, 'code=<redacted>')
      .replaceAll(fake.home, '<HOME>')
      .replaceAll(os.hostname(), '<host>'),
  );
  console.log('all checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
