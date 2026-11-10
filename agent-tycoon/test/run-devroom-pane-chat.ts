/**
 * DEVROOM-PANE-CHAT (DV1, plan §4 1위, mockups D1 and P1), end to end: dist/cli.js in a temp HOME on a
 * spare port, a temp repository, the engine's fake claude (PTY host, never a real claude) as Lead
 * `shop-web` and two Workers in their 워크트리. Desktop (Chromium --disable-gpu, 1600x1000, 모던):
 *   1. picking main shows the Lead's conversation in its pane; text sent from the pane's composer lands
 *      in the Lead's transcript;
 *   2. web-worker asks a permission (the fake's FAKE-PERMISSION, through its PermissionRequest hook):
 *      the card shows in its pane and in the messenger; y and Enter with the pane focused send nothing;
 *      허용 sends exactly one permissionAnswer, the hook gets `allow`, the card leaves both places;
 *   3. 2×2 with one pane in 터미널: only the panes in 대화 hold a chatView (counted off the socket's
 *      frames), none once the window is minimized;
 * then 1024x700, one 픽셀 감성 shot, and the phone (390x844): the agent page in 대화 with the card.
 * Screenshots in agent-tycoon/artifacts/feat-devroom-pane-chat/.
 *
 *   taskset -c 2,3 nice -n 10 npx tsx agent-tycoon/test/run-devroom-pane-chat.ts <port 19110|19111>
 */
import type { Browser, Page } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { makeTempRepo } from '../../server/src/agent-tycoon/engine/git/testRepo.js';
import { assertPortFree, killFakeSessions, launchBrowser, makeEngineHome, REPO_ROOT, startDaemon } from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (port !== 19110 && port !== 19111) throw new Error('port: 19110 or 19111');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/feat-devroom-pane-chat');
const DEADLINE_MS = 360_000;
/** Long enough for a key to have reached the daemon, had anything sent it. */
const QUIET_MS = 1_500;
let oks = 0;

