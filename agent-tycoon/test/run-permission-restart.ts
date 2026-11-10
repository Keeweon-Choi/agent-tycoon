/**
 * FIX-PERM-RESTART (owner 11-06 20:07: "이전에 왔던 '허락을 기다려요'는 열었을 때 메신저에는 안 남아있고
 * 터미널을 직접 켜서 승인해야함"), end to end: dist/cli.js with --engine on --allow-chat in a temp HOME,
 * the engine's fake claude as PTY agent alpha (its PermissionRequest hook is `agty permission-hook`;
 * a dialog the hook does not decide stays up in its terminal, as Claude's own does), headless
 * Chromium without GPU.
 *
 *   a. alpha asks a permission; the bell's 허락을 기다려요 opens the messenger on its card;
 *      While the page's link is down the card's buttons are off, with the reason;
 *   b. the daemon restarts while it is pending: the hook asks the new daemon again, the card is
 *      back (the notice opens it) and 허용 there is the hook's decision;
 *   c. a dialog only the terminal holds (the hook gave up): the card says so and offers
 *      터미널에서 보기; answered in the terminal, the card goes and the old notice says it no longer waits.
 * Screenshots: agent-tycoon/artifacts/fix-permission-after-restart/. `--observe`: record, never stop on a check.
 *
 *   taskset -c 8,9 nice -n 10 npx tsx agent-tycoon/test/run-permission-restart.ts <port 19230-19239> [--observe]
 */
import type { Page, WebSocketRoute } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { PtyHostClient } from '../../server/src/agent-tycoon/ptyhost/client.js';
import { ptyhostPaths } from '../../server/src/agent-tycoon/ptyhost/protocol.js';
import {
  assertPortFree,
  type Daemon,
  isFakeOf,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 19230 && port <= 19239)) throw new Error('port: 19230-19239');
const OBSERVE = process.argv.includes('--observe');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/fix-permission-after-restart');
const DEADLINE_MS = 300_000;
const failures: string[] = [];

function check(ok: unknown, what: string): void {
  if (ok) return void console.log(`ok - ${what}`);
  if (!OBSERVE) throw new Error(`check failed: ${what}`);
  failures.push(what);
  console.log(`NOT - ${what}`);
}

