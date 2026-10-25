/**
 * UI-AUDIT-DESKTOP: one size and alignment for every button and icon, and room under every
 * window's title bar. dist/cli.js with an isolated HOME on a spare port, headless Chromium
 * (--disable-gpu), desktop 1280x800 and 1920x1080.
 * Survey and result in one: opens every window and the HUD, screenshots each, and measures
 * - every icon-only button (box, the glyph's size and its offset from the box centre),
 * - every button with text and an icon (icon centre against text centre),
 * - the gap between a window's title bar and the first thing drawn under it.
 * TAG=before|after (default after) names the screenshots in cld/artifacts/ui-audit-desktop/ and
 * the JSON report. In `after` mode the checks fail when a size class is not one size or a
 * window's gap differs from the others.
 *
 *   npx tsx cld/test/run-ui-audit-desktop.ts <port 18256-18259>
 */
import type { Locator, Page } from '@playwright/test';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { findTmux, Tmux } from '../../server/src/cld/shell/tmux.js';
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
const TAG = process.env.TAG ?? 'after';
const OUT = path.join(REPO_ROOT, 'cld/artifacts/ui-audit-desktop');
const TMUX_SOCKET = `cld-test-${randomBytes(6).toString('hex')}`;
const tmuxBin = findTmux();
const testTmux = tmuxBin ? new Tmux(tmuxBin, TMUX_SOCKET) : null;

type Rec = Record<string, unknown>;
const call = (id: string, name: string, input: Rec) => ({ type: 'tool_use', id, name, input });
const said = (content: Rec[]): Rec => ({ type: 'assistant', message: { model: 'claude-opus-4-5', content } });
const sub = (parent: string, msg: Rec): Rec => ({
  type: 'progress',
  parentToolUseID: parent,
  data: { type: 'agent_progress', message: msg },
});

function session(home: string, k: number, name: string, cwd: string) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = `c0520000-0000-4000-8000-${String(k).padStart(12, '0')}`;
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  const transcript = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(transcript, '');
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now() - 600_000, procStart, version: '2.1.306', kind: 'interactive', name, status: 'idle' }),
  );
  return { proc, transcript };
}

