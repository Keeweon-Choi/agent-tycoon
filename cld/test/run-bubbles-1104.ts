/**
 * BUBBLES-1104 check: our own permission (padlock) and waiting (check) speech bubbles over the
 * characters' heads. dist/cli.js with an isolated HOME on a spare port, headless Chromium
 * (--disable-gpu), the isometric view. Two fake Claude sessions, no model: one has a Bash call
 * that never finishes (the heuristic permission timer raises the permission bubble), the other
 * ends a turn (the waiting bubble shows for 2 s). Screenshots to cld/artifacts/bubbles-1104/:
 * the whole office and, around each bubble, a 1x piece and a 4x piece (nearest-neighbour).
 *
 *   npx tsx cld/test/run-bubbles-1104.ts <port 18580-18589>
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { configDirectory } from '../../server/src/cld/configPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  startDaemon,
  topBarReady,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 18580 && port <= 18589)) throw new Error('port must be 18580-18589');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/bubbles-1104');
const PAD = 50;
const SCALE = 4;

let failed = 0;
function check(ok: unknown, what: string): void {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} - ${what}`);
}

function session(home: string, n: number, name: string, cwd: string) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = `c1104180-0000-4000-8000-00000000000${n}`;
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, '');
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
      status: 'busy',
    }),
  );
  return { proc, file };
}

const assistant = (content: object[]) => ({
  type: 'assistant',
  message: { model: 'claude-haiku-4-5', content },
});

/** A piece of the full-page shot around a box, at 1x and enlarged SCALE times (nearest neighbour). */
function pieces(
  png: Buffer,
  box: { x: number; y: number; width: number; height: number },
  tag: string,
) {
  const src = PNG.sync.read(png);
  const x0 = Math.max(0, Math.floor(box.x) - PAD);
  const y0 = Math.max(0, Math.floor(box.y) - PAD);
  const w = Math.min(src.width - x0, Math.ceil(box.width) + 2 * PAD);
  const h = Math.min(src.height - y0, Math.ceil(box.height) + 2 * PAD);
  const one = new PNG({ width: w, height: h });
  PNG.bitblt(src, one, x0, y0, w, h, 0, 0);
  fs.writeFileSync(path.join(OUT, `${tag}-1x.png`), PNG.sync.write(one));
  const big = new PNG({ width: w * SCALE, height: h * SCALE });
  for (let y = 0; y < big.height; y++)
    for (let x = 0; x < big.width; x++) {
      const s = ((Math.floor(y / SCALE) * w + Math.floor(x / SCALE)) << 2) as number;
      const d = (y * big.width + x) << 2;
      for (let k = 0; k < 4; k++) big.data[d + k] = one.data[s + k];
    }
  fs.writeFileSync(path.join(OUT, `${tag}-4x.png`), PNG.sync.write(big));
}

