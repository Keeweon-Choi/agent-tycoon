/**
 * CHAR-FACTORY check (based on run-char-human.ts): dist/cli.js with an isolated HOME on a spare port, headless Chromium (no GPU),
 * desktop 1280x800 and a phone 390x844. One fake Claude session (a `sleep` with a transcript); no
 * model is ever called. Build first (`node esbuild.js && npm run build:webview`).
 *
 * The person tab's C8 groups; a preset of a small expansion pack (written into the temp HOME's own
 * packs folder) applied, the body set to curvy, an expression picked and saved; no adult mark or
 * pack switch anywhere (removed 10-25); the owner's HD example as an HD preset (the HD note in the
 * preview); the phone page; the saved pack look in all 21 frames ×4 off the compositor.
 * Screenshots: cld/artifacts/char-factory/.
 *
 *   npx tsx cld/test/run-char-human.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { PART_ALPHABET, PARTS_META } from '../../core/src/cld/partData.js';
import type { CharacterChoice } from '../../core/src/messages.js';
import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { loadPack } from '../../server/src/cld/packs.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';
import { configDirectory } from '../../server/src/cld/configPath.js';
import { composePerson } from '../../webview-ui/src/cld/characters/parts.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/char-factory');
const ZOOM = 4;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

/** The import's 21-frame preview lies wholly inside its scrolling area and the viewport. */
async function previewInSight(panel: ReturnType<Page['locator']>, what: string): Promise<void> {
  const preview = panel.getByTestId('part-import-preview');
  await preview.scrollIntoViewIfNeeded();
  const box = await preview.evaluate((el) => {
    let s = el.parentElement;
    while (s && getComputedStyle(s).overflowY !== 'auto') s = s.parentElement;
    const a = el.getBoundingClientRect();
    const b = (s ?? document.documentElement).getBoundingClientRect();
    const inside =
      a.top >= b.top - 0.5 &&
      a.bottom <= b.bottom + 0.5 &&
      a.left >= b.left - 0.5 &&
      a.right <= b.right + 0.5 &&
      a.bottom <= innerHeight &&
      a.right <= innerWidth;
    return { inside, w: Math.round(a.width), h: Math.round(a.height), area: Math.round(b.height) };
  });
  check(
    box.inside,
    `${what}: the 21-frame preview (${box.w}x${box.h}) is fully in sight (area ${box.area} high)`,
  );
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

function session(home: string, name: string, cwd: string) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = 'c1025200-0000-4000-8000-000000000001';
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-haiku-4-5',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: `${cwd}/README.md` } },
        ],
      },
    }) + '\n',
  );
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

/** The look in all 21 frames, ×ZOOM (HD at half), on a light checker. */
function writeSheet(
  file: string,
  look: CharacterChoice,
  custom: Parameters<typeof composePerson>[1],
) {
  const { sheet } = composePerson(look, custom);
  const d = sheet.density ?? 1;
  const s = ZOOM / d;
  const out = new PNG({ width: 112 * ZOOM, height: 96 * ZOOM });
  (['down', 'up', 'right'] as const).forEach((view, r) =>
    sheet[view].forEach((frame, f) =>
      frame.forEach((row, y) =>
        row.forEach((c, x) => {
          const bg = (f + r) % 2 ? 214 : 232;
          const rgb = c ? [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16)) : [bg, bg, bg];
          for (let dy = 0; dy < s; dy++)
            for (let dx = 0; dx < s; dx++)
              out.data.set(
                [...rgb, 255],
                (((r * 32 * d + y) * s + dy) * out.width + (f * 16 * d + x) * s + dx) * 4,
              );
        }),
      ),
    ),
  );
  fs.writeFileSync(file, PNG.sync.write(out));
}

/** A part of the built-ins as a pack PNG (its classic pixels). */
function partPng(id: string, w: number, h: number): Buffer {
  const part = PARTS_META.parts.find((p) => p.id === id)!;
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    const k = part.pixels[i];
    if (k === '.') continue;
    const c = part.palette[PART_ALPHABET.indexOf(k)];
    png.data.set([0, 2, 4].map((o) => parseInt(c.slice(o, o + 2), 16)).concat(255), i * 4);
  }
  return PNG.sync.write(png);
}

