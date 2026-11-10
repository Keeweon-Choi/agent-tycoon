/**
 * T-74, the blank screen of 11-06 23:43, end to end. dist/cli.js in a temp HOME on a spare port, the engine's
 * fake claude (never a real one): project `shop-web` with its Lead, two Workers and a reviewer; the Lead's
 * transcript holds a sub-agent with progress, a spawn with no progress yet (the "quiet" sub-agent that made
 * useSubs loop: React #185, every page blank) and progress whose spawn is unknown. parties.json holds the
 * owner's party (the Lead only) and one with a member that is not on screen.
 *
 * 1. The trigger is gone: the office loads in 모두 and in the party, a party composed in the UI as the owner
 *    did, the Lead's 관계 tab and a sub-agent card open, the daemon restarts (a deploy) while they are open:
 *    no page error, the root never empties.
 * 2. A region that breaks breaks alone: a forced render error in the messenger (isE2E probe) shows its card;
 *    the party, the dev room and the office keep working; 다시 열기 brings the messenger back; the daemon log
 *    has `[Webview] boundary in messenger ...`; a window error and an unhandled rejection are logged too,
 *    a token in one masked. PC Chromium --disable-gpu 1920x1080, 모던 and 픽셀 감성.
 * Screenshots in agent-tycoon/artifacts/fix-webview-blank-screen/.
 *
 *   nice -n 10 npx tsx agent-tycoon/test/run-webview-blank-screen.ts <port 18331|18332>
 */
import type { Browser, Page } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { makeTempRepo } from '../../server/src/agent-tycoon/engine/git/testRepo.js';
import { ptyhostPaths } from '../../server/src/agent-tycoon/ptyhost/protocol.js';
import { assertPortFree, killFakeSessions, launchBrowser, makeEngineHome, REPO_ROOT, startDaemon } from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (port !== 18331 && port !== 18332) throw new Error('port: 18331 or 18332');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/fix-webview-blank-screen');
const DEADLINE_MS = 360_000;
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
let seq = 0;
const pageErrors: string[] = [];

/** The PTY host our daemon started for this temp HOME (it outlives a daemon on purpose): only that one. */
function killOurPtyHost(home: string): void {
  const arg = ptyhostPaths(home).dir;
  for (const entry of fs.readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (argv.some((a) => a.endsWith('agty-ptyhost.js')) && argv.includes(arg)) process.kill(pid, 'SIGKILL');
    } catch {
      // gone, or not ours to read
    }
  }
}

