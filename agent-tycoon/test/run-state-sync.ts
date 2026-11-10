/**
 * STATE-SYNC check (owner 11-04 21:24: pofol waiting on its training job read 쉬는 중 in the office
 * while the engine had it on). dist/cli.js with --engine on in a temp HOME whose `claude` is the
 * engine fake: the project `pofol` runs in our PTY host (claude-pty). Headless Chromium without a
 * GPU, desktop 1280x800, the page clock installed so 31 minutes pass at once.
 * Scenes, each read from the DOM on every surface (the character's status icon, the party
 * portrait, the messenger's contact dot and conversation header):
 *   long        a foreground tool call open 40 s, the transcript quiet (FAKE-LONG)
 *   long+31m    the same, 31 minutes later by the page clock
 *   (a daemon restart mid-turn is turnState.test.ts's: the engine's revive notice types a turn
 *   of its own into the session on a restart, so the call is no longer quiet)
 *   long done   its turn ended: rest (negative control)
 *   job         its turn ended while a background shell runs (FAKE-JOB: Claude Code's `shell`)
 *   job+31m     the same, 31 minutes later
 * Every scene but `long done` must read work on every surface, and `long done` rest on every one.
 * --report: print the table and do not fail (the build before the fix: the reproduction).
 * Screenshots: agent-tycoon/artifacts/state-sync-1104/<build>-<scene>.png.
 *
 *   nice -n 10 npx tsx agent-tycoon/test/run-state-sync.ts <port 18460-18469> [--report] [--cli other/dist/cli.js] [--tag old]
 */
import type { Page } from '@playwright/test';
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

const argv = process.argv.slice(2);
const port = Number(argv[0]);
if (!(port >= 18460 && port <= 18469)) throw new Error('STATE-SYNC runs on 18460-18469');
const REPORT = argv.includes('--report');
const opt = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const CLI = opt('--cli') ? path.resolve(opt('--cli')!) : path.join(REPO_ROOT, 'dist/cli.js');
const TAG = opt('--tag') ?? 'new';
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/state-sync-1104');
const DEADLINE_MS = 360_000;
const LONG_S = 40;
const HIDE = '[data-testid="fx-dev-bar"], [data-testid="update-notice"] { display: none !important; }';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, fn: () => Promise<boolean> | boolean, ms = 30_000): Promise<void> {
  for (const end = Date.now() + ms; ; await sleep(200)) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}
const read = (f: string): string => {
  try {
    return fs.readFileSync(f, 'utf-8');
  } catch {
    return '';
  }
};
let oks = 0;
const fails: string[] = [];
function check(ok: unknown, what: string): void {
  if (ok) {
    oks++;
    console.log(`ok - ${what}`);
  } else if (REPORT) fails.push(what);
  else throw new Error(`check failed: ${what}`);
}

interface Look {
  character: string;
  party: string;
  contact: string;
  header: string;
}
const WORK_RING = '일하는 중';
const REST_RING = '쉬는 중';

/** pofol's state on every surface, from the DOM only (any build). */
async function look(page: Page, id: number): Promise<Look> {
  return page.evaluate((id) => {
    const q = (sel: string) => document.querySelector(sel);
    const messenger = q('section[aria-label="메신저"]');
    const contact = [...(messenger?.querySelectorAll('li') ?? [])].find((li) => li.textContent?.includes('pofol'));
    const header = q('section[aria-label="pofol 대화"]');
    return {
      character: q(`[data-testid="agent-overlay"][data-agent-id="${id}"] [data-testid="status-icon"]`)?.getAttribute('aria-label') ?? '(none)',
      // The party: its portrait (folded bar) or its card's state icon (the card bar).
      party:
        (q(`[data-portrait][data-agent-id="${id}"]`) ?? q(`[data-testid="agent-card"][data-agent-id="${id}"] .game-state`))?.getAttribute(
          'data-state',
        ) ?? '(none)',
      contact: contact?.querySelector('[data-testid="lead-state"]')?.getAttribute('data-state') ?? '(none)',
      header: header?.querySelector('[data-testid="lead-state"]')?.getAttribute('data-state') ?? '(none)',
    };
  }, id);
}

