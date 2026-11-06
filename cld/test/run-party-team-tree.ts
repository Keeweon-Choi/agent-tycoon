/**
 * T-71 (owner 11-06 23:12 to 23:16), the party's team tree, end to end. Setup as in run-devroom-worktree-sidebar.ts:
 * dist/cli.js in a temp HOME on a spare port, the engine's fake claude (never a real claude), project
 * `shop-web` with its Lead, two Workers (one on an engine worktree) and two live sub-agents in the Lead's
 * transcript. parties.json (temp HOME) holds one party whose only member is the Lead. 모두 stays flat; the party
 * shows the Workers under the Lead and the sub-agent icons; a Worker's portrait opens its terminal, a sub icon
 * its card, whose button opens the read-only transcript; the Lead's 관계 tab lists its team. PC in 모던 and
 * 픽셀 감성 (Chromium --disable-gpu 1920x1080), phone WebKit 390x844. Screenshots in
 * cld/artifacts/feat-party-team-tree/.
 *
 *   nice -n 10 npx tsx cld/test/run-party-team-tree.ts <port 18293|18294>
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
if (port !== 18293 && port !== 18294) throw new Error('port: 18293 or 18294');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/feat-party-team-tree');
const DEADLINE_MS = 300_000;
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
let seq = 0;
const stamp = (r: Rec, cwd: string): Rec => ({ uuid: `u-${++seq}`, timestamp: new Date().toISOString(), cwd, ...r });
const call = (id: string, name: string, input: Rec) => ({ type: 'tool_use', id, name, input });
const text = (s: string) => ({ type: 'text', text: s });

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
  // The owner's party: the Lead only (its Workers and sub-agents come along, unstored).
  fs.writeFileSync(path.join(cfg, 'parties.json'), JSON.stringify({ v: 1, parties: [{ id: 'ptest', name: 'Agent Tycoon', members: ['shop-web'] }] }));

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
  let phoneBrowser: Browser | undefined;
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
    check(json(cli('worker', 'add', 'shop-web', 'web-worker')).ok === true, 'Worker web-worker added');
    check(json(cli('worker', 'add', 'shop-web', 'api-worker')).ok === true, 'Worker api-worker added');
    const id = json(cli('task', 'add', 'cart total', '--project', 'shop-web', '--assignee', 'web-worker', '--status', 'doing')).task?.id as string;
    check(json(cli('worktree', 'new', '--task', id, '--assign', 'web-worker')).ok === true, `${id} gets an engine worktree`);

    await eventually("the Lead's transcript", () => { const f = transcriptOf('shop-web'); return !!f && fs.existsSync(f); });
    const lead = transcriptOf('shop-web')!;
    const at = (r: Rec) => stamp(r, shop.folder);
    const said = (content: Rec[]): Rec => ({ type: 'assistant', message: { model: 'claude-opus-4-5', content } });
    const sub = (parent: string, msg: Rec): Rec => at({ type: 'progress', parentToolUseID: parent, data: { type: 'agent_progress', message: msg } });
    const SUBS = [
      { id: 'tu-cart', desc: 'Fix the cart total' },
      { id: 'tu-search', desc: 'Run the search tests' },
    ];
    const records: Rec[] = [
      at(said([text('Two jobs, handed out.'), ...SUBS.map((s) => call(s.id, 'Agent', { description: s.desc, prompt: s.desc, subagent_type: 'general-purpose' }))])),
      sub('tu-cart', said([call('c1', 'Read', { file_path: path.join(shop.folder, 'README.md') })])),
      sub('tu-search', said([call('s1', 'Bash', { command: 'npm test', description: 'tests' })])),
    ];
    for (const r of records) fs.appendFileSync(lead, `${JSON.stringify(r)}\n`);

    browser = await launchBrowser();
    const seen = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version.split('.').slice(0, 2).join('.');
    const newPage = async (b: Browser, opts: Parameters<Browser['newContext']>[0], theme: string, party: boolean) => {
      const ctx = await b.newContext(opts);
      await ctx.addInitScript(([v, th, p]) => {
        localStorage.setItem('cld.changelogSeen', v);
        localStorage.setItem('cld.ui-theme', th);
        if (p) localStorage.setItem('cld.party-selected', p);
      }, [seen, theme, party ? 'ptest' : ''] as const);
      const p = await ctx.newPage();
      await p.goto(await daemon.loginUrl());
      await p.waitForURL(`http://127.0.0.1:${port}/`);
      const toast = await p.getByText(/으로 업데이트됐어요/).first().textContent({ timeout: 5_000 }).catch(() => null);
      const v = toast?.match(/v([\d.]+)/)?.[1];
      if (v) {
        await p.evaluate((x) => localStorage.setItem('cld.changelogSeen', x), v);
        await p.reload();
      }
      return p;
    };
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
    const portraits = (p: Page) => p.locator('[data-testid="agent-card"][data-portrait]').evaluateAll((els) => els.map((e) => `${e.getAttribute('title')}${e.closest('.party-worker') ? '>' : ''}`));

    /** The Lead's portrait, then its 관계 tab; a press while the page still settles can be lost, so press until the card is up. */
    const openLeadTeam = async (p: Page) => {
      for (const end = Date.now() + 30_000; (await p.getByTestId('member-tab-team').count()) === 0; await p.waitForTimeout(1_000)) {
        if (Date.now() > end) throw new Error('the Lead card did not open');
        await p.locator('[data-testid="agent-card"][title="shop-web"]').first().click();
        await p.waitForTimeout(800);
      }
      await p.getByTestId('member-tab-team').click();
    };

    // ── 모두: flat, no worker grouping, no sub-agent icons ──
    const all = await newPage(browser, { viewport: { width: 1920, height: 1080 } }, 'modern', false);
    await all.locator('[data-testid="agent-card"]').nth(2).waitFor({ timeout: 40_000 });
    await all.waitForTimeout(1500);
    const flat = await portraits(all);
    check(flat.length >= 3 && flat.every((n) => !n.endsWith('>')), `모두 is flat: ${flat.join(', ')}`);
    check((await all.getByTestId('party-subs').count()) === 0, '모두 shows no sub-agent icons');
    await shot(all, 'pc-modern-all');

    // ── The owner's party, 모던 ──
    const desk = await newPage(browser, { viewport: { width: 1920, height: 1080 } }, 'modern', true);
    await desk.getByTestId('party-sub').first().waitFor({ timeout: 40_000 });
    await desk.waitForTimeout(1500);
    const tree = await portraits(desk);
    check(tree[0] === 'shop-web' && tree.length === 3 && tree.slice(1).every((n) => n.endsWith('>')), `the party lists the Lead, then its Workers one step in: ${tree.join(', ')}`);
    check((await desk.getByTestId('party-sub').count()) === 2, 'two sub-agent icons under the Lead');
    await shot(desk, 'pc-modern-party');
    // The Lead's card, its 관계 tab.
    await openLeadTeam(desk);
    await desk.getByTestId('member-relations').waitFor({ timeout: 10_000 });
    check((await desk.getByTestId('member-rel').count()) === 4, 'the Lead\'s 관계 tab lists 2 Workers and 2 sub-agents');
    await desk.waitForTimeout(400);
    await shot(desk, 'pc-modern-lead-relations');
    await desk.getByTestId('inspector-close').click();
    // A sub-agent icon: its small card.
    await desk.getByTestId('party-sub').first().click();
    await desk.getByTestId('sub-card-head').waitFor({ timeout: 10_000 });
    check((await desk.getByTestId('member-rel').count()) === 4, 'the sub-agent card lists the Lead, both Workers and the other sub-agent');
    await desk.waitForTimeout(400);
    await shot(desk, 'pc-modern-sub-card');
    await desk.getByTestId('sub-open').click();
    const win = desk.locator('[data-hud-window="devroom"]');
    await win.locator('[data-testid="devroom-pane"][data-agent="shop-web"] [data-testid="devroom-sub-view"]').first().waitFor({ timeout: 30_000 });
    check(true, "the card's button opens the sub-agent's read-only transcript in the dev room");
    await desk.waitForTimeout(500);
    await shot(desk, 'pc-modern-sub-transcript');
    // A Worker's portrait opens its terminal.
    await desk.locator('[data-testid="agent-card"][title="web-worker"]').click();
    await win.locator('[data-testid="devroom-pane"][data-agent="web-worker"]').waitFor({ timeout: 30_000 });
    check(true, "a Worker's portrait opens the dev room on that Worker");
    await desk.waitForTimeout(500);
    await shot(desk, 'pc-modern-worker-terminal');

    // ── 픽셀 감성 ──
    const pix = await newPage(browser, { viewport: { width: 1920, height: 1080 } }, 'pixel', true);
    await pix.getByTestId('party-sub').first().waitFor({ timeout: 40_000 });
    await pix.waitForTimeout(1200);
    await shot(pix, 'pc-pixel-party');
    await openLeadTeam(pix);
    await pix.getByTestId('member-relations').waitFor({ timeout: 10_000 });
    await pix.waitForTimeout(400);
    await shot(pix, 'pc-pixel-lead-relations');
    await pix.getByTestId('inspector-close').click();
    await pix.getByTestId('party-sub').first().click();
    await pix.getByTestId('sub-card-head').waitFor({ timeout: 10_000 });
    await pix.waitForTimeout(400);
    await shot(pix, 'pc-pixel-sub-card');

    // ── Phone (WebKit 390x844) ──
    phoneBrowser = await launchBrowser({ webkit: true });
    const phone = await newPage(phoneBrowser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, 'modern', true);
    await phone.getByTestId('party-sub').first().waitFor({ timeout: 40_000 });
    await phone.waitForTimeout(1200);
    const strip = await portraits(phone);
    check(strip[0] === 'shop-web' && strip.slice(1).every((n) => n.endsWith('>')), `phone: the strip lists the Lead, then its Workers: ${strip.join(', ')}`);
    await shot(phone, 'phone-strip');
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `phone: no sideways scroll (${overflow})`);
    await phone.getByTestId('party-sub').first().tap();
    await phone.getByTestId('sub-card-head').waitFor({ timeout: 10_000 });
    await phone.waitForTimeout(500);
    await shot(phone, 'phone-sub-card');

    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    fs.writeFileSync(path.join(os.tmpdir(), 'run-party-team-tree.daemon.log'), daemon.log.join(''));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await phoneBrowser?.close();
    await daemon.stop();
    killFakeSessions(home);
    shop.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
