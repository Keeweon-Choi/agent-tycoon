/**
 * T-0017 check: dist/cli.js with an isolated HOME (fake claude sessions, R-8)
 * on a spare port, in headless Chromium. Only generated test images are used.
 *
 * Desktop: select alpha -> its menu -> 꾸미기 -> 커스텀 -> 사진으로 만들기, upload
 * a generated portrait, move the crop (the portrait must change), change the
 * colour count, save; then alpha must be drawn with the saved sheet (office
 * canvas pixels of its hair colour) and its card must show the portrait.
 * The upload holds only the sheet and the portrait, never the photo. delta
 * then picks alpha's preset from the list. Restart the daemon on the same
 * HOME: alpha keeps its look (FR-OFC-015). Phone: the same flow for beta;
 * deleting alpha's preset files brings alpha back to its default look; no page
 * errors.
 * Screenshots go to cld/artifacts/t0017/.
 *
 * CH-1 (then, or alone with `pin`): another HOME with five fake sessions and three engine
 * agents (two Leads, a Worker), one look chosen beforehand, the rest never chosen. The first
 * start pins every name's palette in characters.json; three restarts each draw every
 * character the same (the palette each was made with, the look the webview applies, its card
 * portrait) and write nothing. Screenshots: cld/artifacts/ch1/.
 *
 *   npx tsx cld/test/run-characters.ts <port 18256-18259> [pin]
 */
import type { Locator, Page } from '@playwright/test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';

import { loadRegistry, registryPath, saveRegistry } from '../../server/src/cld/engine/registry.js';
import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';
import { TEMPLATE, templateColor } from '../../webview-ui/src/cld/characters/template.js';
import { ACTIVITY_IDLE_DIM } from '../../webview-ui/src/constants.js';
import { adjustSprite } from '../../webview-ui/src/office/colorize.js';
import { syntheticPhoto } from '../../webview-ui/test/fixtures/syntheticPhotos.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0017');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
// Hangul from Malgun Gothic (read only), everything else the pixel font.
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0017/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

/** A generated portrait (never a real photo) as a PNG file to upload. */
function photoFile(kind: string, dir: string): string {
  const photo = syntheticPhoto(kind, 320);
  const png = new PNG({ width: photo.width, height: photo.height });
  png.data.set(photo.data);
  const file = path.join(dir, `generated-${kind}.png`);
  fs.writeFileSync(file, PNG.sync.write(png));
  return file;
}

const readPng = (file: string) => PNG.sync.read(fs.readFileSync(file));
/** The colour a saved sheet gives char_0's main hair pixel. */
function hairOf(sheet: PNG): number[] {
  const i = [...TEMPLATE.regions].findIndex(
    (code, k) => code === 'h' && templateColor(TEMPLATE, k) === '8f6439',
  );
  return [sheet.data[i * 4], sheet.data[i * 4 + 1], sheet.data[i * 4 + 2]];
}

type Shelf = Window & { __officeBefore?: Uint8ClampedArray };
/** Keep the office canvas as it is now, for countOnCanvas(..., true). */
const keepCanvas = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="office-canvas"]');
    (window as Shelf).__officeBefore = canvas
      ?.getContext('2d')
      ?.getImageData(0, 0, canvas.width, canvas.height).data;
  });
/** `rgb` as an idle character draws it (cld T-0026 dims an idle character slightly). */
function idleDimmed(rgb: number[]): number[] {
  const hex = '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
  const px = adjustSprite([[hex]], ACTIVITY_IDLE_DIM)[0][0];
  return [1, 3, 5].map((i) => parseInt(px.slice(i, i + 2), 16));
}
/** Office-canvas pixels of exactly this colour or its idle-dimmed form (now, or in the kept copy). */
const countOnCanvas = (page: Page, rgb: number[], kept = false) =>
  page.evaluate(
    ([colors, before]) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="office-canvas"]');
      const data = before
        ? (window as Shelf).__officeBefore
        : canvas?.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 0; data && i < data.length; i += 4)
        if (colors.some(([r, g, b]) => data[i] === r && data[i + 1] === g && data[i + 2] === b))
          n++;
      return n;
    },
    [[rgb, idleDimmed(rgb)], kept] as const,
  );

