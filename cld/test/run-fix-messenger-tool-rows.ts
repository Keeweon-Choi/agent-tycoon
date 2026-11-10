/**
 * FIX-MESSENGER-TOOL-ROWS (owner 11-06 23:43, T-75): a Lead's burst of MCP calls. dist/cli.js in a temp HOME on a
 * spare port, the engine's fake claude as Lead `alpha`; its transcript gets 16 update_task calls, a create_task
 * and a call of another server's tool between lines of text. The conversation must show ONE folded row
 * "... x16" that opens into the single rows, the create_task by its Korean name and the other tool as
 * "server · tool". Desktop (Chromium --disable-gpu) folded and expanded, then the phone.
 * Pictures in cld/artifacts/fix-messenger-tool-rows/.
 *
 *   nice -n 10 taskset -c 12-19 npx tsx cld/test/run-fix-messenger-tool-rows.ts <port 18260-18599>
 */
import type { Browser, Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort(2);
const OUT = path.join(REPO_ROOT, 'cld/artifacts/fix-messenger-tool-rows');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__tr/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 180_000;
const CALLS = 16;

const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  console.log(`ok - ${text}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(what: string, test: () => boolean, timeout = 20_000): Promise<void> {
  for (const end = Date.now() + timeout; ; await wait(200)) {
    if (test()) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  fs.writeFileSync(path.join(configDirectory(home), 'config.json'), JSON.stringify({ accessChosen: true, port }));
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify([{ name: 'alpha', folder, wantRunning: true }]),
  );
  const daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-chat', '--no-terminal'], {
    FAKE_TURN_MS: '400',
  });
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL');
  }, DEADLINE_MS);
  try {
    type Session = { name: string; cwd: string; sessionId: string };
    const session = (): Session | null => {
      const dir = path.join(home, '.claude/sessions');
      for (const file of fs.readdirSync(dir)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Session;
          if (parsed.name === 'alpha') return parsed;
        } catch {
          /* a fake is writing */
        }
      }
      return null;
    };
    await eventually('the fake session', () => !!session());
    let serial = 0;
    const append = (role: 'user' | 'assistant', content: unknown) => {
      const s = session()!;
      const file = transcriptPath(s.cwd, s.sessionId, home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const uuid = `${(++serial).toString(16).padStart(8, '0')}-0099-4000-8000-000000000000`;
      fs.appendFileSync(file, `${JSON.stringify({ type: role, uuid, timestamp: new Date().toISOString(), message: { role, content } })}\n`);
    };
    const say = (role: 'user' | 'assistant', text: string) => append(role, role === 'user' ? text : [{ type: 'text', text }]);
    const call = (name: string, input: Record<string, unknown>) =>
      append('assistant', [{ type: 'tool_use', id: `toolu_${serial}`, name, input }]);
    say('user', 'ship the batch');
    say('assistant', 'REPLY-BEFORE: moving the issues along');
    for (let i = 0; i < CALLS; i++) call('mcp__agty__update_task', { taskId: `T-${40 + i}`, status: 'done' });
    say('assistant', 'REPLY-MIDDLE: now a new issue');
    call('mcp__agty__create_task', { title: 'Follow up the toast' });
    call('mcp__notion__notion-search', { query: 'toast' });
    say('assistant', 'REPLY-AFTER: done');

    const font = fs.existsSync(FONT) ? fs.readFileSync(FONT) : null;
    browser = await launchBrowser();
    const run = async (label: string, opts: Parameters<Browser['newContext']>[0], tap: (l: Locator) => Promise<void>) => {
      const ctx = await browser!.newContext(opts);
      if (font) await ctx.route('**/__tr/malgun.ttf', (route) => route.fulfill({ body: font, contentType: 'font/ttf' }));
      const page: Page = await ctx.newPage();
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      await page.addStyleTag({ content: FONT_CSS });
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      await tap(page.getByRole('button', { name: /^메신저/ }));
      await tap(messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }));
      const conv = messenger.getByRole('region', { name: 'alpha 대화' });
      await conv.getByText('REPLY-AFTER: done').waitFor({ timeout: 20_000 });
      const runs = conv.getByTestId('tool-run');
      check((await runs.count()) === 1, `${label}: one folded run`);
      check((await runs.first().getAttribute('data-count')) === String(CALLS), `${label}: it holds ${CALLS} calls`);
      const folded = await runs.first().innerText();
      check(folded.includes(`×${CALLS}`), `${label}: it reads "${folded}"`);
      check(!(await conv.innerText()).includes('Using mcp__agty__update_task'), `${label}: no raw "Using mcp__..." line shows`);
      const all = await conv.innerText();
      check(all.includes('notion · notion-search'), `${label}: the other server's tool reads server · tool`);
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, `${label}-1-folded.png`) });
      await tap(runs.first().locator('summary'));
      await wait(600);
      check((await conv.locator('details:not([data-testid="tool-run"])').filter({ hasText: /\S/ }).count()) >= CALLS - 1 + 2, `${label}: opening shows the single rows`);
      await runs.first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(OUT, `${label}-2-expanded.png`) });
      await ctx.close();
    };
    await run('desktop', { viewport: { width: 1400, height: 1000 } }, (l) => l.click());
    const { defaultBrowserType: _ignored, ...iphone } = devices['iPhone 13'];
    await run('phone', iphone, (l) => l.tap());
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
