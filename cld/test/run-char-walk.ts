/**
 * CHAR-ISO-1: a video of one character preset walking in the isometric office, its four
 * directions (a held arrow key each), at a chosen zoom, followed by the camera. For reviewing new
 * character art in motion; the art itself is not in the repo (expansion packs live in the
 * git-ignored packs-private/), so the preset folder is an argument.
 * dist/cli.js (or CLI_JS) with --engine on in an isolated HOME whose `claude` is the engine fake,
 * on a spare port, headless Chromium with --disable-gpu; the preset's <id>.png / <id>.json are
 * copied into that HOME's characters folder and given to the lead 'alpha'.
 *
 *   npx tsx cld/test/run-char-walk.ts <port 18256-18269> <preset dir> <preset id> <out dir> [zoom]
 * Writes <out dir>/office-walk.webm, a screenshot per direction, and prints the tiles walked.
 */
import type { Page } from '@playwright/test';
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

const port = sparePort();
const [presetDir, presetId, outDir] = process.argv
  .slice(3, 6)
  .map((a, i) => (i === 1 ? a : path.resolve(a)));
const ZOOM = Number(process.argv[6] ?? 6);
const CLI = process.env.CLI_JS ?? path.join(REPO_ROOT, 'dist/cli.js');
const DEADLINE_MS = 180_000;
const VIEW = { width: 960, height: 720 };
const HOLD_MS = 900;
const PAUSE_MS = 900;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Hooks = {
  getCharacterTile: (id: number) => { col: number; row: number; active: boolean } | null;
  selectAgent: (id: number) => void;
  setZoom: (z: number) => void;
  follow: (id: number) => void;
};
const hooks = <T>(page: Page, fn: (h: Hooks, a: any) => T, arg?: unknown): Promise<T> =>
  page.evaluate(
    ([src, a]) =>
      (new Function('h', 'a', `return (${src})(h, a)`) as (h: unknown, a: unknown) => T)(
        (window as unknown as { __agentTycoonTestHooks: Hooks }).__agentTycoonTestHooks,
        a,
      ),
    [fn.toString(), arg] as const,
  );

async function main() {
  if (!presetDir || !presetId || !outDir)
    throw new Error('usage: <port> <preset dir> <id> <out dir> [zoom]');
  await assertPortFree(port);
  fs.mkdirSync(outDir, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(path.join(cfg, 'characters'), { recursive: true });
  for (const ext of ['.png', '.json'])
    fs.copyFileSync(
      path.join(presetDir, presetId + ext),
      path.join(cfg, 'characters', presetId + ext),
    );
  fs.writeFileSync(
    path.join(cfg, 'characters.json'),
    JSON.stringify({ alpha: { preset: presetId } }),
  );
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify([{ name: 'alpha', folder, room: '개발실', wantRunning: true }]),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--no-terminal'],
    { FAKE_TURN_MS: '600' },
    false,
    CLI,
  );
  const { child: server } = daemon;
  const deadline = setTimeout(() => {
    console.error(`aborted: deadline ${DEADLINE_MS / 1000} s`);
    server.kill('SIGKILL');
    killFakeSessions(home);
    process.exit(1);
  }, DEADLINE_MS);

  const browser = await launchBrowser();
  try {
    const url = await daemon.loginUrl();
    // The lead's transcript ends in a plain reply: it is idle (and free to walk).
    let session: { sessionId: string; cwd: string } | null = null;
    for (const end = Date.now() + 40_000; !session; await sleep(300)) {
      if (Date.now() > end) throw new Error('the engine did not revive the session');
      for (const f of fs.readdirSync(sessions))
        try {
          const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8'));
          if (s.name === 'alpha') session = s;
        } catch {
          /* being written */
        }
    }
    const file = transcriptPath(session.cwd, session.sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = (uuid: string, rec: object) =>
      `${JSON.stringify({ uuid, timestamp: new Date().toISOString(), ...rec })}\n`;
    fs.appendFileSync(
      file,
      line('00000001-0000-4000-8000-000000000000', {
        type: 'user',
        message: { role: 'user', content: 'hi' },
      }) +
        line('00000002-0000-4000-8000-000000000000', {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        }),
    );

    const ctx = await browser.newContext({
      viewport: VIEW,
      recordVideo: { dir: outDir, size: VIEW },
    });
    await ctx.addInitScript(() => {
      (window as unknown as { __AGENT_TYCOON_E2E: boolean }).__AGENT_TYCOON_E2E = true;
      (window as unknown as { __name: (f: unknown) => unknown }).__name = (f) => f;
      localStorage.setItem('cld.title-scene', 'off');
      localStorage.setItem('cld.office-iso', 'on');
      localStorage.setItem(
        'cld.office-hours',
        JSON.stringify({ on: false, start: 540, end: 1080, days: [1, 2, 3, 4, 5], lingerMin: 10 }),
      );
    });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url);
    const label = page.locator('[data-testid="agent-overlay"]', { hasText: 'alpha' }).first();
    await label.waitFor({ timeout: 30_000 });
    const id = Number(await label.getAttribute('data-agent-id'));
    // the lobby board stands in front of the room and would hide the walker: off for the video
    await page.addStyleTag({
      content: '[data-testid="lobby-board"] { display: none !important; }',
    });
    const tile = () => hooks(page, (h, a) => h.getCharacterTile(a), id);
    for (const end = Date.now() + 20_000; Date.now() < end && (await tile())?.active;)
      await sleep(200);
    await hooks(page, (h, a) => h.selectAgent(a), id);
    await hooks(page, (h, a) => h.setZoom(a), ZOOM);
    await hooks(page, (h, a) => h.follow(a), id);
    await sleep(2_500); // the sheet loads and the camera settles
    const video = page.video();
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
      const from = await tile();
      await page.keyboard.down(key);
      await sleep(HOLD_MS / 2);
      await page.screenshot({ path: path.join(outDir, `walk-${key.slice(5).toLowerCase()}.png`) });
      await sleep(HOLD_MS / 2);
      await page.keyboard.up(key);
      await sleep(PAUSE_MS);
      const to = await tile();
      console.log(`${key}: (${from?.col},${from?.row}) -> (${to?.col},${to?.row})`);
    }
    await ctx.close();
    if (video) fs.renameSync(await video.path(), path.join(outDir, 'office-walk.webm'));
    console.log(errors.length ? `page errors: ${errors.join(' | ')}` : 'no page errors');
  } finally {
    await browser.close();
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((r) => server.once('exit', r));
      server.kill('SIGTERM');
      const force = setTimeout(() => server.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(force);
    }
    clearTimeout(deadline);
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