/** The three bubbles side by side on the dark office tone, 8x (the heart shows only for a petted pet, so no office shot has it). */
function sheet() {
  const names = ['permission', 'waiting', 'pet'];
  const Z = 8;
  const W = 11;
  const H = 13;
  const gap = 3;
  const out = new PNG({ width: (names.length * (W + gap) + gap) * Z, height: (H + 2 * gap) * Z });
  for (let i = 0; i < out.data.length; i += 4) out.data.set([0x2a, 0x2c, 0x44, 255], i);
  names.forEach((n, k) => {
    const j = JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, `webview-ui/src/office/sprites/bubble-${n}.json`),
        'utf8',
      ),
    ) as { palette: Record<string, string>; pixels: string[][] };
    j.pixels.forEach((row, y) =>
      row.forEach((key, x) => {
        const hex = j.palette[key];
        if (!hex) return;
        const rgb = [1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16));
        for (let dy = 0; dy < Z; dy++)
          for (let dx = 0; dx < Z; dx++) {
            const px = (k * (W + gap) + gap + x) * Z + dx;
            const py = (gap + y) * Z + dy;
            out.data.set([...rgb, 255], (py * out.width + px) << 2);
          }
      }),
    );
  });
  fs.writeFileSync(path.join(OUT, 'bubbles-sheet-8x.png'), PNG.sync.write(out));
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  sheet();
  const { home, claudePath } = makeEngineHome();
  const perm = session(home, 1, 'perm', '/work/alpha');
  const done = session(home, 2, 'done', '/work/beta');
  // Two floors, the sessions' rooms on 1F; the view is on the empty 2F with every floor shown, so the
  // characters on 1F carry the other-floor bubbles (the office draws bubbles only for those) and
  // 1F's button in the elevator list carries the same picture as a badge.
  fs.writeFileSync(
    path.join(configDirectory(home), 'building.json'),
    JSON.stringify({
      version: 1,
      perProject: false,
      floors: [
        { id: '1', name: '1층', rooms: [], characters: [] },
        { id: '2', name: '2층', rooms: [], characters: [] },
      ],
    }),
  );
  const daemon = startDaemon({ home, claudePath }, port, ['--no-terminal'], {});
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  try {
    const login = await browser.newContext();
    const lp = await login.newPage();
    await lp.goto(await daemon.loginUrl());
    await lp.waitForURL(`http://127.0.0.1:${port}/`);
    const cookies = await login.cookies();
    await login.close();

    const ctx = await browser.newContext({ viewport: { width: 1282, height: 832 } });
    await ctx.addInitScript(
      `globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;
       try { localStorage.setItem('cld.office-iso', 'on'); localStorage.setItem('cld.floor', '2'); localStorage.setItem('cld.floor-view', 'all'); localStorage.setItem('cld.elevator-list-open', '1'); localStorage.setItem('cld.title-scene', 'off'); localStorage.setItem('cld.backdrop', 'off'); } catch {}`,
    );
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await page.goto(`http://127.0.0.1:${port}/`);
    await topBarReady(page, 60_000);
    await page.getByTestId('office-canvas').waitFor();
    const info = page.getByRole('button', { name: '정보 창 닫기' });
    if (await info.count()) await info.first().click();

    const append = (file: string, r: object) => fs.appendFileSync(file, JSON.stringify(r) + '\n');
    await page.waitForTimeout(1500);
    append(
      perm.file,
      assistant([
        { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'rm -rf build' } },
      ]),
    );
    append(done.file, assistant([{ type: 'text', text: 'working' }]));
    // Permission: the unanswered Bash call, after the 7 s heuristic timer.
    const permBubble = page.locator('[data-testid="agent-bubble"][data-bubble="permission"]');
    await permBubble.first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(500);
    const permBox = (await permBubble.first().boundingBox())!;
    const full1 = await page.screenshot({ path: path.join(OUT, 'iso-permission-office.png') });
    pieces(full1, permBox, 'iso-permission');
    check(
      permBox.width > 0,
      `the permission bubble is on screen (${Math.round(permBox.width)}x${Math.round(permBox.height)} CSS px)`,
    );

    // Waiting: end a turn; the bubble lasts 2 s, so shoot at once.
    fs.appendFileSync(
      done.file,
      JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1200 }) + '\n',
    );
    const waitBubble = page.locator('[data-testid="agent-bubble"][data-bubble="waiting"]');
    await waitBubble.first().waitFor({ timeout: 20_000 });
    const waitBox = (await waitBubble.first().boundingBox())!;
    const full2 = await page.screenshot({ path: path.join(OUT, 'iso-waiting-office.png') });
    pieces(full2, waitBox, 'iso-waiting');
    check(
      waitBox.width > 0,
      `the waiting bubble is on screen (${Math.round(waitBox.width)}x${Math.round(waitBox.height)} CSS px)`,
    );
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
    console.log(failed ? `${failed} checks FAILED` : 'all checks passed');
  } finally {
    await browser.close();
    await daemon.stop();
    perm.proc.kill();
    done.proc.kill();
    killFakeSessions(home);
  }
}

main().then(
  () => process.exit(failed ? 1 : 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