/** One pixel of an agent card's mug shot canvas. */
const cardPixel = (page: Page, agentId: number, x: number, y: number) =>
  page
    .locator(`[data-testid="agent-card"][data-agent-id="${agentId}"] canvas`)
    .first()
    .evaluate(
      (c: HTMLCanvasElement, [px, py]) => [...c.getContext('2d')!.getImageData(px, py, 1, 1).data],
      [x, y],
    );

async function until(what: string, fn: () => Promise<boolean>, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out: ${what}`);
}

/** CH-1: looks stay the same across restarts (see the header). */
async function pinAcrossRestarts(): Promise<void> {
  const out = path.join(REPO_ROOT, 'cld/artifacts/ch1');
  fs.mkdirSync(out, { recursive: true });
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  const reg = registryPath(fake.home);
  const work = (n: string) => path.join(fake.home, 'work', n);
  for (const n of ['proj-a', 'proj-b']) fs.mkdirSync(work(n), { recursive: true });
  saveRegistry(reg, [
    { name: 'proj-a', folder: work('proj-a'), wantRunning: false },
    { name: 'proj-b', folder: work('proj-b'), wantRunning: false },
  ]);
  const projA = loadRegistry(reg).projects[0];
  saveRegistry(reg, [
    ...loadRegistry(reg).projects,
    {
      projectId: projA.projectId,
      role: 'worker',
      name: 'worker-a',
      folder: work('proj-a'),
      wantRunning: false,
    },
  ]);
  const store = path.join(fake.home, '.config/cld-gui/characters.json');
  // beta was chosen before this version; eta has a v2 look this build cannot draw yet (it is
  // drawn on its base sheet); the other six names never were chosen.
  fs.writeFileSync(
    store,
    JSON.stringify(
      {
        beta: { palette: 5, hueShift: 120 },
        // eslint-disable-next-line pixel-agents/no-inline-colors -- a stored look's colour
        eta: { v: 2, kind: 'humanoid', base: 2, colors: { hair: '#101010' }, acc: ['cap'] },
      },
      null,
      2,
    ) + '\n',
  );
  const names = ['alpha', 'beta', 'delta', 'eta', 'theta', 'proj-a', 'proj-b', 'worker-a'];
  const browser = await launchBrowser();
  type Look = { made: string; drawn: string; card: string };
  const runs: Array<Record<string, Look>> = [];
  const files: string[] = [];
  try {
    for (let run = 0; run < 4; run++) {
      const daemon = startDaemon(fake, port, ['--no-terminal']);
      try {
        const ctx = await browser.newContext({
          viewport: { width: 1400, height: 900 },
          deviceScaleFactor: 1,
        });
        const page = await ctx.newPage();
        const frames: Array<Record<string, unknown>> = [];
        page.on('websocket', (ws) =>
          ws.on('framereceived', (f) => {
            try {
              frames.push(JSON.parse(String(f.payload)) as Record<string, unknown>);
            } catch {
              /* binary */
            }
          }),
        );
        await page.goto(await daemon.loginUrl());
        await page.waitForURL(`http://127.0.0.1:${port}/`);
        type Snap = { orchestrators: Array<{ name: string; agentId: number | null }> };
        const ids = new Map<string, number>();
        await until(
          `run ${run}: all ${names.length} characters`,
          async () => {
            const snap = [...frames].reverse().find((m) => m.type === 'officeSnapshot') as
              Snap | undefined;
            ids.clear();
            for (const o of snap?.orchestrators ?? [])
              if (o.agentId !== null) ids.set(o.name, o.agentId);
            return names.every((n) => ids.has(n));
          },
          30_000,
        );
        for (const n of names)
          await page
            .locator(`[data-testid="agent-card"][data-agent-id="${ids.get(n)}"] canvas`)
            .first()
            .waitFor();
        await page.waitForTimeout(1500); // sheets drawn, cards painted
        // The palette the daemon made each character with (agentCreated / existingAgents).
        const made = new Map<number, string>();
        for (const m of frames) {
          if (m.type === 'agentCreated')
            made.set(m.id as number, `${m.palette}:${m.hueShift ?? 0}`);
          if (m.type === 'existingAgents')
            for (const [id, meta] of Object.entries(
              m.agentMeta as Record<string, { palette?: number; hueShift?: number }>,
            ))
              made.set(Number(id), `${meta.palette}:${meta.hueShift ?? 0}`);
        }
        const presets = [...frames].reverse().find((m) => m.type === 'characterPresets') as
          | {
              assignments: Record<
                string,
                { palette?: number; hueShift?: number; base?: number; species?: string; color?: string }
              >;
            }
          | undefined;
        const looks: Record<string, Look> = {};
        for (const n of names) {
          const a = presets?.assignments[n];
          const card = await page
            .locator(`[data-testid="agent-card"][data-agent-id="${ids.get(n)}"] canvas`)
            .first()
            .evaluate((c: HTMLCanvasElement) => c.toDataURL());
          looks[n] = {
            made: made.get(ids.get(n)!) ?? '?',
            // CH-3: a mascot is drawn from its own sheet over whatever palette the daemon made
            drawn: a?.species
              ? `${a.species}:${a.color}`
              : a
                ? `${a.palette ?? a.base}:${a.hueShift ?? 0}`
                : 'none',
            card: crypto.createHash('sha1').update(card).digest('hex').slice(0, 12),
          };
        }
        runs.push(looks);
        files.push(fs.readFileSync(store, 'utf-8'));
        await page.screenshot({ path: path.join(out, `restart-${run}.png`) });
        console.log(
          `run ${run}: ` +
            names
              .map(
                (n) =>
                  `${n}=${looks[n].drawn}${looks[n].made === looks[n].drawn ? '' : `(made ${looks[n].made})`}`,
              )
              .join(' '),
        );
        await ctx.close();
      } finally {
        await daemon.stop();
      }
    }
  } finally {
    await browser.close();
  }
  const pinned = JSON.parse(files[0]) as Record<
    string,
    { palette?: number; hueShift?: number; v?: number }
  >;
  // The Claude sessions are listed only once a viewer is there, after the first pin: new names
  // then, so they get their provider's mascot (CH-3); the engine's names are pinned at once.
  const sessions = ['alpha', 'delta', 'theta'];
  check(
    names.every(
      (n) => n === 'eta' || sessions.includes(n) || pinned[n]?.palette !== undefined,
    ) &&
      sessions.every(
        (n) => (pinned[n] as { species?: string } | undefined)?.species === 'coral',
      ) &&
      pinned.eta?.v === 2 &&
      typeof pinned.$meta === 'object',
    `first start: the engine's names have a v1 look, the Claude sessions seen after it Coral, eta keeps its v2 look, and $meta (${Object.keys(pinned).join(', ')})`,
  );
  check(
    pinned.beta?.palette === 5 && pinned.beta.hueShift === 120,
    'first start: the look chosen before is kept',
  );
  check(
    files.every((f) => f === files[0]),
    'restarts 1-3: characters.json not rewritten',
  );
  for (const run of [1, 2, 3])
    for (const n of names) {
      const [a, b] = [runs[0][n], runs[run][n]];
      check(
        a.drawn === b.drawn && (b.made === b.drawn || sessions.includes(n)) && a.card === b.card,
        `restart ${run}: ${n} looks the same (${b.drawn}, made with ${b.made}, same card portrait)`,
      );
    }
  fs.rmSync(fake.home, { recursive: true, force: true });
}

