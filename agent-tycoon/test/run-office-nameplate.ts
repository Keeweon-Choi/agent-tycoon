/**
 * FEAT-OFFICE-NAMEPLATE-MODERN: the character HUD (nameplate, its badges and bubbles) in both screen styles.
 * The scene of run-office-hud-pc.ts (fake sessions in a temp HOME: working, a question, a permission, resting),
 * dist/cli.js on a spare port, headless Chromium without a GPU, no model. Pictures: the office at 1600x1000 (2x)
 * with 2x crops of every plate and a hovered one, a zoomed-out view, the phone at 390x844, in 모던 and 픽셀 감성,
 * and compare-ref.png beside the mockups' plate (ref-pc.png, ref-phone.png). Checks: 모던 plates are rounded with a
 * 1 px line, Pretendard and a state dot; 픽셀 감성 plates are sharp with a 2 px line, no dot; the 모던 plates take
 * no more room than they did under .ui-world (the plate's look until 11-06), measured on the same page.
 *
 *   npx tsx agent-tycoon/test/run-office-nameplate.ts <port 19190-19199>
 */
import type { Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { assertPortFree, killFakeSessions, launchBrowser, makeEngineHome, startDaemon } from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 19190 && port <= 19199)) throw new Error('port must be 19190-19199');
const OUT = path.resolve('agent-tycoon/artifacts/feat-office-nameplate-modern');
const SPECS = path.resolve('../specs/ui-mock-1104/hud-v3/base');
const INIT = `globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;`;
const STORE = { 'agty.title-scene': 'off', 'agty.office-iso': 'on', 'agty.floor': '1', 'agty.floor-view': 'one' };

type Mode = 'work' | 'wait' | 'perm' | 'rest';
const CREW: Array<[string, Mode, number]> = [
  ['agent-tycoon', 'work', 62_000],
  ['pearl', 'work', 118_000],
  ['harvester', 'work', 31_000],
  ['iris', 'wait', 88_000],
  ['sunglasses', 'perm', 47_000],
  ['postbox', 'rest', 171_000],
  ['kestrel', 'rest', 12_000],
];
const assistant = (content: object[], tokens: number) => ({
  type: 'assistant',
  message: { model: 'claude-opus-4-7', content, usage: { input_tokens: 10, cache_read_input_tokens: tokens, output_tokens: 200 } },
});

