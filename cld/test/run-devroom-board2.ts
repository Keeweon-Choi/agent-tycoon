/**
 * DEVROOM-BOARD2 (owner 11-03 11:51), the 개발실's 터미널 board after a layout change, end to end:
 * dist/cli.js in a temp HOME on a spare port, a temp repository, the engine's fake claude (PTY
 * host, never a real claude) as Lead `shop-web` and two Workers. The fake TUI redraws on a resize
 * and draws its row 2 by column (` cols=N` and `|` in the PTY's last column), so a terminal that
 * parsed the redraw at another width than the PTY's shows the `|` elsewhere or twice. Desktop
 * (Chromium --disable-gpu, 1920x1080): 1 → 2×2 → 1 → a free split (a card dropped on an edge)
 * and a divider drag, each followed by a clean row 2 in every pane; the status strip groups the
 * agents (끝남 within 30 minutes of news, 쉬는 중 hidden behind its toggle); a running sub-agent
 * is only a `서브 n` chip. Phone (390x844): the cards and one agent full screen.
 * Screenshots in cld/artifacts/devroom-board2/.
 *
 *   nice -n 10 npx tsx cld/test/run-devroom-board2.ts <port 18270|18271>
 */
import type { Browser, Page } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import { assertPortFree, killFakeSessions, launchBrowser, makeEngineHome, REPO_ROOT, startDaemon } from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (port !== 18270 && port !== 18271) throw new Error('port: 18270 or 18271');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/devroom-board2');
const DEADLINE_MS = 300_000;
/** Longer than the client's resize debounce plus the TUI's redraw. */
const SETTLE_MS = 1_500;
let oks = 0;