async function main() {
  await assertPortFree(port);
  if (process.argv[3] === 'pin') {
    await pinAcrossRestarts();
    console.log('all checks passed');
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  const launch = () => startDaemon(fake, port, ['--no-terminal']);
  const presetsDir = path.join(fake.home, '.config/cld-gui/characters');
  const store = path.join(fake.home, '.config/cld-gui/characters.json');
  const received: Array<Record<string, unknown>> = [];
  /** Every request body and WebSocket frame the browser sent (as text, and raw). */
  const outgoing: string[] = [];
  const outgoingRaw: Buffer[] = [];
  /** Each test image picked in the browser. */
  const picked: Buffer[] = [];
  const pageErrors: string[] = [];
  const font = fs.readFileSync(FONT);
  const browser = await launchBrowser();
  const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
    const ctx = await browser.newContext(opts);
    await ctx.route('**/__t0017/malgun.ttf', (route) =>
      route.fulfill({ body: font, contentType: 'font/ttf' }),
    );
    const page = await ctx.newPage();
    page.on('websocket', (ws) => {
      ws.on('framereceived', (f) => {
        try {
          received.push(JSON.parse(String(f.payload)) as Record<string, unknown>);
        } catch {
          /* binary */
        }
      });
      ws.on('framesent', (f) => {
        outgoing.push(String(f.payload));
        outgoingRaw.push(Buffer.from(f.payload));
      });
    });
    page.on('request', (r) => {
      const body = r.postDataBuffer();
      if (!body) return;
      outgoing.push(body.toString());
      outgoingRaw.push(body);
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    return { ctx, page };
  };
  const login = async (page: Page, url: string) => {
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
  };
  const agentId = async (name: string) => {
    let id: number | undefined;
    await until(`${name}'s agent id`, async () => {
      const office = [...received].reverse().find((m) => m.type === 'officeSnapshot') as
        { orchestrators: Array<{ name: string; agentId: number | null }> } | undefined;
      id = office?.orchestrators.find((o) => o.name === name)?.agentId ?? undefined;
      return id !== undefined;
    });
    return id!;
  };
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const assignment = (name: string) =>
    (JSON.parse(fs.readFileSync(store, 'utf-8')) as Record<string, { preset?: string }>)[name];

  /** CH-4: the menu's 꾸미기 opens the window; its 커스텀 tab holds the photo maker and the presets. */
  const openCustom = async (page: Page, menu: Locator) => {
    await menu.getByRole('menuitem', { name: '꾸미기' }).click();
    const win = page.getByTestId('looks-window');
    await win.waitFor();
    await win.getByRole('button', { name: '커스텀' }).click();
  };
  /** The desktop window has a close button; the phone's page is minimized by the Dock. */
  const closeLooks = async (page: Page) => {
    const close = page.getByRole('button', { name: '꾸미기 닫기' });
    if (await close.count()) await close.click();
    else await page.locator('[data-dock="office"]').tap();
    await page.getByTestId('looks-window').waitFor({ state: 'hidden' });
  };

  /** Menu -> picker -> photo -> upload -> crop -> colours -> save, for one character. */
  const makeFromPhoto = async (page: Page, name: string, kind: string, prefix: string) => {
    const menu = page.getByRole('menu', { name: `${name} 메뉴` });
    await menu.waitFor();
    await page.waitForTimeout(900); // the camera settles on the character
    await keepCanvas(page);
    await shot(page, `${prefix}-before`);
    await openCustom(page, menu);
    await shot(page, `${prefix}-picker`);
    await page.getByRole('button', { name: '사진으로 만들기' }).click();
    const file = photoFile(kind, fake.home);
    picked.push(fs.readFileSync(file));
    await page.getByLabel('사진 고르기').setInputFiles(file);
    const mug = page.getByTestId('photo-mugshot');
    await page.getByTestId('photo-crop').waitFor();
    await page.waitForTimeout(400);
    const before = await mug.evaluate((c: HTMLCanvasElement) => c.toDataURL());
    const box = (await page.getByTestId('photo-crop').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 18, cy + 14, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    check(
      (await mug.evaluate((c: HTMLCanvasElement) => c.toDataURL())) !== before,
      `${prefix}: moving the crop changes the result`,
    );
    await page.mouse.move(cx + 18, cy + 14);
    await page.mouse.down();
    await page.mouse.move(cx, cy, { steps: 6 });
    await page.mouse.up();
    await page.getByLabel('색 수').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(500);
    await shot(page, `${prefix}-photo`);
    const files = new Set(fs.readdirSync(presetsDir));
    await page.getByRole('button', { name: '저장', exact: true }).click();
    // CH-4: the photo page saves back into the 꾸미기 window; close it so the office is in view.
    await page.getByTestId('photo-crop').waitFor({ state: 'detached' });
    await closeLooks(page);
    await until(`${name}'s preset saved`, async () => !!assignment(name)?.preset);
    const id = assignment(name)!.preset!;
    check(!files.has(`${id}.png`) && /^photo-\d+$/.test(id), `${prefix}: saved as a new ${id}.png`);
    const sheet = readPng(path.join(presetsDir, `${id}.png`));
    check(sheet.width === 112 && sheet.height === 96, `${prefix}: the saved sheet is 112×96`);
    return { id, sheet, mug: readPng(path.join(presetsDir, `${id}.mug.png`)) };
  };

  /** The office draws `name` with `sheet` (fewer pixels of its hair colour
   *  before, when there was a before), and its card shows `mug`. */
  const usesSheet = async (
    page: Page,
    name: string,
    sheet: PNG,
    mug: PNG,
    prefix: string,
    hadBefore = true,
  ) => {
    const id = await agentId(name);
    const hair = hairOf(sheet);
    await until(
      `${name} drawn with the new sheet`,
      async () => (await countOnCanvas(page, hair)) >= 20,
    );
    const now = await countOnCanvas(page, hair);
    const before = hadBefore ? await countOnCanvas(page, hair, true) : null;
    check(
      before === null || before < now / 4,
      `${prefix}: the office draws ${name} with the saved sheet (hair rgb(${hair.join(',')}): ${before === null ? '' : `${before} px before, `}${now} px now)`,
    );
    // The card's portrait: mug shot pixel (0,0) at offset 4, zoom 2.
    const px = await cardPixel(page, id, 5, 5);
    check(
      px.slice(0, 3).join(',') === [mug.data[0], mug.data[1], mug.data[2]].join(','),
      `${prefix}: ${name}'s card shows the 16×16 portrait`,
    );
  };

  let daemon = launch();
  try {
    // ── Desktop ──
    const { ctx: desk, page } = await open({
      viewport: { width: 1400, height: 900 },
      deviceScaleFactor: 1,
    });
    await login(page, await daemon.loginUrl());
    const alpha = await agentId('alpha');
    // Zoom in (Ctrl+wheel over the office) so the shots show the character up close.
    const office = (await page.getByTestId('office-canvas').boundingBox())!;
    await page.mouse.move(office.x + office.width / 3, office.y + office.height / 2);
    await page.keyboard.down('Control');
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    // The card follows and selects the character (after the zoom: a wheel lets the camera go).
    // Its card exists as soon as the snapshot arrives, but the character is added to the office a
    // moment later (about 250 ms in the runs that failed) and a click before that selects nothing,
    // so no menu ever opens. The character's label is there once the character is.
    await page.locator(`[data-testid="agent-overlay"][data-agent-id="${alpha}"]`).waitFor();
    await page.locator(`[data-testid="agent-card"][data-agent-id="${alpha}"]`).click();
    const saved = await makeFromPhoto(page, 'alpha', 'brunette', 'desktop');
    const presetsMsg = [...received].reverse().find((m) => m.type === 'characterPresets') as {
      presets: Array<{ id: string }>;
      assignments: Record<string, { preset?: string }>;
    };
    check(
      presetsMsg.assignments.alpha?.preset === saved.id,
      'desktop: characterPresets carries the new assignment',
    );
    await usesSheet(page, 'alpha', saved.sheet, saved.mug, 'desktop');
    await page.waitForTimeout(600);
    await shot(page, 'desktop-after');

    // Only the result leaves the browser: the upload carries a 112×96 sheet
    // (<= 64 KB) and a 16×16 portrait, and nothing sent holds the photo.
    const upload = JSON.parse(outgoing.find((b) => b.includes('"sheet"'))!) as Record<
      string,
      string
    >;
    const sheetPng = Buffer.from(upload.sheet, 'base64');
    const mugPng = PNG.sync.read(Buffer.from(upload.mugshot, 'base64'));
    const sent = PNG.sync.read(sheetPng);
    check(
      sent.width === 112 && sent.height === 96 && sheetPng.length <= 64 * 1024,
      `desktop: the upload is the 112×96 sheet (${sheetPng.length} bytes) and a ${mugPng.width}×${mugPng.height} portrait`,
    );
    const photo = picked[0];
    const rawSlice = photo.subarray(3000, 3064);
    const b64Slice = photo.toString('base64').slice(4000, 4100);
    check(
      !outgoingRaw.some((b) => b.includes(rawSlice)) && !outgoing.some((b) => b.includes(b64Slice)),
      `desktop: none of the ${outgoing.length} request bodies or frames sent holds the photo (${photo.length} bytes), raw or base64`,
    );

    // Picking an existing preset: delta takes alpha's photo character.
    const delta = await agentId('delta');
    await page.locator(`[data-testid="agent-card"][data-agent-id="${delta}"]`).click();
    const deltaMenu = page.getByRole('menu', { name: 'delta 메뉴' });
    await openCustom(page, deltaMenu);
    await page.getByRole('button', { name: '프리셋 alpha 사진' }).click();
    await page.getByTestId('looks-save').click();
    await until('delta takes the preset', async () => assignment('delta')?.preset === saved.id);
    await closeLooks(page);
    await usesSheet(page, 'delta', saved.sheet, saved.mug, 'desktop preset pick', false);
    await desk.close();

    // ── Restart on the same HOME: the look survives (FR-OFC-015) ──
    await daemon.stop();
    daemon = launch();
    const { page: phone } = await open({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1,
    });
    received.length = 0;
    await login(phone, await daemon.loginUrl());
    const alpha2 = await agentId('alpha');
    // A card tap follows nothing until the character exists (just after a login it may not yet).
    await phone.locator(`[data-testid="agent-overlay"][data-agent-id="${alpha2}"]`).waitFor();
    await phone.waitForTimeout(500);
    await phone.locator(`[data-testid="agent-card"][data-agent-id="${alpha2}"]`).tap();
    await usesSheet(phone, 'alpha', saved.sheet, saved.mug, 'phone after restart', false);

    // ── Phone: the same flow for beta ──
    const beta = await agentId('beta');
    await phone.locator(`[data-testid="agent-card"][data-agent-id="${beta}"]`).tap();
    const savedBeta = await makeFromPhoto(phone, 'beta', 'violet', 'phone');
    await usesSheet(phone, 'beta', savedBeta.sheet, savedBeta.mug, 'phone');
    await phone.waitForTimeout(600);
    await shot(phone, 'phone-after');

    // Deleting a preset's files: its characters go back to their default look.
    const hair = hairOf(saved.sheet);
    await phone.locator(`[data-testid="agent-card"][data-agent-id="${alpha2}"]`).tap(); // the camera follows alpha
    await until('alpha in view', async () => (await countOnCanvas(phone, hair)) >= 20);
    for (const ext of ['.png', '.mug.png', '.json'])
      fs.rmSync(path.join(presetsDir, `${saved.id}${ext}`), { force: true });
    await until(
      'alpha back to its default look',
      async () => (await countOnCanvas(phone, hair)) === 0,
    );
    const px = await cardPixel(phone, alpha2, 5, 5);
    check(
      px.slice(0, 3).join(',') !==
        [saved.mug.data[0], saved.mug.data[1], saved.mug.data[2]].join(','),
      'phone: with its preset deleted, alpha is drawn and carded with its default look',
    );
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ') || 'none'})`);
  } finally {
    await browser.close();
    await daemon.stop();
  }
  const msgs = received.filter((m) => m.type === 'characterPresets');
  fs.writeFileSync(
    path.join(OUT, 'ws-characterPresets.json'),
    JSON.stringify(msgs.at(-1), null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(OUT, 'server.log'),
    daemon.log
      .join('')
      .replace(/code=[\w-]+/g, 'code=<redacted>')
      .replaceAll(fake.home, '<HOME>')
      .replaceAll(os.hostname(), '<host>'),
  );
  fs.rmSync(fake.home, { recursive: true, force: true });
  await pinAcrossRestarts();
  console.log('all checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
