/**
 * Mascots 11-04 check: dist/cli.js with an isolated HOME on its own port, headless Chromium (no
 * GPU), desktop 1280x800. Fake sessions only (a `sleep` with a transcript we write), no model is
 * ever called.
 *
 * Eight names are pinned to the eight new species; four work at their desks (two read, two type)
 * and four wait (they wander). A ninth, `lead`, gets its provider's Coral; its 꾸미기 window shows
 * all twelve species on the mascot tab, and Mora is picked and saved: characters.json and the card
 * face follow. Bursts of the office while they walk in and wander, then seated close-ups.
 * Screenshots go to cld/artifacts/mascots-1104/.
 *
 *   npx tsx cld/test/run-mascots-1104.ts <port 18380-18389>
 */
import type { Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { MASCOT_SPECIES } from '../../core/src/cld/looks.js';
import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { configDirectory } from '../../server/src/cld/configPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 18380 && port <= 18389)) throw new Error('port must be 18380-18389');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/mascots-1104');
const MORA_FRAME = (
  JSON.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, 'webview-ui/src/cld/characters/mascots/mora.json'),
      'utf-8',
    ),
  ) as { palette: Record<string, string> }
).palette.S;
const NEW = ['kwak', 'bugi', 'moka', 'mungge', 'boo', 'gasi', 'mora', 'shoo'] as const;
/** The picker's names (i18n ko). */
const KO: Record<string, string> = {
  tori: '토리',
  coral: '코랄',
  byte: '바이트',
  puff: '퍼프',
  kwak: '꽥이',
  bugi: '버기',
  moka: '모카',
  mungge: '뭉게',
  boo: '부우',
  gasi: '가시',
  mora: '모래',
  shoo: '슝이',
};

type Rec = Record<string, unknown>;
type Hooks = {
  getCharacterTile: (id: number) => { col: number; row: number; state: string; dir: number } | null;
  selectAgent: (id: number | null) => void;
  walkTo: (id: number, col: number, row: number) => boolean;
  setZoom: (z: number) => void;
  follow: (id: number) => void;
  setActive: (id: number, on: boolean, tool?: string | null) => void;
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ZOOM = 4;
const VIEW = { width: 960, height: 720 };
/** The still around the followed character (CSS px). */
const CLIP = { width: 30 * ZOOM, height: 44 * ZOOM };
/** From the seat (c, r): a step down, two left, three right, one up (office Direction values:
 *  down 0, left 1, right 2, up 3), so it never reaches the room's front wall. */
const WALKS: Array<{ name: string; dir: number; to: (c: number, r: number) => [number, number] }> =
  [
    { name: 'down', dir: 0, to: (c, r) => [c, r + 1] },
    { name: 'left', dir: 1, to: (c, r) => [c - 2, r + 1] },
    { name: 'right', dir: 2, to: (c, r) => [c + 1, r + 1] },
    { name: 'up', dir: 3, to: (c, r) => [c + 1, r] },
  ];

/** Stills in a grid (rows of equal length, a 2 px gap). */
function grid(rows: Buffer[][], file: string): void {
  const pngs = rows.map((r) => r.map((b) => PNG.sync.read(b)));
  const [w, h] = [CLIP.width, CLIP.height];
  const cols = Math.max(...pngs.map((r) => r.length));
  const out = new PNG({ width: cols * (w + 2), height: pngs.length * (h + 2) });
  out.data.fill(0);
  pngs.forEach((r, y) =>
    r.forEach((p, x) =>
      PNG.bitblt(
        p,
        out,
        0,
        0,
        Math.min(w, p.width),
        Math.min(h, p.height),
        x * (w + 2),
        y * (h + 2),
      ),
    ),
  );
  fs.writeFileSync(file, PNG.sync.write(out));
}

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function until(
  what: string,
  fn: () => Promise<boolean> | boolean,
  ms = 30_000,
): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
}