const atWork = (l: Look) => ({
  character: l.character.startsWith(WORK_RING),
  party: l.party === 'work',
  contact: l.contact === 'working' || l.contact === 'thinking',
  header: l.header === 'working' || l.header === 'thinking',
});
const atRest = (l: Look) => ({
  character: l.character.startsWith(REST_RING),
  party: l.party === 'rest',
  contact: l.contact === 'resting',
  header: l.header === 'resting',
});

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const host = ptyhostPaths(home);
  fs.writeFileSync(path.join(configDirectory(home), 'config.json'), JSON.stringify({ accessChosen: true, port }));
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  const folder = path.join(home, 'work', 'pofol');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify([{ name: 'pofol', folder, room: '개발실', wantRunning: true, provider: 'claude-pty' }]),
  );
  const terminals = () => {
    try {
      return JSON.parse(read(host.terminals)) as Array<{ id: string; pid: number }>;
    } catch {
      return [];
    }
  };
  const hostPid = (): number => {
    const m = [...read(host.log).matchAll(/listening, pid (\d+)/g)].at(-1);
    return m ? Number(m[1]) : 0;
  };
  /** The fake's session file status (busy, shell, idle). */
  const status = (): string | undefined => {
    const dir = path.join(home, '.claude/sessions');
    for (const f of fs.readdirSync(dir)) {
      try {
        const s = JSON.parse(read(path.join(dir, f))) as { name?: string; status?: string };
        if (s.name === 'pofol') return s.status;
      } catch {
        /* being written */
      }
    }
    return undefined;
  };
  const start = () =>
    startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--no-terminal', '--allow-chat'], { FAKE_TURN_MS: '600' }, false, CLI);
  const daemon: Daemon = start();
  const browser = await launchBrowser();
  const client = new PtyHostClient({ home, launch: () => undefined, log: () => undefined });
  const pageErrors: string[] = [];
  const table: Array<[string, Look]> = [];
  let code = 0;
  const deadline = setTimeout(() => {
    console.error(`STATE-SYNC: past the deadline ${DEADLINE_MS / 1000} s`);
    process.exit(1);
  }, DEADLINE_MS);
  try {
    await until('pofol runs in the PTY host', () => terminals().length > 0, 60_000);
    const [term] = terminals();
    await sleep(1_500);
    const type = async (text: string) => {
      const r = await client.write(term.id, `\x1b[200~${text}\x1b[201~`);
      if (!r.ok) throw new Error(`typing into ${term.id} failed`);
      await sleep(200);
      await client.write(term.id, '\r');
    };
    await type('hello'); // a first turn: its transcript
    await until('the first turn ended', () => status() === 'idle', 20_000);

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;');
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await page.clock.install();
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(BASE);
    await page.addStyleTag({ content: HIDE });
    const idOf = () =>
      page.$$eval('[data-testid="agent-overlay"]', (nodes) => {
        const n = nodes.find((x) => x.querySelector('[data-testid="agent-name"]')?.textContent === 'pofol');
        return n ? Number(n.getAttribute('data-agent-id')) : null;
      });
    await until('pofol is in the office', async () => (await idOf()) !== null, 45_000);
    const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
    if (await closeInfo.count()) await closeInfo.click();
    const openMessenger = async () => {
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      if (!(await messenger.count()))
        await page.getByRole('button', { name: /^메신저/ }).first().click({ timeout: 60_000 });
      await messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /pofol/ }).first().click();
      await page.getByRole('region', { name: 'pofol 대화' }).waitFor();
    };
    await openMessenger();
    await sleep(6_000); // past the page's settle window

    const scene = async (name: string, want: 'work' | 'rest') => {
      const id = (await idOf())!;
      await sleep(3_000); // a snapshot or two
      const l = await look(page, id);
      table.push([name, l]);
      await page.screenshot({ path: path.join(OUT, `${TAG}-${name.replace(/\W+/g, '-')}.png`) });
      const ok = (want === 'work' ? atWork : atRest)(l);
      for (const [surface, good] of Object.entries(ok))
        check(good, `${name}: ${surface} reads ${want} (${l[surface as keyof Look]})`);
    };
    const later = async () => {
      await page.clock.fastForward('31:00');
      await sleep(1_000);
    };

    await type(`FAKE-LONG ${LONG_S}`);
    await until('the long tool call runs', () => status() === 'busy');
    await scene('long', 'work');
    await later();
    await scene('long+31m', 'work');
    await until('the long turn ended', () => status() === 'idle', (LONG_S + 30) * 1000);
    await scene('long done', 'rest');

    await type('FAKE-JOB 600');
    await until('the job runs in the background', () => status() === 'shell');
    await scene('job', 'work');
    await later();
    await scene('job+31m', 'work');
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ') || 'none'})`);
  } catch (err) {
    code = 1;
    console.error(err);
    for (const p of browser.contexts().flatMap((c) => c.pages()))
      await p.screenshot({ path: path.join(OUT, `${TAG}-failed.png`) }).catch(() => undefined);
    console.error(`--- daemon log tail ---\n${daemon.log.join('').slice(-3000)}`);
  } finally {
    clearTimeout(deadline);
    console.log(`\n| ${TAG} scene | character (status icon) | party | messenger contact | messenger header |`);
    console.log('|---|---|---|---|---|');
    for (const [n, l] of table) console.log(`| ${n} | ${l.character} | ${l.party} | ${l.contact} | ${l.header} |`);
    if (fails.length) console.log(`\nnot in agreement (${fails.length}):\n- ${fails.join('\n- ')}`);
    client.dispose();
    await browser.close().catch(() => undefined);
    await daemon.stop().catch(() => undefined);
    // The host and the fakes are this test HOME's, nothing else.
    const hp = hostPid();
    if (hp && isFakeOf(hp, home)) process.kill(hp, 'SIGKILL');
    killFakeSessions(home);
    if (code === 0) fs.rmSync(home, { recursive: true, force: true });
    else console.error(`left for a look: ${home}`);
  }
  console.log(`${oks} checks passed`);
  process.exit(code);
}

void main();