async function until<T>(what: string, fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 30_000): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) {
      check(false, `in time: ${what}`);
      return null;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const read = (f: string): string => {
  try {
    return fs.readFileSync(f, 'utf-8');
  } catch {
    return '';
  }
};

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const host = ptyhostPaths(home);
  fs.writeFileSync(path.join(configDirectory(home), 'config.json'), JSON.stringify({ accessChosen: true, port }));
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify([{ name: 'alpha', folder, room: '개발실', wantRunning: true, provider: 'claude-pty' }]),
  );
  const permLog = () => read(path.join(home, 'fake-claude-perm.log')).split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { behavior: string }).behavior);
  const terminals = () => {
    try {
      return JSON.parse(read(host.terminals)) as Array<{ id: string; pid: number }>;
    } catch {
      return [];
    }
  };
  const hostPid = (): number => Number([...read(host.log).matchAll(/listening, pid (\d+)/g)].at(-1)?.[1] ?? 0);
  const boot = () =>
    startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-actions', '--allow-chat', '--no-terminal'], { FAKE_TURN_MS: '600' });
  let daemon: Daemon = boot();
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  const finish = async (code: number) => {
    await browser?.close().catch(() => undefined);
    await daemon.stop().catch(() => undefined);
    // The host and the fakes are ours (this test HOME's environment), nothing else.
    const pid = hostPid();
    if (pid && isFakeOf(pid, home)) process.kill(pid, 'SIGKILL');
    killFakeSessions(home);
    if (code === 0 && !failures.length) fs.rmSync(home, { recursive: true, force: true });
    else console.error(`left for a look: ${home}\n--- daemon log tail ---\n${daemon.log.join('').slice(-3000)}`);
    if (failures.length) console.log(`observed ${failures.length} failing check(s):\n  ${failures.join('\n  ')}`);
    process.exit(code);
  };
  const deadline = setTimeout(() => {
    console.error(`aborted: deadline ${DEADLINE_MS / 1000} s`);
    void finish(1);
  }, DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => void finish(1));

  try {
    browser = await launchBrowser();
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
    // The page's socket, so a test can drop the link (a phone losing Wi-Fi) without stopping the daemon.
    let cut = false;
    const links: WebSocketRoute[] = [];
    await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
      if (cut) return void ws.close();
      ws.connectToServer();
      links.push(ws);
    });
    const dropLink = async (down: boolean) => {
      cut = down;
      if (down) for (const ws of links.splice(0)) await ws.close();
    };
    const page = await ctx.newPage();
    const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
    const login = async () => {
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(`http://127.0.0.1:${port}/`);
    };
    await login();
    // wantRunning: the engine starts alpha in the PTY host at its start.
    const term = (await until('alpha in the PTY host', () => terminals()[0], 60_000))!;
    check(!!term, 'alpha runs in the PTY host');

    const messenger = page.getByRole('region', { name: '메신저', exact: true });
    const conv = messenger.getByRole('region', { name: 'alpha 대화' });
    const openConv = async () => {
      if (!(await messenger.isVisible())) await page.getByRole('button', { name: /^메신저/ }).first().click();
      const contact = messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ });
      await contact.waitFor({ timeout: 20_000 });
      if (!(await conv.isVisible())) await contact.click();
      await conv.waitFor();
    };
    const say = async (text: string) => {
      await openConv();
      const box = conv.getByRole('textbox', { name: '보낼 글' });
      await box.fill(text);
      await box.press('Enter');
    };
    const minimizeMessenger = () =>
      page.locator('[data-hud-window="messenger"]').getByRole('button', { name: '최소화' }).click();
    const bell = page.locator('[data-testid="notice-bell"], [data-testid="cc-seg-notices"]');
    const permNotice = () => page.getByTestId('notice-item').filter({ hasText: '허락' }).filter({ hasText: 'alpha' }).first();
    const openBell = async () => {
      await bell.first().click();
      await permNotice().waitFor({ timeout: 20_000 });
    };
    const permCard = conv.getByTestId('permission-card');

    // ── a. a pending permission: the notice opens the messenger on its card ──
    await say('FAKE-PERMISSION 첫 요청');
    await permCard.waitFor({ timeout: 30_000 });
    await minimizeMessenger();
    await openBell();
    await shot('a1-bell-pending');
    await permNotice().click();
    const landed = await permCard.waitFor({ timeout: 10_000 }).then(() => true, () => false);
    check(landed, 'a: the notice opens the messenger on the pending card');
    check(landed && (await permCard.getByRole('button', { name: '허용', exact: true }).isVisible()), 'a: the card has 허용');
    await shot('a2-notice-opens-card');

    // The link drops (the daemon runs on): the card stays, its buttons off with a reason (no answer waits for the socket).
    await dropLink(true);
    const offline = await permCard.getByTestId('permission-offline').waitFor({ timeout: 15_000 }).then(() => true, () => false);
    check(offline && (await permCard.getByRole('button', { name: '허용', exact: true }).isDisabled()), 'a: while disconnected 허용 is off and the card says why');
    await shot('a3-disconnected');
    await dropLink(false);
    await permCard.getByTestId('permission-offline').waitFor({ state: 'detached', timeout: 30_000 });
    check(await permCard.getByRole('button', { name: '허용', exact: true }).isEnabled(), 'a: back online, 허용 is on again');

    // ── b. the daemon restarts while it is pending ──
    await daemon.stop();
    await page.waitForTimeout(3_000);
    console.log(`b: the hook after the daemon went: ${JSON.stringify(permLog())}`);
    check(!permLog().includes('dialog'), 'b: the hook did not give up when the daemon went (no dialog in the terminal yet)');
    daemon = boot();
    await login();
    check(terminals()[0]?.pid === term.pid, 'b: the agent lives on in the host');
    await openBell();
    await shot('b1-bell-after-restart');
    await permNotice().click();
    await openConv();
    const back = await permCard.waitFor({ timeout: 20_000 }).then(() => true, () => false);
    await shot('b2-after-restart-opened');
    check(back, 'b: after the restart the notice opens the card again');
    const allow = permCard.getByRole('button', { name: '허용', exact: true });
    if (back && (await allow.isVisible())) {
      await allow.click();
      await until("the hook's decision after the restart", () => permLog().includes('allow'), 20_000);
      check(permLog().at(-1) === 'allow', `b: 허용 is the hook's decision (${JSON.stringify(permLog())})`);
      await permCard.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => undefined);
      await shot('b3-answered');
    } else check(false, 'b: the card after the restart has 허용');
    console.log(`b: the hook log: ${JSON.stringify(permLog())}`);

    // ── c. a dialog only the terminal holds ──
    const client = new PtyHostClient({ home, launch: () => undefined, log: () => undefined });
    if (permLog().includes('dialog') && permLog().at(-1) === 'dialog') {
      // b left Claude's own dialog up: answered there first, as the owner did.
      await client.connect(false);
      await client.write(term.id, '1');
    }
    await page.waitForTimeout(1_500);
    await say('FAKE-PERMISSION-TERMINAL 터미널 확인 창');
    await until('the dialog in the terminal', () => permLog().at(-1) === 'dialog', 20_000);
    const onlyTerminal = await permCard.waitFor({ timeout: 15_000 }).then(() => true, () => false);
    check(onlyTerminal, 'c: a dialog only the terminal holds still shows a card');
    if (onlyTerminal) {
      check(!(await permCard.getByRole('button', { name: '허용', exact: true }).isVisible()), 'c: no 허용 on it (only the terminal answers)');
      check(await permCard.getByRole('button', { name: '터미널에서 보기' }).isVisible(), 'c: it offers 터미널에서 보기');
    }
    await shot('c1-terminal-only-card');
    await client.connect(false);
    await client.write(term.id, '1');
    await until('answered in the terminal', () => permLog().at(-1) === 'terminal-allow', 15_000);
    await permCard.waitFor({ state: 'detached', timeout: 15_000 }).then(() => check(true, 'c: answered in the terminal, the card goes'), () => check(false, 'c: answered in the terminal, the card goes'));
    client.dispose();
    await minimizeMessenger();
    await openBell();
    await page.waitForTimeout(500);
    const said = await permNotice().innerText();
    check(/더 기다리지 않아요/.test(said), `c: the old notice says it no longer waits (${said.replaceAll('\n', ' / ')})`);
    await shot('c2-notice-no-longer-waits');

    clearTimeout(deadline);
    console.log(failures.length ? 'observed run done' : 'all checks passed');
    await finish(0);
  } catch (err) {
    console.error(err);
    const page: Page | undefined = browser?.contexts()[0]?.pages()[0];
    await page?.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => undefined);
    clearTimeout(deadline);
    await finish(1);
  }
}

void main();
