/**
 * WAITING-PERSIST (owner 11-03 12:18): an agent stopped on a question stays visible after the
 * daemon restarts. dist/cli.js in a temp HOME on a spare port, the engine's fake claude (PTY
 * host, never a real claude) as Lead `shop-web`. First its turn ends with a statement and Claude's
 * idle_prompt follows: no 질문 대기, 나를 기다림 0. Then a turn ends asking ('?'): 나를 기다림 1,
 * saved in office/questions.json; the daemon stops normally and starts again on the same HOME; PC
 * (Chromium --disable-gpu, 1920x1080) and phone (390x844): 질문 대기 on the 전광판 (나를 기다림 1
 * · shop-web), the 현황판 오케스트레이터 card, the messenger's contact row and conversation header,
 * the dev room's agent card and pane header. Answering clears it everywhere and in the saved
 * state. Screenshots in agent-tycoon/artifacts/waiting-persist/.
 *
 *   nice -n 10 npx tsx agent-tycoon/test/run-waiting-persist.ts <port 18262|18263>
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { configDirectory, officeDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { makeTempRepo } from '../../server/src/agent-tycoon/engine/git/testRepo.js';
import {
  assertPortFree,
  DEV_WINDOW,
  isFakeOf,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  removeTestHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (port !== 18262 && port !== 18263) throw new Error('port: 18262 or 18263');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/waiting-persist');
const DEADLINE_MS = 360_000;
const LEAD = 'shop-web';
let oks = 0;

const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  oks++;
  console.log(`ok - ${text}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(what: string, test: () => boolean | Promise<boolean>, timeout = 30_000): Promise<void> {
  for (const end = Date.now() + timeout; ; await wait(250)) {
    if (await test()) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}
type Rec = Record<string, unknown>;
const stamp = (r: Rec): Rec => ({ uuid: `u-${Math.random().toString(16).slice(2, 10)}`, timestamp: new Date().toISOString(), ...r });
const DESK: BrowserContextOptions = { viewport: { width: 1920, height: 1080 } };
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

async function main() {
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  const office = officeDirectory(home);
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const repo = makeTempRepo();
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify({ v: 2, projects: [{ projectId: 'p_aaaaaaaaaa', name: LEAD, folder: repo.folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }] }),
  );
  fs.writeFileSync(
    path.join(cfg, 'assignments.json'),
    JSON.stringify({ v: 1, assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude-pty', wantRunning: true }] }),
  );
  const PATH = [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
  const start = () =>
    startDaemon(
      { home, claudePath: path.join(bin, 'claude') },
      port,
      ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
      { PATH, FAKE_TURN_MS: '240000', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C.UTF-8' },
      true,
    );
  let daemon = start();
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL');
  }, DEADLINE_MS);
  const sessionOf = (name: string) => {
    for (const file of fs.readdirSync(path.join(home, '.claude/sessions'))) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(home, '.claude/sessions', file), 'utf8')) as { name: string; sessionId: string; cwd: string };
        if (s.name === name) return s;
      } catch {
        /* written as we read */
      }
    }
    return undefined;
  };
  const transcriptOf = (name: string) => {
    const s = sessionOf(name)!;
    return path.join(home, '.claude/projects', s.cwd.replace(/[^a-zA-Z0-9-]/g, '-'), `${s.sessionId}.jsonl`);
  };
  const savedQuestion = () => {
    try {
      return Object.keys(JSON.parse(fs.readFileSync(path.join(office, 'questions.json'), 'utf8')) as object).length > 0;
    } catch {
      return false;
    }
  };
  const hook = async (event: Rec) => {
    const { token } = JSON.parse(fs.readFileSync(path.join(office, 'server.json'), 'utf8')) as { token: string };
    const res = await fetch(`http://127.0.0.1:${port}/api/hooks/claude`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    check(res.ok, `hook ${String(event.hook_event_name)} accepted (${res.status})`);
  };
  const newPage = async (opts: BrowserContextOptions) => {
    const ctx = await browser!.newContext(opts);
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('agty.title-scene', 'off');
      } catch {
        /* about:blank */
      }
    });
    const p = await ctx.newPage();
    await p.goto(await daemon.loginUrl());
    await p.waitForURL(`http://127.0.0.1:${port}/`);
    const toast = await p.getByText(/으로 업데이트됐어요/).first().textContent({ timeout: 5_000 }).catch(() => null);
    const v = toast?.match(/v([\d.]+)/)?.[1];
    if (v) {
      await p.evaluate((x) => localStorage.setItem('agty.changelogSeen', x), v);
      await p.reload();
    }
    return p;
  };
  const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
  const waiting = async (p: Page) => Number(await p.getByTestId('board-waiting').first().getAttribute('data-count'));
  const marks = (scope: ReturnType<Page['locator']>) => scope.locator('[data-testid="wait-mark"][data-reason="question"]');

  try {
    await daemon.loginUrl();
    await eventually('the Lead revived', () => !!sessionOf(LEAD), 60_000);
    const lead = transcriptOf(LEAD);
    fs.mkdirSync(path.dirname(lead), { recursive: true });
    browser = await launchBrowser();

    const turn = (ask: string, answer: string) => {
      fs.appendFileSync(lead, `${JSON.stringify(stamp({ type: 'user', message: { content: ask } }))}\n`);
      fs.appendFileSync(lead, `${JSON.stringify(stamp({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } }))}\n`);
      fs.appendFileSync(lead, `${JSON.stringify(stamp({ type: 'system', subtype: 'turn_duration', durationMs: 1200 }))}\n`);
    };

    // ── Daemon 1: a statement and idle_prompt are no question; a '?' is ──
    let desk = await newPage(DESK);
    await desk.getByTestId('lobby-board').waitFor({ timeout: 30_000 });
    turn('결제 화면 정리해 주세요', '결제 화면을 정리했어요. 테스트도 통과했어요.');
    await wait(1500);
    await hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt', session_id: sessionOf(LEAD)!.sessionId, transcript_path: lead, cwd: repo.folder });
    await wait(2000);
    check((await waiting(desk)) === 0, 'a statement turn plus idle_prompt: 나를 기다림 0');
    check((await marks(desk.locator('body')).count()) === 0 && !savedQuestion(), 'and no 질문 대기, nothing saved');
    await shot(desk, 'pc-0a-statement-idle');
    turn('다음은 결제 수단이에요', '카드 결제를 먼저 할까요, 계좌 이체를 먼저 할까요?');
    await eventually('나를 기다림 1 before the restart', async () => (await waiting(desk)) === 1);
    check(true, 'before the restart: 나를 기다림 1');
    await eventually('the question is in questions.json', savedQuestion, 5_000);
    check(true, 'the question is saved in office/questions.json');
    await shot(desk, 'pc-0b-question-before-restart');
    await desk.context().close();

    // ── The daemon restarts on the same HOME ──
    await daemon.stop();
    daemon = start();
    console.log(`daemon restarted, pid ${daemon.child.pid}`);
    await daemon.loginUrl();

    desk = await newPage(DESK);
    await desk.getByTestId('lobby-board').waitFor({ timeout: 30_000 });
    await eventually('나를 기다림 1 after the restart', async () => (await waiting(desk)) === 1, 30_000);
    const who = await desk.getByTestId('board-waiting').first().innerText();
    check(who.includes(LEAD), `after the restart the 전광판 says who: "${who}"`);
    await shot(desk, 'pc-1-office-after-restart');
    const b = (await desk.getByTestId('lobby-board').boundingBox())!;
    await desk.mouse.click(b.x + b.width / 2, b.y + b.height * 0.6);
    await desk.getByTestId('board-full').waitFor({ timeout: 5_000 });
    // e18c8bf3: the board has no per-project rows any more; its 나를 기다림 line (above) is what names the lead.
    await shot(desk, 'pc-2-board-full');
    await desk.getByTestId('board-full').getByTestId('board-waiting').click();
    const dash = desk.locator(DEV_WINDOW).first();
    await dash.waitFor({ timeout: 5_000 });
    // The dashboard lists what waits for the owner (its 나를 기다림 list names the lead); it has no wait marks.
    await eventually('현황판 질문 대기', async () => (await dash.getByText(LEAD).count()) > 0, 10_000);
    check(true, '현황판 요약: the waiting lead is listed');
    await shot(desk, 'pc-3-status');

    await desk.locator('[data-hud-id="icon:messenger"]').getByRole('button').click();
    const msgr = desk.locator('[data-hud-window="messenger"]');
    await msgr.waitFor({ timeout: 10_000 });
    await eventually('messenger contact 질문 대기', async () => (await marks(msgr).count()) > 0, 10_000);
    check(true, 'messenger: 질문 대기 on the contact row');
    await msgr.getByText(LEAD, { exact: true }).first().click();
    await eventually('conversation header 질문 대기', async () => (await marks(msgr.locator('header')).count()) > 0, 10_000);
    check(true, 'messenger: 질문 대기 in the conversation header');
    await shot(desk, 'pc-4-messenger');

    await desk.locator('[data-hud-id="icon:devroom"] button').click();
    const room = desk.locator('[data-hud-window="devroom"]');
    await room.waitFor({ timeout: 20_000 });
    await room.getByTestId('hud-title-devroom').dblclick();
    await room.getByTestId('devroom-trunk').first().click();
    // DEVROOM-PANE-CHAT: the cards sit behind the status chips (나를 기다림 first).
    await room.getByTestId('devroom-status-chip').first().click();
    const card = room.locator(`[data-testid="devroom-agent-card"][data-agent="${LEAD}"]`);
    await card.waitFor({ timeout: 20_000 });
    check((await card.getAttribute('data-bucket')) === 'needs', 'dev room: the card is in 나를 기다림');
    check((await marks(card).count()) === 1, 'dev room: 질문 대기 on the card');
    await eventually('dev room pane header 질문 대기', async () => (await marks(room.getByTestId('devroom-pane-head')).count()) > 0, 10_000);
    check(true, 'dev room: 질문 대기 in the pane header');
    await shot(desk, 'pc-5-devroom');

    // ── Phone, same daemon ──
    const phone = await newPage(PHONE);
    await phone.getByTestId('lobby-board').waitFor({ timeout: 30_000 });
    await eventually('phone 나를 기다림 1', async () => (await waiting(phone)) === 1, 15_000);
    const pb = (await phone.getByTestId('lobby-board').boundingBox())!;
    await phone.touchscreen.tap(pb.x + pb.width / 2, pb.y + pb.height * 0.6);
    await phone.getByTestId('board-full').waitFor({ timeout: 5_000 });
    check((await phone.getByTestId('board-full').getByTestId('board-waiting').innerText()).includes(LEAD), 'phone: the full board says who');
    await shot(phone, 'phone-1-board');
    await phone.getByTestId('board-full').getByTestId('board-waiting').tap();
    await eventually('phone 현황판 질문 대기', async () => (await phone.locator('[aria-label="현황판 화면"]').getByText(LEAD).count()) > 0, 10_000);
    check(true, 'phone: 현황판 요약 lists the waiting lead');
    await shot(phone, 'phone-2-status');
    await phone.goBack().catch(() => undefined);
    await phone.locator('[data-dock="messenger"]').tap();
    await eventually('phone messenger 질문 대기', async () => (await marks(phone.locator('body')).count()) > 0, 10_000);
    check(true, 'phone: messenger 질문 대기');
    await shot(phone, 'phone-3-messenger');
    await phone.goBack().catch(() => undefined);
    await phone.locator('[data-dock="devroom"]').tap();
    await phone.getByTestId('devroom-trunk').first().tap();
    await phone.getByTestId('devroom-phone-all').tap().catch(() => undefined);
    const pcard = phone.locator(`[data-testid="devroom-agent-card"][data-agent="${LEAD}"]`);
    await pcard.waitFor({ timeout: 20_000 });
    check((await marks(pcard).count()) === 1, 'phone: dev room card 질문 대기');
    await shot(phone, 'phone-4-devroom');

    // ── The person answers: gone everywhere, and from the saved state ──
    fs.appendFileSync(lead, `${JSON.stringify(stamp({ type: 'user', message: { content: '카드 결제 먼저요' } }))}\n`);
    await eventually('나를 기다림 0 after the answer', async () => (await waiting(desk)) === 0, 15_000);
    check((await marks(desk.locator('body')).count()) === 0, 'answered: no 질문 대기 left on the PC');
    await eventually('saved question cleared', () => !savedQuestion(), 5_000);
    check(true, 'answered: the saved state has no question');
    await shot(desk, 'pc-6-answered');

    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    fs.writeFileSync(path.join(os.tmpdir(), 'run-waiting-persist.daemon.log'), daemon.log.join(''));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    // The PTY host outlives the daemon by design: stop ours (its HOME is this test HOME).
    for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number)) {
      if (!isFakeOf(pid, home)) continue;
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (args.includes('agty-ptyhost'))
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* gone */
        }
    }
    repo.cleanup();
    removeTestHome(home); // retries: the PTY host may write a last file while it goes
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