/** The runner's expansion pack: a top, a face with a smile, one preset. */
function fixturePack(dir: string) {
  fs.mkdirSync(path.join(dir, 'parts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'parts/tee.png'), partPng('top-0', 112, 96));
  fs.writeFileSync(path.join(dir, 'parts/face.png'), partPng('face-basic-f', 48, 24));
  fs.writeFileSync(path.join(dir, 'parts/face-smile.png'), partPng('face-basic-m', 48, 24));
  fs.writeFileSync(
    path.join(dir, 'pack.json'),
    JSON.stringify({
      id: 'fixture',
      version: 1,
      title: { ko: '시험 팩', en: 'Test pack' },
      parts: [
        { id: 'tee', slot: 'top', kind: 'sheet', file: 'parts/tee.png', colorable: true },
        {
          id: 'face',
          slot: 'face',
          kind: 'face',
          expressions: { neutral: 'parts/face.png', smile: 'parts/face-smile.png' },
        },
      ],
      presets: [
        {
          id: 'office',
          outfit: 'office',
          name: { ko: '시험 오피스', en: 'Test office' },
          look: {
            v: 3,
            kind: 'person',
            gender: 'f',
            parts: { top: 'tee', face: 'face', hair: 'hair-1' },
          },
        },
      ],
    }),
  );
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const cfg = configDirectory(home);
  const store = path.join(cfg, 'characters.json');
  fs.writeFileSync(store, JSON.stringify({ $meta: { v: 2, pinnedAt: 'x' } }));
  // a small expansion pack in the user's packs folder, as an owner would add one
  fixturePack(path.join(cfg, 'packs/fixture'));
  // the owner's HD example as a preset sheet
  fs.mkdirSync(path.join(cfg, 'characters'), { recursive: true });
  for (const f of ['bunny-hd-sample.png', 'bunny-hd-sample.json'])
    fs.copyFileSync(
      path.join(REPO_ROOT, 'cld/artifacts/char-factory/hd-sample', f),
      path.join(cfg, 'characters', f),
    );
  const lead = session(home, 'lead', '/work/alpha');
  const started = startDaemon({ home, claudePath }, port, ['--no-terminal'], {});
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true;');
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    return { ctx, page };
  };
  const looks = () =>
    JSON.parse(fs.readFileSync(store, 'utf-8')) as Record<string, CharacterChoice>;

  try {
    const loginUrl = await started.loginUrl();
    const { ctx: desk, page } = await open({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    await page.goto(loginUrl);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    const card = page.locator('[data-testid="agent-card"]').first();
    await card.waitFor();
    const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
    if (await closeInfo.count()) await closeInfo.click();
    await until('lead is pinned', () => !!looks().lead);

    await card.click({ button: 'right' });
    const win = page.locator('[data-testid="looks-window"]');
    await win.waitFor();
    await win.getByRole('button', { name: '사람 꾸미기' }).click();
    for (const g of ['basic', 'look', 'outfit', 'presets'])
      check(await win.getByTestId(`looks-group-${g}`).isVisible(), `group ${g} is there`);
    await page.waitForTimeout(400);
    await win.screenshot({ path: path.join(OUT, 'looks-groups.png') });

    // the pack's preset, then the curvy body and an expression
    const preset = win.getByTestId('looks-pack-preset-fixture/office');
    await preset.scrollIntoViewIfNeeded();
    await preset.click();
    await win.getByTestId('looks-body-curvy').scrollIntoViewIfNeeded();
    await win.getByTestId('looks-body-curvy').click();
    await win.getByTestId('looks-expr-smile').click();
    await page.waitForTimeout(400);
    await win
      .getByTestId('looks-preview')
      .screenshot({ path: path.join(OUT, 'preset-curvy-smile.png') });
    await win.getByTestId('looks-save').click();
    await until('the pack look is saved', () => looks().lead?.parts?.top === 'fixture/tee');
    const saved = looks().lead;
    check(
      saved.body === 'curvy' && saved.expr === 'smile' && !('adult' in saved),
      `characters.json: curvy, smile, no adult mark (${JSON.stringify(saved)})`,
    );
    check(
      (await win.getByTestId('looks-adult').count()) === 0,
      'no adult-original mark in the window',
    );
    check((await win.getByTestId('looks-adult-pack').count()) === 0, 'no adult pack switch');

    // the owner's HD example as a preset
    await win.getByRole('button', { name: '커스텀' }).click();
    await win.getByRole('button', { name: '프리셋 바니 HD 예시' }).click();
    await win.getByTestId('looks-hd').waitFor({ timeout: 10_000 });
    await page.waitForTimeout(600);
    await win
      .getByTestId('looks-preview')
      .screenshot({ path: path.join(OUT, 'preset-hd-sample.png') });
    check(
      (await win.getByTestId('looks-hd').innerText()).includes('HD'),
      'the preview says HD (and that the seated frames stand)',
    );
    await win.getByTestId('looks-save').click();
    await until('the HD preset is saved', () => looks().lead?.preset === 'bunny-hd-sample');
    await page.getByRole('button', { name: '꾸미기 닫기' }).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, 'office-hd-look.png') });

    // the phone's 꾸미기 page: the groups on a small screen
    const { ctx: phoneCtx, page: phone } = await open({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    await phoneCtx.addCookies(await desk.cookies());
    await phone.goto(`http://127.0.0.1:${port}/`);
    const phoneCard = phone.locator('[data-testid="agent-card"]').first();
    await phoneCard.waitFor();
    const phoneInfo = phone.getByRole('button', { name: '정보 창 닫기' });
    if (await phoneInfo.count()) await phoneInfo.click();
    await phone.locator('[data-testid="agent-overlay"]').first().waitFor();
    await phone.waitForTimeout(800);
    await phoneCard.tap();
    await phone.getByRole('menuitem', { name: '꾸미기' }).tap({ timeout: 5_000 });
    const page2 = phone.locator('[data-testid="looks-window"]');
    await page2.waitFor();
    await page2.getByRole('button', { name: '사람 꾸미기' }).tap();
    await phone.waitForTimeout(500);
    await phone.screenshot({ path: path.join(OUT, 'phone-person-groups.png') });
    await phoneCtx.close();

    const packs = [loadPack(path.join(cfg, 'packs/fixture'), false)];
    const parts = packs.flatMap((p) => ('error' in p ? [] : p.parts));
    writeSheet(path.join(OUT, 'pack-look-21-frames-x4.png'), saved, parts);
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
    console.log('all checks passed');
  } finally {
    await browser.close();
    started.child.kill();
    lead.kill();
    killFakeSessions(home);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