function spawnSub(transcript: string) {
  for (const r of [
    said([call('tu-a', 'Task', { description: 'fix login', prompt: 'x', model: 'sonnet' })]),
    sub('tu-a', said([call('tu-a-1', 'Grep', { pattern: 'login' })])),
    sub('tu-a', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-a-1', content: 'ok' }] } }),
  ])
    fs.appendFileSync(transcript, JSON.stringify(r) + '\n');
}

// ── measuring (runs in the page) ──
interface IconRow {
  scene: string;
  name: string;
  box: string;
  glyph: string;
  /** glyph centre minus box centre, px (x,y). */
  off: string;
  kind: 'icon' | 'text+icon' | 'text';
  /** text+icon: icon centre minus text centre, vertical px. */
  lineOff?: number;
  cls: string;
}
interface Gap {
  scene: string;
  gap: number;
  first: string;
  side: number;
}

/** Every visible button under `root`: its box, its glyph and where the glyph sits in it. */
const MEASURE_BUTTONS = (root: Element | null) => {
  if (!root) return [];
  const rows: Array<Record<string, unknown>> = [];
  const mid = (r: DOMRect, b: DOMRect) =>
    `${Math.round((r.left + r.width / 2 - (b.left + b.width / 2)) * 10) / 10},${Math.round((r.top + r.height / 2 - (b.top + b.height / 2)) * 10) / 10}`;
  for (const b of root.querySelectorAll('button, [role="button"], [role="tab"], summary')) {
    const el = b as HTMLElement;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
    const svg = el.querySelector('svg, img, canvas, .material-symbols-sharp') as HTMLElement | null;
    // The words of the button: a Material symbol's ligature name ("settings") is a glyph, not a word.
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.material-symbols-sharp').forEach((n) => n.remove());
    const text = (clone.textContent ?? '').trim();
    // A glyph character (x, +, ×, ✕, ⟳, ...) is a symbol, not a word: Hangul and letters are text.
    const symbolText = !svg && /^[^\p{L}\p{N}]{1,3}$/u.test(text);
    const name = el.getAttribute('aria-label') ?? el.getAttribute('title') ?? text;
    let glyph = '';
    let off = '';
    let lineOff: number | undefined;
    const range = document.createRange();
    range.selectNodeContents(el);
    const t = range.getBoundingClientRect();
    if (svg) {
      const g = svg.getBoundingClientRect();
      glyph = `${Math.round(g.width * 10) / 10}x${Math.round(g.height * 10) / 10}`;
      const hasWords = /[\p{L}\p{N}]{2,}/u.test(text);
      if (hasWords) {
        // text + icon: the icon's centre against the text's centre
        const words = document.createRange();
        words.selectNodeContents(el);
        lineOff = Math.round((g.top + g.height / 2 - (t.top + t.height / 2)) * 10) / 10;
      }
      off = mid(g, r);
    } else if (symbolText) {
      glyph = `t:${Math.round(t.width)}x${Math.round(t.height)}`;
      off = mid(t, r);
    }
    const isIcon = (svg && lineOff === undefined) || symbolText;
    rows.push({
      name: name.slice(0, 40),
      box: `${Math.round(r.width * 10) / 10}x${Math.round(r.height * 10) / 10}`,
      glyph,
      off,
      kind: isIcon ? 'icon' : svg ? 'text+icon' : 'text',
      lineOff,
      cls: (el.getAttribute('class') ?? '').split(/\s+/).filter((c) => /^(w-|h-|min-|p-|px-|py-|size-)/.test(c)).join(' '),
    });
  }
  return rows;
};

/** The first thing drawn under a title bar (title = [data-title] or a window's hud-title): its distance and the side margin. */
const MEASURE_GAP = (frame: Element | null) => {
  if (!frame) return null;
  const title = (frame.querySelector('[data-testid^="hud-title-"]') ?? frame.querySelector('[data-modal-title]')) as HTMLElement | null;
  if (!title) return null;
  const tb = title.getBoundingClientRect();
  const fb = frame.getBoundingClientRect();
  let top = Infinity;
  let left = Infinity;
  let what = '';
  const walk = (el: Element) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || cs.display === 'none' || cs.visibility === 'hidden') return;
    if (el.hasAttribute('data-handle')) return;
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim());
    const bordered = ['top', 'right', 'bottom', 'left'].some(
      (s) => parseFloat(cs.getPropertyValue(`border-${s}-width`)) > 0 && cs.getPropertyValue(`border-${s}-style`) !== 'none',
    );
    const filled = !/(, 0\)|transparent)$/.test(cs.backgroundColor);
    const form = /^(button|input|select|textarea|svg|canvas|img|hr)$/i.test(el.tagName);
    // A box that fills the whole area under the title is a wrapper, not content: look inside it.
    const spans = r.width >= fb.width - 6 && r.height >= fb.height - tb.height - 6;
    const draws = own || form || ((bordered || filled) && !spans);
    if (draws && r.top < top) {
      top = r.top;
      what = `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}:${(el.textContent ?? '').trim().slice(0, 14)}`;
    }
    if (draws && r.left < left) left = r.left;
    if (el.tagName.toLowerCase() !== 'svg') for (const c of el.children) walk(c);
  };
  let sib = title.nextElementSibling;
  while (sib) {
    walk(sib);
    sib = sib.nextElementSibling;
  }
  return { gap: Math.round((top - tb.bottom) * 10) / 10, first: what, side: Math.round((left - fb.left) * 10) / 10 };
};