const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  oks++;
  console.log(`ok - ${text}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(what: string, test: () => boolean | Promise<boolean>, timeout = 30_000): Promise<void> {
  for (const end = Date.now() + timeout; ; await wait(200)) {
    if (await test()) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}
const read = (f: string) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};

type Frame = { type?: string; agentId?: number; on?: boolean };

/** Every client message a page sends on its sockets. */
function watchFrames(p: Page): Frame[] {
  const frames: Frame[] = [];
  p.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      try {
        frames.push(JSON.parse(String(f.payload)) as Frame);
      } catch {
        /* not ours */
      }
    }),
  );
  return frames;
}
/** The agents whose chatView this page holds on now (the last on/off of each). */
const chatOn = (frames: readonly Frame[]): number[] => {
  const on = new Map<number, boolean>();
  for (const f of frames) if (f.type === 'chatView' && typeof f.agentId === 'number') on.set(f.agentId, f.on === true);
  return [...on].filter(([, v]) => v).map(([id]) => id).sort();
};

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
    { PATH, FAKE_TURN_MS: '600', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C.UTF-8' },
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
      spawnSync(process.execPath, [path.join(REPO_ROOT, 'agent-tycoon/bin/agty'), ...args], { env: { PATH, HOME: home, AGTY_OUTPUT: 'json' }, encoding: 'utf8', timeout: 60_000 });
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
      const id = json(cli('task', 'add', ['장바구니 합계 계산 분리', '로그인 속도 제한'][i], '--project', 'shop-web', '--assignee', w, '--status', 'doing')).task?.id as string;
      check(json(cli('worktree', 'new', '--task', id, '--assign', w)).ok === true, `${id} gets a 워크트리 for ${w}`);
      check(json(cli('worker', 'start', w)).ok === true, `${w} started`);
      await eventually(`${w} live`, () => !!sessionOf(w), 60_000);
    }

    browser = await launchBrowser();
    const newPage = async (opts: Parameters<Browser['newContext']>[0], theme = 'modern') => {
      const ctx = await browser!.newContext(opts);
      await ctx.addInitScript((x) => localStorage.setItem('agty.ui-theme', x), theme);
      const p = await ctx.newPage();
      const frames = watchFrames(p);
      await p.goto(await daemon.loginUrl());
      await p.waitForURL(`http://127.0.0.1:${port}/`);
      const toast = await p.getByText(/으로 업데이트됐어요/).first().textContent({ timeout: 5_000 }).catch(() => null);
      const v = toast?.match(/v([\d.]+)/)?.[1];
      if (v) {
        await p.evaluate((x) => localStorage.setItem('agty.changelogSeen', x), v);
        await p.reload();
      }
      return { p, frames };
    };
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });

    // ── 1. Desktop: the Lead's conversation in its pane ──
    const { p: desk, frames } = await newPage({ viewport: { width: 1600, height: 1000 } });
    await desk.locator('[data-hud-id="icon:devroom"] button').click();
    const win = desk.locator('[data-hud-window="devroom"]');
    await win.waitFor({ timeout: 20_000 });
    await win.getByTestId('hud-title-devroom').dblclick();
    check((await win.locator('nav [data-tab="terminal"]').innerText()).includes('에이전트'), 'the first tab is 에이전트');
    check((await win.getByText('워크트리', { exact: true }).count()) >= 1, 'the rail is titled 워크트리');
    check((await win.getByTestId('devroom-new').innerText()).includes('리드에게 새 이슈 맡기기'), '+ 리드에게 새 이슈 맡기기');
    check((await win.getByTestId('devroom-cleanup').innerText()).includes('머지된 워크트리 정리'), '머지된 워크트리 정리');
    await win.getByTestId('devroom-trunk').first().click();
    const paneOf = (name: string) => win.locator(`[data-testid="devroom-pane"][data-agent="${name}"]`);
    const lead = paneOf('shop-web');
    await lead.locator('[data-testid="chat-scroll"]').waitFor({ timeout: 20_000 });
    check((await lead.getAttribute('data-view')) === 'chat', "picking main opens the Lead's pane in 대화");
    check((await win.getByTestId('devroom-picked').innerText()).includes('⎇ main'), `the footer: ${await win.getByTestId('devroom-picked').innerText()}`);
    const leadBox = lead.getByRole('textbox');
    check((await leadBox.getAttribute('placeholder')) === 'shop-web 에게 말하기…', 'the composer says shop-web 에게 말하기…');
    const hello = 'DV1 칸에서 리드에게 보내요';
    await leadBox.fill(hello);
    await leadBox.press('Enter');
    await eventually("the pane's text in the Lead's transcript", () => read(transcriptOf('shop-web') ?? '').includes(hello), 30_000);
    check(true, "text sent from the pane's composer lands in the Lead's transcript");
    await lead.getByText(hello).first().waitFor({ timeout: 15_000 });
    check(true, 'and shows as its bubble in the pane');

    // ── 2. web-worker's permission, in its pane and the messenger ──
    await win.getByTestId('devroom-layout-2').click();
    const second = win.getByTestId('devroom-pane').nth(1);
    if ((await second.getAttribute('data-agent')) !== 'web-worker') await second.getByTestId('devroom-pane-pick').selectOption('web-worker');
    const worker = paneOf('web-worker');
    const workerBox = worker.getByRole('textbox');
    await workerBox.waitFor({ timeout: 20_000 });
    await workerBox.fill('FAKE-PERMISSION 장바구니 테스트');
    await workerBox.press('Enter');
    const card = worker.getByTestId('permission-card');
    await card.waitFor({ timeout: 30_000 });
    const cardText = await card.innerText();
    check(cardText.includes('rm -rf fake-build'), "the pane's card names the call");
    check(!/\bEnter\b|\(y\)|\[y\]|\bY\/N\b/i.test(cardText) && (await card.locator('kbd').count()) === 0, 'no key hint on or near the card');
    await eventually('the pane and the rail say it waits', async () =>
      (await worker.getByTestId('devroom-agent-state').getAttribute('data-bucket')) === 'needs' &&
      (await win.locator('[data-testid="devroom-card"]').filter({ hasText: '장바구니 합계 계산 분리' }).getByTestId('devroom-chip').getAttribute('data-chip')) === 'approve', 15_000);
    check(true, 'the pane head says 나를 기다림 and the rail chip ! 승인 (one state)');
    await shot(desk, 'D1-desktop-1600-permission');

    // The messenger (another browser, the owner's other screen) shows the same wait.
    const { p: side } = await newPage({ viewport: { width: 1600, height: 1000 } });
    await side.getByRole('button', { name: /^메신저/ }).first().click();
    const messenger = side.getByRole('region', { name: '메신저', exact: true });
    const contacts = messenger.getByRole('list', { name: '연락처' });
    await contacts.getByRole('button', { name: /^shop-web/ }).first().waitFor({ timeout: 20_000 });
    // F-7: a project's Workers sit collapsed under it.
    const group = messenger.getByTestId('workers-shop-web');
    if (await group.count()) if (!(await group.evaluate((el) => (el as HTMLDetailsElement).open))) await group.locator('summary').click();
    await contacts.getByRole('button', { name: /^web-worker/ }).first().click();
    const msgCard = messenger.getByRole('region', { name: 'web-worker 대화' }).getByTestId('permission-card');
    await msgCard.waitFor({ timeout: 20_000 });
    check(true, 'the messenger shows the same card');

    const answers = () => frames.filter((f) => f.type === 'permissionAnswer').length;
    await worker.focus();
    await desk.keyboard.press('y');
    await desk.keyboard.press('Enter');
    await worker.locator('[data-testid="chat-scroll"]').click({ position: { x: 20, y: 20 } });
    await desk.keyboard.press('y');
    await desk.keyboard.press('Enter');
    await desk.waitForTimeout(QUIET_MS);
    check(answers() === 0 && (await card.count()) === 1, 'y and Enter with the pane focused answer nothing');
    await card.getByRole('button', { name: '허용', exact: true }).click();
    await eventually('the hook decided', () => read(path.join(home, 'fake-claude-perm.log')).includes('"behavior":"allow"'), 30_000);
    await card.waitFor({ state: 'detached', timeout: 15_000 });
    await msgCard.waitFor({ state: 'detached', timeout: 15_000 });
    await desk.waitForTimeout(QUIET_MS);
    check(answers() === 1, `허용 sent exactly one permissionAnswer (${answers()}), the card left the pane and the messenger`);
    await side.close();

    // ── 3. Four panes: only the ones in 대화 on screen hold a chatView ──
    await win.getByTestId('devroom-layout-4').click();
    await desk.waitForFunction(() => document.querySelectorAll('[data-testid="devroom-pane"]').length === 4, undefined, { timeout: 10_000 });
    const api = paneOf('api-worker');
    await api.locator('[data-testid="devroom-pane-view"][data-view="terminal"]').click();
    await api.locator('.xterm-rows').waitFor({ timeout: 30_000 });
    const idOf = async (name: string) => Number(await paneOf(name).getAttribute('data-agent-id'));
    const want = [await idOf('shop-web'), await idOf('web-worker')].sort();
    await eventually('chatView on for the two chat panes', () => JSON.stringify(chatOn(frames)) === JSON.stringify(want), 10_000);
    check(!chatOn(frames).includes(await idOf('api-worker')), `four panes, three agents, one in 터미널: chatView on for ${chatOn(frames).join(', ')} only`);
    await shot(desk, 'D1-desktop-1600-2x2');
    await win.getByRole('button', { name: '최소화' }).click();
    await eventually('no chatView once minimized', () => chatOn(frames).length === 0, 10_000);
    check(true, 'minimized: no pane holds a chatView');

    await desk.locator('[data-hud-id="icon:devroom"] button').click();
    await win.getByTestId('devroom-layout-2').click();
    await shot(desk, 'D1-desktop-1600');

    // ── 1024x700, and one 픽셀 감성 shot ──
    await desk.setViewportSize({ width: 1024, height: 700 });
    await desk.waitForTimeout(800);
    await shot(desk, 'D1-desktop-1024');
    const { p: pixel } = await newPage({ viewport: { width: 1600, height: 1000 } }, 'pixel');
    await pixel.locator('[data-hud-id="icon:devroom"] button').click();
    const pwin = pixel.locator('[data-hud-window="devroom"]');
    await pwin.waitFor({ timeout: 20_000 });
    await pwin.getByTestId('hud-title-devroom').dblclick();
    await pwin.getByTestId('devroom-trunk').first().click();
    await pwin.locator('[data-testid="devroom-pane"][data-agent="shop-web"] [data-testid="chat-scroll"]').waitFor({ timeout: 20_000 });
    await pwin.getByTestId('devroom-layout-2').click();
    const pworker = pwin.locator('[data-testid="devroom-pane"]').nth(1);
    await pworker.waitFor({ timeout: 10_000 });
    if ((await pworker.getAttribute('data-agent')) !== 'web-worker') await pworker.getByTestId('devroom-pane-pick').selectOption('web-worker');
    const pbox = pwin.locator('[data-testid="devroom-pane"][data-agent="web-worker"]').getByRole('textbox');
    await pbox.fill('FAKE-PERMISSION 픽셀 감성');
    await pbox.press('Enter');
    const pcard = pwin.locator('[data-testid="devroom-pane"][data-agent="web-worker"]').getByTestId('permission-card');
    await pcard.waitFor({ timeout: 30_000 });
    check(true, '픽셀 감성: the pane head and the card render');
    await shot(pixel, 'D1-desktop-pixel');
    await pcard.getByRole('button', { name: '거부', exact: true }).click();
    await pcard.waitFor({ state: 'detached', timeout: 15_000 });
    await pixel.close();

    // ── Phone (P1): the agent page in 대화, the card in it ──
    const { p: phone } = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await phone.locator('[data-dock="devroom"]').tap();
    const pc = phone.locator('[data-testid="devroom-card"]').filter({ hasText: '장바구니 합계 계산 분리' });
    await pc.locator('b').tap();
    await pc.locator('[data-page="terminal"]').tap();
    const term = phone.getByTestId('devroom-phone-term');
    await term.waitFor({ timeout: 20_000 });
    check((await term.getAttribute('data-agent')) === 'web-worker', 'phone: the 워크트리 opens its Worker');
    const box = term.getByRole('textbox');
    await box.waitFor({ timeout: 20_000 });
    check((await term.locator('[data-testid="devroom-pane-view"][data-view="chat"]').getAttribute('aria-selected')) === 'true', 'phone: it opens in 대화');
    await box.fill('FAKE-PERMISSION 휴대폰');
    await term.getByRole('button', { name: '보내기', exact: true }).tap();
    const phoneCard = term.getByTestId('permission-card');
    await phoneCard.waitFor({ timeout: 30_000 });
    check(true, "phone: the permission card in the agent page's 대화");
    await phone.waitForTimeout(600);
    await shot(phone, 'P1-phone');
    await phoneCard.getByRole('button', { name: '허용', exact: true }).tap();
    await phoneCard.waitFor({ state: 'detached', timeout: 15_000 });
    check(true, 'phone: 허용 there takes the card away');
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `phone: no sideways scroll (${overflow})`);

    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } finally {
    clearTimeout(deadline);
    await browser?.close().catch(() => undefined);
    await daemon.stop().catch(() => undefined);
    killFakeSessions(home);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