/** A live Claude Code session (a `sleep` of ours) named `name`, its transcript's first record. */
function session(home: string, name: string, n: number, first: Rec) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = `c1104000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
  const cwd = `/work/${name}`;
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), JSON.stringify(first) + '\n');
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
  return proc;
}

const said = (content: Rec[]): Rec => ({
  type: 'assistant',
  message: { model: 'claude-haiku-4-5', content },
});
const tool = (name: string, cwd: string) =>
  said([{ type: 'tool_use', id: `tu-${name}`, name, input: { file_path: `${cwd}/a.ts` } }]);
const idle: Rec = {
  type: 'assistant',
  message: {
    model: 'claude-haiku-4-5',
    content: [{ type: 'text', text: 'done' }],
    stop_reason: 'end_turn',
  },
};

const plates = (page: Page) =>
  page.$$eval('[data-testid="agent-overlay"]', (nodes) =>
    nodes.map((n) => ({
      id: Number(n.getAttribute('data-agent-id')),
      name: n.querySelector('[data-testid="agent-name"]')?.textContent ?? '',
    })),
  );

/** True when the card portrait of character `id` has a pixel of colour `hex`. */
const cardHas = (page: Page, id: number, hex: string) =>
  page
    .locator(`[data-testid="agent-card"][data-agent-id="${id}"] canvas`)
    .first()
    .evaluate((c: HTMLCanvasElement, hex: string) => {
      const want = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4)
        if (d[i + 3] > 200 && want.every((v, k) => Math.abs(d[i + k] - v) <= 2)) return true;
      return false;
    }, hex);

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const store = path.join(configDirectory(home), 'characters.json');
  const pinned = Object.fromEntries(NEW.map((s) => [s, { v: 2, kind: 'mascot', species: s }]));
  fs.writeFileSync(store, JSON.stringify({ ...pinned, $meta: { v: 2, pinnedAt: 'x' } }));
  const firsts = [tool('Read', '/work/kwak'), tool('Edit', '/work/bugi'), idle, idle];
  const procs = NEW.map((s, i) => session(home, s, i + 1, firsts[i % 4]));
  procs.push(session(home, 'lead', 9, tool('Read', '/work/lead')));
  const started = startDaemon({ home, claudePath }, port, ['--no-terminal'], {});
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  const looks = () => JSON.parse(fs.readFileSync(store, 'utf-8')) as Record<string, Rec>;

  try {
    const loginUrl = await started.loginUrl();
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;');
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await page.goto(loginUrl);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await until('nine characters', async () => (await plates(page)).length >= 9);
    const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
    if (await closeInfo.count()) await closeInfo.click();
    await page.waitForTimeout(3_000);
    await page.screenshot({ path: path.join(OUT, 'office-desktop.png') });
    const file = looks();
    check(
      NEW.every((s) => (file[s] as Rec | undefined)?.species === s),
      'the eight names keep their new species',
    );
    await until('lead is pinned to Coral', () => looks().lead?.species === 'coral');

    // 꾸미기: the mascot tab lists all twelve, Mora is picked and saved.
    const ids = Object.fromEntries((await plates(page)).map((p) => [p.name, p.id]));
    await page
      .locator(`[data-testid="agent-card"][data-agent-id="${ids.lead}"]`)
      .click({ button: 'right' });
    const win = page.locator('[data-testid="looks-window"]');
    await win.waitFor();
    const tab = win.getByRole('button', { name: '마스코트' });
    if (await tab.count()) await tab.click();
    for (const s of MASCOT_SPECIES)
      check(
        await win.getByRole('button', { name: KO[s], exact: true }).isVisible(),
        `${s} (${KO[s]}) is listed`,
      );
    await win.getByRole('button', { name: KO.mora, exact: true }).click();
    await page.waitForTimeout(300);
    await win.screenshot({ path: path.join(OUT, 'looks-window-mascots.png') });
    await win.getByTestId('looks-save').click();
    await until('lead is saved as Mora', () => looks().lead?.species === 'mora');
    // Mora's frame is two rows a slab (light, dark): its shadow slot is what the card shows
    await until("lead's card shows Mora", () => cardHas(page, ids.lead, MORA_FRAME));
    check(true, "lead's card face is Mora");
    await page.getByRole('button', { name: '꾸미기 닫기' }).click();

    // Each new species (and lead, now Mora) walks down, left, right and up, then sits to type:
    // one still of each, a row per character (cld/artifacts/mascots-1104/office-walk-sit.png).
    const wctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
    await wctx.addInitScript('globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;');
    await wctx.addCookies(await ctx.cookies());
    const wp = await wctx.newPage();
    wp.on('pageerror', (err) => pageErrors.push(String(err)));
    await wp.goto(`http://127.0.0.1:${port}/`);
    await until('the office on the walk page', async () => (await plates(wp)).length >= 9);
    const wInfo = wp.getByRole('button', { name: '정보 창 닫기' });
    if (await wInfo.count()) await wInfo.click();
    const clip = {
      x: Math.round(VIEW.width / 2 - CLIP.width / 2),
      y: Math.round(VIEW.height / 2 - CLIP.height * 0.62),
      ...CLIP,
    };
    const rows: Buffer[][] = [];
    for (const name of [...NEW, 'lead']) {
      const id = ids[name];
      await hooks(wp, (h, a) => h.setActive(a, false), id);
      await hooks(wp, (h, a) => h.setZoom(a), ZOOM);
      await hooks(wp, (h, a) => h.follow(a), id);
      await hooks(wp, (h) => h.selectAgent(null)); // the camera follows, no selection outline
      await wp.mouse.move(0, 0);
      await sleep(1_500);
      const seat = (await hooks(wp, (h, a) => h.getCharacterTile(a), id))!;
      const row: Buffer[] = [];
      for (const walk of WALKS) {
        const [col, r] = walk.to(seat.col, seat.row);
        const went = await hooks(wp, (h, a) => h.walkTo(a[0], a[1], a[2]), [id, col, r]);
        let still: Buffer | null = null;
        for (const end = Date.now() + 2_500; went && Date.now() < end;) {
          const [png, pose] = await Promise.all([
            wp.screenshot({ clip }),
            hooks(wp, (h, a) => h.getCharacterTile(a), id),
          ]);
          if (pose?.state === 'walk' && pose.dir === walk.dir) still ??= png;
          if (pose?.state !== 'walk' && still) break;
        }
        row.push(still ?? (await wp.screenshot({ clip })));
        if (!still) console.log(`note - ${name} did not walk ${walk.name} (blocked)`);
      }
      await hooks(wp, (h, a) => h.setActive(a, true, 'Edit'), id);
      for (const end = Date.now() + 15_000; Date.now() < end; await sleep(300))
        if ((await hooks(wp, (h, a) => h.getCharacterTile(a), id))?.state === 'type') break;
      await sleep(800);
      row.push(await wp.screenshot({ clip }));
      rows.push(row);
    }
    grid(rows, path.join(OUT, 'office-walk-sit.png'));
    await wctx.close();
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
    console.log('all checks passed');
  } finally {
    await browser.close();
    started.child.kill();
    for (const p of procs) p.kill();
    killFakeSessions(home);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