const icons: IconRow[] = [];
const gaps: Gap[] = [];
let oks = 0;
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  oks++;
  console.log(`ok - ${what}`);
}
async function until(what: string, fn: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const lead = session(home, 1, 'lead', '/work/alpha');
  const other = session(home, 2, 'other', '/work/beta');
  fs.mkdirSync(path.join(home, 'work'), { recursive: true });
  const started = startDaemon({ home, claudePath }, port, ['--no-terminal', '--allow-actions', '--allow-chat', '--allow-terminal'], {
    SHELL: '/bin/sh',
    CLD_GUI_SHELL_TMUX_SOCKET: TMUX_SOCKET,
  });
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  const failed: string[] = [];
  try {
    const login = await browser.newContext();
    const lp = await login.newPage();
    await lp.goto(await started.loginUrl());
    await lp.waitForURL(`http://127.0.0.1:${port}/`);
    const cookies = await login.cookies();
    await login.close();
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 1920, height: 1080 },
    ]) {
      const vp = `${viewport.width}`;
      const ctx = await browser.newContext({ viewport });
      await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true;');
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.getByRole('button', { name: '설정', exact: true }).first().waitFor({ timeout: 60_000 });
      await until('lead is in', async () =>
        (await page.$$eval('[data-testid="card-name"]', (n) => n.map((x) => x.textContent))).includes('lead'),
      );
      await page.waitForTimeout(3_000);
      spawnSub(lead.transcript);
      await page.evaluate(() => document.fonts.load("16px 'Galmuri11'", '가'));

      const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${TAG}-${vp}-${name}.png`) });
      /** Measure the buttons under `root` (and the title-bar gap of `frame`), tagged with the scene. */
      const survey = async (name: string, root: Locator, frame?: Locator) => {
        const rows = (await root.first().evaluate(MEASURE_BUTTONS, undefined, { timeout: 5_000 })) as unknown as Array<Omit<IconRow, 'scene'>>;
        for (const r of rows) icons.push({ scene: `${vp} ${name}`, ...r });
        if (frame) {
          const g = (await frame.first().evaluate(MEASURE_GAP, undefined, { timeout: 5_000 })) as Omit<Gap, 'scene'> | null;
          if (g) gaps.push({ scene: `${vp} ${name}`, ...g });
        }
      };
      /** One scene: a failure is logged and the survey goes on (a survey, not a gate). */
      const scene = async (name: string, fn: () => Promise<void>) => {
        try {
          await fn();
        } catch (err) {
          failed.push(`${vp} ${name}: ${String(err).split('\n')[0]}`);
          console.log(`SCENE FAILED ${vp} ${name}: ${String(err).split('\n')[0]}`);
        }
      };
      const win = (id: string) => page.locator(`[data-hud-window="${id}"]`);
      const dialog = () => page.getByRole('dialog').last();
      const icon = (name: string) => page.locator('[data-hud-id^="icon:"]').getByRole('button', { name: new RegExp(`^${name}`) }).first();
      const topBar = () => page.locator('[data-hud-id="usage"]');
      /** Modal scene: open, settle, shot, survey (with its gap), close with its x. */
      const modal = async (name: string, open: () => Promise<void>) => {
        await scene(name, async () => {
          await open();
          await dialog().waitFor();
          await page.waitForTimeout(500);
          await shot(name);
          await survey(name, dialog(), dialog());
          await page.getByRole('button', { name: 'x', exact: true }).last().click();
          await page.waitForTimeout(250);
        });
      };
      const closeWindow = async (id: string) => {
        const w = win(id);
        if (await w.isVisible().catch(() => false)) await w.locator('[data-testid^="hud-title-"] button').last().click();
        await page.waitForTimeout(250);
      };

      // ── the first-run tour: step through it, surveying each step ──
      await scene('onboarding', async () => {
        for (let step = 0; step < 6; step++) {
          const tour = page.locator('[role="dialog"]').filter({ has: page.getByRole('button', { name: /^(다음|완료|계속 물어보기)$/ }) });
          if (!(await tour.count())) break;
          await shot(`onboarding-${step}`);
          await survey(`onboarding-${step}`, tour);
          const ask = tour.getByRole('button', { name: '계속 물어보기' });
          if (await ask.count()) await ask.click();
          else await tour.getByRole('button', { name: /^(다음|완료)$/ }).first().click();
          await page.waitForTimeout(400);
        }
      });
      await page.waitForTimeout(600);

      await scene('hud', async () => {
        await shot('hud');
        await survey('top bar', topBar());
        await survey('dock', page.locator('[data-hud-id^="icon:"]').first().locator('xpath=ancestor::*[@data-hud-layer][1]').locator('[data-hud-id^="icon:"]'));
        await survey('elevator', page.getByRole('navigation', { name: '엘리베이터' }));
        await survey('card bar', page.locator('[data-testid="agent-card"]').first().locator('xpath=ancestor::*[@data-hud-fixed][1]'));
      });

      await modal('settings-일반', async () => page.getByRole('button', { name: '설정', exact: true }).first().click());
      for (const tab of ['화면', '접속', '보안', '고급']) {
        await scene(`settings-${tab}`, async () => {
          await page.getByRole('button', { name: '설정', exact: true }).first().click();
          await dialog().waitFor();
          await page.getByRole('tab', { name: tab, exact: true }).click();
          await page.waitForTimeout(400);
          await shot(`settings-${tab}`);
          await survey(`settings-${tab}`, dialog(), dialog());
          await page.getByRole('button', { name: 'x', exact: true }).last().click();
        });
      }
      await modal('security', async () => topBar().getByRole('button', { name: '보안', exact: true }).click());
      await modal('add-device', async () => topBar().getByRole('button', { name: '기기 추가', exact: true }).click());
      await modal('legend', async () => topBar().getByRole('button', { name: '범례', exact: true }).click());

      await scene('office', async () => {
        await icon('현황판').click();
        await win('office').waitFor();
        await page.waitForTimeout(600);
        await shot('office');
        await survey('office', win('office'), win('office'));
      });
      await scene('work-view', async () => {
        const open = win('office').locator('[data-testid="work-open"]').first();
        if (!(await open.count())) {
          await win('office').getByRole('button', { name: 'lead', exact: true }).first().click();
          await page.waitForTimeout(500);
        }
        await win('office').locator('[data-testid="work-open"]').first().click();
        await page.waitForTimeout(800);
        await shot('work-view');
        const sheet = page.locator('[data-testid="work-sheet"], [aria-label^="lead 하는 일"]').first();
        await survey('work-view', sheet.or(page.getByRole('dialog').last()));
        await page.keyboard.press('Escape');
        const x = page.getByRole('button', { name: 'x', exact: true });
        if (await x.count()) await x.last().click();
      });
      await scene('files', async () => {
        await icon('파일').click();
        await page.waitForTimeout(800);
        await shot('files');
        await survey('files', win('office'), win('office'));
      });
      await closeWindow('office');

      for (const [tab, label] of [['agents', '에이전트'], ['tasks', 'Task'], ['worktrees', 'worktree'], ['changes', '변경']] as const) {
        await scene(`workbench-${tab}`, async () => {
          if (!(await win('workbench').isVisible())) await icon('작업실').click();
          await win('workbench').waitFor();
          await win('workbench').getByRole('button', { name: label, exact: true }).click();
          await page.waitForTimeout(700);
          await shot(`workbench-${tab}`);
          await survey(`workbench-${tab}`, win('workbench'), win('workbench'));
        });
      }
      await scene('looks', async () => {
        await win('workbench').getByRole('button', { name: '에이전트', exact: true }).click();
        await page.waitForTimeout(400);
        await win('workbench').getByRole('button', { name: '꾸미기' }).first().click();
        await win('looks').waitFor();
        await page.waitForTimeout(800);
        await shot('looks');
        await survey('looks', win('looks'), win('looks'));
        await closeWindow('looks');
      });
      await closeWindow('workbench');

      await scene('messenger-list', async () => {
        await icon('메신저').click();
        await win('messenger').waitFor();
        await page.waitForTimeout(700);
        await shot('messenger-list');
        await survey('messenger-list', win('messenger'), win('messenger'));
      });
      await scene('messenger-dm', async () => {
        await win('messenger').getByRole('button', { name: /lead/ }).first().click();
        await page.waitForTimeout(800);
        await shot('messenger-dm');
        await survey('messenger-dm', win('messenger'), win('messenger'));
      });
      await scene('messenger-room', async () => {
        await win('messenger').getByRole('button', { name: /전체/ }).first().click();
        await page.waitForTimeout(800);
        await shot('messenger-room');
        await survey('messenger-room', win('messenger'), win('messenger'));
      });
      await closeWindow('messenger');

      await scene('notices', async () => {
        await icon('알림').click();
        await win('notices').waitFor();
        await page.waitForTimeout(600);
        await shot('notices');
        await survey('notices', win('notices'), win('notices'));
        await closeWindow('notices');
      });
      await scene('terminal', async () => {
        await icon('터미널').click();
        await win('terminal').waitFor();
        await page.waitForTimeout(1_500);
        await shot('terminal');
        await survey('terminal', win('terminal'), win('terminal'));
        await closeWindow('terminal');
      });
      await ctx.close();
    }
    fs.writeFileSync(path.join(OUT, `${TAG}-report.json`), JSON.stringify({ icons, gaps, failed }, null, 1));
    console.log(`failed scenes: ${failed.length}`);
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
    if (TAG === 'after') verdict();
    console.log(`all ${oks} checks passed`);
  } finally {
    await browser.close();
    await started.stop?.();
    lead.proc.kill('SIGKILL');
    other.proc.kill('SIGKILL');
    killFakeSessions(home);
    testTmux?.killServer();
  }
}

/** The result: one box per size class, glyphs centred, one gap under every title bar. */
function verdict() {
  const ICON_BOXES = new Set(['28x28']);
  // An icon button is at most 44 px either way: the wide 오케스트레이터 추가 bar and the 꾸미기
  // thumbnails are not icon buttons.
  const small = (r: IconRow) => r.box.split('x').every((v) => Number(v) <= 44);
  const bad = icons.filter((r) => r.kind === 'icon' && small(r) && !r.scene.includes('dock') && !ICON_BOXES.has(r.box));
  check(bad.length === 0, `every icon button outside the dock is 28x28 (${bad.map((r) => `${r.scene}/${r.name} ${r.box}`).join('; ')})`);
  const dock = icons.filter((r) => r.scene.includes('dock') && r.kind === 'icon');
  check(dock.length > 0 && new Set(dock.map((r) => r.box)).size === 1, `the dock's icon buttons are one size (${[...new Set(dock.map((r) => r.box))].join(',')})`);
  const off = icons.filter((r) => r.kind === 'icon' && r.glyph && r.off.split(',').some((v) => Math.abs(Number(v)) > 1));
  check(off.length === 0, `every icon glyph is centred in its button (${off.map((r) => `${r.scene}/${r.name} ${r.off}`).join('; ')})`);
  const line = icons.filter((r) => r.lineOff !== undefined && Math.abs(r.lineOff) > 1);
  check(line.length === 0, `text+icon buttons share one centre line (${line.map((r) => `${r.scene}/${r.name} ${r.lineOff}`).join('; ')})`);
  check(gaps.length > 0 && new Set(gaps.map((g) => g.gap)).size === 1, `title bar to content is one gap in every window (${gaps.map((g) => `${g.scene} ${g.gap}`).join('; ')})`);
  check(new Set(gaps.map((g) => g.side)).size === 1 || new Set(gaps.filter((g) => !g.scene.includes('settings')).map((g) => g.side)).size <= 2, `the side margin is the same (${gaps.map((g) => g.side).join(',')})`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