const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  oks++;
  console.log(`ok - ${text}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(what: string, test: () => boolean, timeout = 30_000): Promise<void> {
  for (const end = Date.now() + timeout; ; await wait(200)) {
    if (test()) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}

type Rec = Record<string, unknown>;
const stamp = (r: Rec): Rec => ({ uuid: `u-${Math.random().toString(16).slice(2, 10)}`, timestamp: new Date().toISOString(), ...r });

async function main() {
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const repo = makeTempRepo();
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify({ v: 2, projects: [{ projectId: 'p_aaaaaaaaaa', name: 'shop-web', folder: repo.folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }] }),
  );
  fs.writeFileSync(
    path.join(cfg, 'assignments.json'),
    JSON.stringify({ v: 1, assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude-pty', wantRunning: true }] }),
  );
  const PATH = [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    { PATH, FAKE_TURN_MS: '240000', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C.UTF-8' },
    true,
  );
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL');
  }, DEADLINE_MS);
  try {
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args], { env: { PATH, HOME: home, CLD_OUTPUT: 'json' }, encoding: 'utf8', timeout: 60_000 });
    const json = (r: ReturnType<typeof cli>) => JSON.parse(r.stdout || '{}') as Record<string, any>;
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
      const s = sessionOf(name);
      return s && path.join(home, '.claude/projects', s.cwd.replace(/[^a-zA-Z0-9-]/g, '-'), `${s.sessionId}.jsonl`);
    };
    await daemon.loginUrl();
    await eventually('the Lead revived', () => !!sessionOf('shop-web'), 60_000);
    for (const [i, w] of ['web-worker', 'api-worker'].entries()) {
      check(json(cli('worker', 'add', 'shop-web', w)).ok === true, `Worker ${w} added`);
      const id = json(cli('task', 'add', `작업 ${i + 1}`, '--project', 'shop-web', '--assignee', w, '--status', 'doing')).task?.id as string;
      check(json(cli('worktree', 'new', '--task', id, '--assign', w)).ok === true, `${id} gets a worktree for ${w}`);
      check(json(cli('worker', 'start', w)).ok === true, `${w} started`);
      await eventually(`${w} live`, () => !!sessionOf(w), 60_000);
    }
    // web-worker answers (its turn ends: 끝남); api-worker's last news is two hours old (쉬는 중).
    for (const n of ['shop-web', 'web-worker', 'api-worker']) fs.mkdirSync(path.dirname(transcriptOf(n)!), { recursive: true });
    fs.appendFileSync(transcriptOf('shop-web')!, `${JSON.stringify(stamp({ type: 'user', message: { content: '장바구니 합계를 정리해 주세요' } }))}\n`);
    const old = new Date(Date.now() - 2 * 3600_000).toISOString();
    fs.appendFileSync(transcriptOf('api-worker')!, `${JSON.stringify({ type: 'assistant', uuid: 'old-1', timestamp: old, message: { content: [{ type: 'text', text: '어제 일은 끝났어요.' }] } })}\n`);
    fs.appendFileSync(transcriptOf('web-worker')!, `${JSON.stringify(stamp({ type: 'assistant', message: { content: [{ type: 'text', text: '합계 계산을 분리했어요.' }] } }))}\n`);

    browser = await launchBrowser();
    const newPage = async (opts: Parameters<Browser['newContext']>[0]) => {
      const ctx = await browser!.newContext(opts);
      const p = await ctx.newPage();
      await p.goto(await daemon.loginUrl());
      await p.waitForURL(`http://127.0.0.1:${port}/`);
      // The "vX 으로 업데이트됐어요" toast names this build's version: mark it seen.
      const toast = await p.getByText(/으로 업데이트됐어요/).first().textContent({ timeout: 5_000 }).catch(() => null);
      const v = toast?.match(/v([\d.]+)/)?.[1];
      if (v) {
        await p.evaluate((x) => localStorage.setItem('cld.changelogSeen', x), v);
        await p.reload();
      }
      return p;
    };
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });

    // ── Desktop ──
    const desk = await newPage({ viewport: { width: 1920, height: 1080 } });
    await desk.locator('[data-hud-id="icon:devroom"] button').click();
    const win = desk.locator('[data-hud-window="devroom"]');
    await win.waitFor({ timeout: 20_000 });
    await win.getByTestId('hud-title-devroom').dblclick();
    await win.getByTestId('devroom-trunk').first().click();
    const paneOf = (name: string) => win.locator(`[data-testid="devroom-pane"][data-agent="${name}"]`);
    await paneOf('shop-web').waitFor({ timeout: 20_000 });
    // DEVROOM-PANE-CHAT: panes open in 대화 and the cards sit behind the status chips.
    const terminals = () =>
      desk.evaluate(() =>
        document
          .querySelectorAll<HTMLElement>('[data-testid="devroom-pane"]:not([data-view="terminal"]) [data-testid="devroom-pane-view"][data-view="terminal"]')
          .forEach((b) => b.click()),
      );
    const strip = async (open = true) => {
      if ((await win.getByTestId('devroom-strip').count()) !== (open ? 1 : 0)) await win.getByTestId('devroom-status-chip').first().click();
    };
    await terminals();

    /** Row 2 of every pane on screen: ` cols=N` and one `|`, in column N. */
    const rulers = () =>
      desk.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[data-testid="devroom-pane"]')].flatMap((pane) => {
          const rows = [...pane.querySelectorAll<HTMLElement>('.xterm-rows > div')].map((d) => (d.textContent ?? '').replace(/ /g, ' '));
          return rows.length ? [{ agent: pane.dataset.agent ?? '', row: rows[1] ?? '' }] : [];
        }),
      );
    const clean = async (what: string, panes: number) => {
      await desk.waitForTimeout(SETTLE_MS);
      const all = await rulers();
      const bad = all.filter(({ row }) => {
        const n = Number(/cols=(\d+)/.exec(row)?.[1] ?? 0);
        return !n || row.indexOf('|') !== n - 1 || row.split('|').length !== 2;
      });
      check(all.length === panes && !bad.length, `${what}: ${all.length} panes, each terminal at its PTY's width (${all.map((r) => `${r.agent} ${/cols=\d+/.exec(r.row)?.[0]}`).join(', ')})${bad.length ? ` BAD ${JSON.stringify(bad)}` : ''}`);
    };
    await desk.waitForFunction(() => document.querySelector('[data-testid="devroom-pane"] .xterm-rows')?.textContent?.includes('fake Claude Code'), undefined, { timeout: 30_000 });
    await clean('layout 1', 1);
    await win.getByTestId('devroom-layout-4').click();
    await terminals();
    await clean('1 → 2×2', 3);
    await shot(desk, 'pc-2x2');
    await win.getByTestId('devroom-layout-1').click();
    await clean('2×2 → 1', 1);
    await shot(desk, 'pc-back-to-1');
    // A free split: a card on the Lead pane's right edge, another on that pane's bottom edge.
    const drag = async (from: string, to: string, fx: number, fy: number) => {
      await strip();
      if (from === 'api-worker' && !(await win.locator('[data-testid="devroom-agent-card"][data-agent="api-worker"]').count())) await win.getByTestId('devroom-show-idle').click();
      const a = (await win.locator(`[data-testid="devroom-agent-card"][data-agent="${from}"]`).boundingBox())!;
      const b = (await paneOf(to).boundingBox())!;
      await desk.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await desk.mouse.down();
      await desk.mouse.move(b.x + b.width * fx, b.y + b.height * fy, { steps: 8 });
      await desk.mouse.move(b.x + b.width * fx + 2, b.y + b.height * fy + 2, { steps: 2 });
      await desk.mouse.up();
      await paneOf(from).waitFor({ timeout: 10_000 });
    };
    await drag('web-worker', 'shop-web', 0.95, 0.5); // api-worker rests: its card shows on demand
    await drag('api-worker', 'web-worker', 0.5, 0.95);
    await terminals();
    await clean('a free split (the Lead left, two stacked right)', 3);
    const divider = win.getByTestId('devroom-divider').first();
    const d = (await divider.boundingBox())!;
    await desk.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
    await desk.mouse.down();
    await desk.mouse.move(d.x + d.width / 2 + 260, d.y + d.height / 2, { steps: 6 });
    await desk.mouse.up();
    await clean('a divider dragged', 3);
    await shot(desk, 'pc-free-split');
    await win.getByTestId('devroom-layout-1').click();
    await clean('free split → 1', 1);
    await shot(desk, 'pc-free-to-1');

    // The status strip: 끝남 (news within 30 minutes), 쉬는 중 hidden until its toggle.
    await strip();
    const bucket = (name: string) => win.locator(`[data-testid="devroom-agent-card"][data-agent="${name}"]`).getAttribute('data-bucket');
    await desk.waitForFunction(() => document.querySelector('[data-testid="devroom-agent-card"][data-agent="web-worker"]')?.getAttribute('data-bucket') === 'done', undefined, { timeout: 20_000 });
    check(true, 'web-worker answered a moment ago: 끝남');
    check((await win.locator('[data-testid="devroom-agent-card"][data-agent="api-worker"]').count()) === 0, 'api-worker (news two hours old) is hidden under 쉬는 중');
    const idle = await win.locator('[data-testid="devroom-agent-group"][data-bucket="idle"]').innerText();
    check(idle.includes('쉬는 중 1'), `its folded group counts it (${idle.replace(/\n/g, ' ')})`);
    await shot(desk, 'pc-strip-idle-hidden');
    await win.getByTestId('devroom-show-idle').click();
    check((await bucket('api-worker')) === 'idle', 'the toggle shows it as 쉬는 중');
    await shot(desk, 'pc-strip-idle-shown');

    // A running sub-agent is only a 서브 n chip on its agent.
    const lead = transcriptOf('shop-web')!;
    fs.mkdirSync(path.dirname(lead), { recursive: true });
    const add = (r: Rec) => fs.appendFileSync(lead, `${JSON.stringify(stamp(r))}\n`);
    add({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-a', name: 'Agent', input: { description: '테스트 실행', prompt: 'npm test' } }] } });
    add({ type: 'progress', parentToolUseID: 'tu-a', data: { type: 'agent_progress', message: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a-1', name: 'Bash', input: { command: 'npm test' } }] } } } });
    await strip();
    await win.locator('[data-testid="devroom-agent-card"][data-agent="shop-web"]').click();
    await desk.waitForFunction(() => document.querySelector('[data-testid="devroom-pane"][data-agent="shop-web"] [data-testid="devroom-sub-chip"]')?.textContent?.includes('1'), undefined, { timeout: 20_000 });
    await strip();
    check((await win.locator('[data-testid="devroom-agent-card"][data-agent="shop-web"] [data-testid="devroom-sub-chip"]').count()) === 1, "the Lead's card and pane wear 서브 1 while its sub-agent runs");
    check((await win.getByTestId('devroom-sub-chip').count()) === 2, 'and no other sub-agent sign anywhere');
    await shot(desk, 'pc-sub-chip');

    // ── Phone ──
    const phone = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await phone.locator('[data-dock="devroom"]').tap();
    await phone.getByTestId('devroom-trunk').first().tap();
    await phone.getByTestId('devroom-phone-all').tap();
    await phone.getByTestId('devroom-agent-card').first().waitFor({ timeout: 20_000 });
    await phone.waitForTimeout(400);
    await shot(phone, 'phone-cards');
    await phone.locator('[data-testid="devroom-agent-card"][data-agent="web-worker"]').tap();
    await phone.locator('[data-testid="devroom-phone-term"] [data-testid="devroom-pane-view"][data-view="terminal"]').tap();
    await phone.waitForFunction(() => document.querySelector('[data-testid="devroom-phone-term"] .xterm-rows')?.textContent?.includes('web-worker'), undefined, { timeout: 30_000 });
    await phone.waitForTimeout(SETTLE_MS);
    const row = await phone.evaluate(() => ([...document.querySelectorAll<HTMLElement>('[data-testid="devroom-phone-term"] .xterm-rows > div')][1]?.textContent ?? '').replace(/ /g, ' '));
    const n = Number(/cols=(\d+)/.exec(row)?.[1] ?? 0);
    check(n > 0 && row.indexOf('|') === n - 1, `phone: web-worker full screen at its PTY's width (cols=${n})`);
    await shot(phone, 'phone-terminal');

    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    fs.writeFileSync(path.join(os.tmpdir(), 'run-devroom-board2.daemon.log'), daemon.log.join(''));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    repo.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