function session(home: string, n: number, name: string, mode: Mode) {
  const cwd = `/work/${name}`;
  const proc = spawn('sleep', ['1800'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = `b1106100-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, '');
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now() - 3_600_000, procStart, version: '2.1.306', kind: 'interactive', name, status: mode === 'work' || mode === 'perm' ? 'busy' : 'idle' }),
  );
  return { proc, file };
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const crew = CREW.map(([name, mode, tokens], i) => ({ name, mode, tokens, ...session(home, i + 1, name, mode) }));
  fs.writeFileSync(
    path.join(configDirectory(home), 'building.json'),
    JSON.stringify({ version: 1, perProject: false, floors: [{ id: '1', name: '1F', rooms: [], characters: [] }] }),
  );
  const daemon = startDaemon({ home, claudePath }, port, ['--no-terminal', '--allow-chat', '--engine', 'on', '--allow-actions']);
  const browser = await launchBrowser({ partyFrame: true });
  const append = (file: string, r: object) => fs.appendFileSync(file, JSON.stringify(r) + '\n');
  let tick = 0;
  let driver: NodeJS.Timeout | undefined;
  const failures: string[] = [];
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) failures.push(what);
  };
  try {
    const login = await browser.newContext();
    const lp = await login.newPage();
    await lp.goto(await daemon.loginUrl());
    await lp.waitForURL(`http://127.0.0.1:${port}/`);
    const cookies = await login.cookies();
    await login.close();

    let started = false;
    const open = async (theme: 'modern' | 'pixel', phone: boolean) => {
      const ctx = await browser.newContext(
        phone
          ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
          : { viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 },
      );
      await ctx.addInitScript(INIT);
      await ctx.addInitScript(
        (pairs) => {
          for (const [k, v] of pairs)
            try {
              localStorage.setItem(k, v);
            } catch {
              // about:blank
            }
        },
        [...Object.entries(STORE), ['agty.ui-theme', theme]],
      );
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.getByTestId('office-canvas').waitFor({ timeout: 60_000 });
      await page.locator('[data-nameplate]').first().waitFor({ timeout: 60_000 });
      if (!started) {
        started = true;
        for (const c of crew) {
          if (c.mode === 'wait') {
            append(c.file, assistant([{ type: 'text', text: 'Should I also migrate the old settings?' }], c.tokens));
            append(c.file, { type: 'system', subtype: 'turn_duration', durationMs: 90_000 });
          } else if (c.mode === 'perm') {
            append(c.file, assistant([{ type: 'tool_use', id: 'tu-p', name: 'Bash', input: { command: 'git push --force' } }], c.tokens));
          } else if (c.mode === 'rest') {
            append(c.file, assistant([{ type: 'text', text: 'Done. All tests pass.' }], c.tokens));
            append(c.file, { type: 'system', subtype: 'turn_duration', durationMs: 20_000 });
          }
        }
        driver = setInterval(() => {
          tick++;
          for (const c of crew.filter((x) => x.mode === 'work')) {
            const id = `tu-${c.name}-${Math.floor(tick / 2)}`;
            if (tick % 2 === 0) append(c.file, assistant([{ type: 'tool_use', id, name: 'Read', input: { file_path: '/work/a.ts' } }], c.tokens));
            else append(c.file, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu-${c.name}-${Math.floor((tick - 1) / 2)}`, content: 'ok' }] } });
          }
        }, 1600);
      }
      await page.waitForTimeout(10_000);
      return { ctx, page };
    };
    const look = (page: Page) =>
      page.$$eval('[data-nameplate]', (els) =>
        els.map((el) => {
          const s = getComputedStyle(el);
          const name = el.querySelector('[data-testid="agent-name"]');
          const r = el.getBoundingClientRect();
          return {
            name: name?.textContent ?? '',
            w: r.width,
            h: r.height,
            radius: s.borderTopLeftRadius,
            line: s.borderTopWidth,
            font: name ? getComputedStyle(name).fontFamily : '',
            dot: !!el.querySelector('[data-testid="plate-dot"]'),
          };
        }),
      );
    const crops = async (page: Page, prefix: string) => {
      const plates = page.locator('[data-testid="agent-overlay"]');
      const n = Math.min(await plates.count(), 4);
      for (let i = 0; i < n; i++) {
        const b = await plates.nth(i).boundingBox();
        const view = page.viewportSize()!;
        const x = Math.max(0, b ? b.x - 24 : 0);
        const y = Math.max(0, b ? b.y - 24 : 0);
        const width = b ? Math.min(view.width, b.x + b.width + 24) - x : 0;
        const height = b ? Math.min(view.height, b.y + b.height + 46) - y : 0;
        if (width > 0 && height > 0) await page.screenshot({ path: path.join(OUT, `${prefix}-plate-${i + 1}.png`), clip: { x, y, width, height } });
      }
    };

    for (const theme of ['modern', 'pixel'] as const) {
      const { ctx, page } = await open(theme, false);
      await page.screenshot({ path: path.join(OUT, `${theme}-pc-1600x1000.png`) });
      await crops(page, `${theme}-pc`);
      const plates = await look(page);
      console.log(theme, JSON.stringify(plates));
      check(plates.length >= 5, `${theme}: ${plates.length} plates`);
      if (theme === 'modern') {
        check(plates.every((p) => p.radius !== '0px' && p.line === '1px' && p.font.includes('Pretendard') && p.dot), 'modern: rounded, 1 px, Pretendard, a state dot');
        // The same page with the plates back under .ui-world and no dot: the room they took until 11-06.
        await page.$$eval('[data-testid="agent-overlay"]', (els) => els.forEach((el) => el.classList.add('ui-world')));
        await page.addStyleTag({ content: '[data-testid="plate-dot"]{display:none}' });
        const before = await look(page);
        const sum = (xs: typeof plates, k: 'w' | 'h') => xs.reduce((a, p) => a + p[k], 0);
        console.log(`modern widths now ${sum(plates, 'w').toFixed(0)} vs before ${sum(before, 'w').toFixed(0)}, heights ${sum(plates, 'h').toFixed(0)} vs ${sum(before, 'h').toFixed(0)}`);
        check(sum(plates, 'w') <= sum(before, 'w') * 1.02 && sum(plates, 'h') <= sum(before, 'h') * 1.02, 'modern: no larger footprint than the plate before');
        await crops(page, 'before-modern-pc');
        await page.reload();
        await page.locator('[data-nameplate]').first().waitFor({ timeout: 60_000 });
        await page.waitForTimeout(4000);
      } else {
        check(plates.every((p) => p.radius === '0px' && p.line === '2px' && !p.dot), 'pixel: sharp, 2 px, no dot');
      }
      // A hovered plate (the activity line joins it).
      const id = await page.locator('[data-nameplate]', { has: page.locator('[data-name="harvester"]') }).first().getAttribute('data-agent-id');
      const head = await page.locator(`[data-testid="status-icon-anchor"][data-agent-id="${id}"]`).boundingBox();
      if (head) {
        const focus = page.locator('[data-nameplate][data-focus]').first();
        for (const dy of [14, 22, 30, 8, 38, 46]) {
          await page.mouse.move(head.x + 2, head.y + dy);
          await page.waitForTimeout(500);
          if (await focus.count()) break;
        }
        const fb = (await focus.count()) ? await focus.boundingBox() : null;
        if (fb) await page.screenshot({ path: path.join(OUT, `${theme}-pc-hover.png`), clip: { x: fb.x - 30, y: fb.y - 40, width: fb.width + 60, height: fb.height + 120 } });
        check(!!fb, `${theme}: a hover opens the plate's activity line`);
        await page.mouse.move(5, 500);
      }
      // Zoomed out: the plates keep their size and follow their figures.
      const canvas = await page.getByTestId('office-canvas').boundingBox();
      if (canvas) {
        await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
        await page.mouse.wheel(0, 400);
        await page.waitForTimeout(1200);
        await page.screenshot({ path: path.join(OUT, `${theme}-pc-zoom.png`) });
      }
      await ctx.close();
      const phone = await open(theme, true);
      await phone.page.screenshot({ path: path.join(OUT, `${theme}-phone-390x844.png`) });
      await crops(phone.page, `${theme}-phone`);
      await phone.ctx.close();
    }

    // Beside the mockups' plate, for the eye.
    const cmp = await browser.newContext({ viewport: { width: 1100, height: 520 } });
    const cp = await cmp.newPage();
    const url = (f: string) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
    const fig = (cap: string, f: string) => (fs.existsSync(f) ? `<figure style="margin:0"><figcaption>${cap}</figcaption><img src="${url(f)}" style="max-height:220px"></figure>` : '');
    await cp.setContent(`<body style="margin:0;background:#111;display:flex;flex-wrap:wrap;gap:16px;padding:16px;align-items:flex-start;font:14px sans-serif;color:#ccc">
      <figure style="margin:0"><figcaption>ref-pc.png (2x)</figcaption><div style="width:280px;height:160px;overflow:hidden"><img src="${url(path.join(SPECS, 'ref-pc.png'))}" style="width:3172px;margin-left:-1180px;margin-top:-720px"></div></figure>
      <figure style="margin:0"><figcaption>ref-phone.png</figcaption><div style="width:240px;height:160px;overflow:hidden"><img src="${url(path.join(SPECS, 'ref-phone.png'))}" style="margin-left:-370px;margin-top:-320px"></div></figure>
      ${fig('modern (2x)', path.join(OUT, 'modern-pc-plate-1.png'))}${fig('before, modern', path.join(OUT, 'before-modern-pc-plate-1.png'))}${fig('pixel (2x)', path.join(OUT, 'pixel-pc-plate-1.png'))}</body>`);
    await cp.screenshot({ path: path.join(OUT, 'compare-ref.png'), fullPage: true });
    await cmp.close();
    if (failures.length) throw new Error(`${failures.length} check(s) failed:\n${failures.join('\n')}`);
  } finally {
    if (driver) clearInterval(driver);
    await browser.close();
    await daemon.stop();
    for (const c of crew) c.proc.kill();
    killFakeSessions(home);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