async function main() {
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const shop = makeTempRepo();
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify({ v: 2, projects: [{ projectId: 'p_aaaaaaaaaa', name: 'shop-web', folder: shop.folder, room: 'dev', leadAssignmentId: 'a_aaaaaaaaaa' }] }),
  );
  fs.writeFileSync(
    path.join(cfg, 'assignments.json'),
    JSON.stringify({ v: 1, assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude-pty', wantRunning: true }] }),
  );
  fs.writeFileSync(
    path.join(cfg, 'parties.json'),
    JSON.stringify({ v: 1, parties: [{ id: 'ptest', name: 'Agent Tycoon', members: ['shop-web'] }, { id: 'pghost', name: 'Ghosts', members: ['nobody-here'] }] }),
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
  const logs: string[][] = [daemon.log];
  const daemonLog = () => logs.map((l) => l.join('')).join('');
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  const opened: Page[] = [];
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL');
  }, DEADLINE_MS);
  try {
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [path.join(REPO_ROOT, 'agent-tycoon/bin/agty'), ...args], { env: { PATH, HOME: home, AGTY_OUTPUT: 'json' }, encoding: 'utf8', timeout: 60_000 });
    const json = (r: ReturnType<typeof cli>) => JSON.parse(r.stdout || '{}') as Record<string, unknown>;
    const transcriptOf = (name: string) => {
      for (const file of fs.readdirSync(path.join(home, '.claude/sessions'))) {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(home, '.claude/sessions', file), 'utf8')) as { name: string; sessionId: string; cwd: string };
          if (s.name === name) return path.join(home, '.claude/projects', s.cwd.replace(/[^a-zA-Z0-9-]/g, '-'), `${s.sessionId}.jsonl`);
        } catch {
          /* written as we read */
        }
      }
      return undefined;
    };
    await daemon.loginUrl();
    await eventually("the Lead's transcript", () => {
      const f = transcriptOf('shop-web');
      return !!f && fs.existsSync(f);
    }, 60_000);
    check(json(cli('worker', 'add', 'shop-web', 'web-worker')).ok === true, 'Worker web-worker added');
    check(json(cli('worker', 'add', 'shop-web', 'api-worker')).ok === true, 'Worker api-worker added');
    check(json(cli('worker', 'add', 'shop-web', 'rev', '--role', 'reviewer')).ok === true, 'Reviewer rev added');
    const at = (r: Rec): Rec => ({ uuid: `u-${++seq}`, timestamp: new Date().toISOString(), cwd: shop.folder, ...r });
    const said = (content: Rec[]): Rec => ({ type: 'assistant', message: { model: 'claude-opus-4-5', content } });
    const call = (id: string, name: string, input: Rec) => ({ type: 'tool_use', id, name, input });
    const sub = (parent: string, msg: Rec): Rec => at({ type: 'progress', parentToolUseID: parent, data: { type: 'agent_progress', message: msg } });
    for (const r of [
      at(said([
        call('tu-cart', 'Agent', { description: 'Fix the cart total', prompt: 'x', subagent_type: 'general-purpose' }),
        call('tu-quiet', 'Agent', { description: 'Just spawned', prompt: 'x', subagent_type: 'general-purpose' }), // no progress: quiet
      ])),
      sub('tu-cart', said([call('c1', 'Read', { file_path: path.join(shop.folder, 'README.md') })])),
      sub('tu-orphan', said([call('o1', 'Bash', { command: 'ls', description: 'ls' })])), // its spawn is not known
    ])
      fs.appendFileSync(transcriptOf('shop-web')!, `${JSON.stringify(r)}\n`);

    browser = await launchBrowser();
    const seen = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version.split('.').slice(0, 2).join('.');
    const newPage = async (theme: string, party: string) => {
      const ctx = await browser!.newContext({ viewport: { width: 1920, height: 1080 } });
      await ctx.addInitScript(([v, th, p]) => {
        (window as unknown as { __AGENT_TYCOON_E2E: boolean }).__AGENT_TYCOON_E2E = true;
        localStorage.setItem('agty.changelogSeen', v);
        localStorage.setItem('agty.ui-theme', th);
        if (p) localStorage.setItem('agty.party-selected', p);
      }, [seen, theme, party] as const);
      const p = await ctx.newPage();
      opened.push(p);
      p.on('pageerror', (e) => pageErrors.push(`${theme}/${party || 'all'}: ${e.message}`));
      await p.goto(await daemon.loginUrl());
      await p.waitForURL(`http://127.0.0.1:${port}/`);
      const toast = await p.getByText(/으로 업데이트됐어요/).first().textContent({ timeout: 5_000 }).catch(() => null);
      const v = toast?.match(/v([\d.]+)/)?.[1];
      if (v) {
        await p.evaluate((x) => localStorage.setItem('agty.changelogSeen', x), v);
        await p.reload();
      }
      await p.getByTestId('party-select').waitFor({ timeout: 40_000 }); // a party whose member is not on screen shows no portrait
      await p.waitForTimeout(1500);
      return p;
    };
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
    const filled = (p: Page) => p.evaluate(() => (document.getElementById('root')?.childElementCount ?? 0) > 0 && !document.querySelector('[data-testid="region-crash"]'));
    const lead = (p: Page) => p.locator('[data-testid="agent-card"][title="shop-web"]').first();
    const dock = (p: Page, id: string) => p.locator(`[data-hud-id="icon:${id}"] button`).first();
    const openLeadTeam = async (p: Page) => {
      for (const end = Date.now() + 30_000; (await p.getByTestId('member-tab-team').count()) === 0; await p.waitForTimeout(800)) {
        if (Date.now() > end) throw new Error('the Lead card did not open');
        await lead(p).click();
      }
      await p.getByTestId('member-tab-team').click();
      await p.getByTestId('member-relations').waitFor({ timeout: 10_000 });
    };

    // ── 1. The trigger: a quiet sub-agent no longer empties the page ──
    const all = await newPage('modern', '');
    check(await filled(all), '모두: the office is up with a quiet sub-agent in the Lead transcript');
    await all.getByTestId('party-select').click();
    await all.getByTestId('party-new').click();
    await all.getByTestId('party-name').fill('Agent Tycoon 2');
    await all.getByTestId('party-name-save').click();
    await all.locator('[data-testid="party-pick"][data-member="shop-web"]').click();
    await all.getByTestId('party-members-done').click();
    await all.getByTestId('party-sub').first().waitFor({ timeout: 20_000 });
    check(await filled(all), 'a party composed in the UI (the Lead only) shows its team, the page stays');
    await openLeadTeam(all);
    check(await filled(all), "the Lead's 관계 tab opens");
    await shot(all, '1-composed-party-relations');
    const party = await newPage('modern', 'ptest');
    await party.getByTestId('party-sub').first().click();
    await party.getByTestId('sub-card-head').waitFor({ timeout: 10_000 });
    await dock(party, 'devroom').click();
    await party.locator('[data-hud-window="devroom"]').waitFor({ timeout: 20_000 });
    const ghosts = await newPage('pixel', 'pghost');
    check(await filled(party) && await filled(ghosts), 'the stored party with a sub-agent card and the dev room open, and a party whose member is not on screen');

    // A deploy: the daemon restarts while the panels are open; the parties are gone after it.
    await daemon.stop();
    fs.writeFileSync(path.join(cfg, 'parties.json'), JSON.stringify({ v: 1, parties: [] }));
    daemon = start();
    logs.push(daemon.log);
    await daemon.loginUrl();
    await eventually('the pages reconnect', async () => (await all.getByTestId('party-select').getAttribute('data-party')) === 'all', 40_000);
    await party.waitForTimeout(3000);
    check(await filled(all) && await filled(party) && await filled(ghosts), 'a reconnect with the panels open and an empty parties list keeps every page');
    check(pageErrors.length === 0, `no page error so far${pageErrors.length ? `: ${pageErrors.join(' | ')}` : ''}`);
    await shot(party, '1-after-restart');

    // ── 2. A region that breaks breaks alone ──
    for (const theme of ['modern', 'pixel'] as const) {
      const p = theme === 'modern' ? party : ghosts;
      await p.keyboard.press('Escape');
      await p.evaluate(() => ((window as unknown as { __AGENT_TYCOON_CRASH?: string }).__AGENT_TYCOON_CRASH = 'messenger'));
      await dock(p, 'messenger').click();
      const card = p.locator('[data-hud-window="messenger"] [data-testid="region-crash"]');
      await card.waitFor({ timeout: 10_000 });
      check((await card.textContent())?.includes('test crash in messenger'), `${theme}: the messenger shows its crash card with what broke`);
      await openLeadTeam(p);
      await dock(p, 'devroom').click();
      await p.locator('[data-hud-window="devroom"]').waitFor({ timeout: 20_000 });
      check(
        (await p.evaluate(() => document.querySelectorAll('[data-testid="region-crash"]').length)) === 1 && (await p.locator('canvas').count()) > 0,
        `${theme}: the party card, the dev room and the office still work beside it`,
      );
      await shot(p, `2-${theme}-messenger-crashed`);
      await p.evaluate(() => delete (window as unknown as { __AGENT_TYCOON_CRASH?: string }).__AGENT_TYCOON_CRASH);
      await dock(p, 'messenger').click(); // open behind the dev room: a press brings it to front
      await p.waitForTimeout(300);
      await shot(p, `2-${theme}-messenger-card-in-front`);
      await p.locator('[data-hud-window="messenger"]').getByTestId('region-reopen').click();
      await p.locator('[data-hud-window="messenger"] [data-testid="region-crash"]').waitFor({ state: 'detached', timeout: 10_000 });
      check(await filled(p), `${theme}: 다시 열기 mounts the messenger again`);
      await shot(p, `2-${theme}-messenger-reopened`);
    }
    await eventually('the boundary report in the daemon log', () => /\[Webview\] boundary in messenger: Error: test crash in messenger\n {2}stack:/.test(daemonLog()));
    check(/ {2}components:\n {4}at /.test(daemonLog()), 'the daemon logged [Webview] boundary in messenger with its stack and component stack');
    await party.evaluate(() => {
      setTimeout(() => {
        throw new Error('probe window error token=abcd1234efgh5678');
      });
      void Promise.reject(new Error('probe rejection'));
    });
    await eventually('the window error and the rejection in the daemon log', () => /\[Webview\] error: Error: probe window error/.test(daemonLog()) && /\[Webview\] rejection: Error: probe rejection/.test(daemonLog()));
    check(!daemonLog().includes('abcd1234efgh5678') && daemonLog().includes('token=***'), 'the window error and the rejection are logged, the token masked');
    check(daemon.child.exitCode === null, 'the daemon is still running');
    const lines = daemonLog().split('\n').filter((l) => l.includes('[Webview]'));
    fs.writeFileSync(path.join(OUT, 'daemon-webview-lines.txt'), `${lines.join('\n')}\n`);
    const unexpected = pageErrors.filter((e) => !/test crash in messenger|probe /.test(e));
    check(unexpected.length === 0, `no other page error${unexpected.length ? `: ${unexpected.join(' | ')}` : ''}`);

    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    fs.writeFileSync(path.join(os.tmpdir(), 'run-webview-blank-screen.daemon.log'), daemonLog());
    for (const [i, p] of opened.entries()) await p.screenshot({ path: path.join(OUT, `failure-${i}.png`) }).catch(() => undefined);
    console.error(`page errors: ${pageErrors.join('\n')}`);
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    killOurPtyHost(home);
    shop.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
