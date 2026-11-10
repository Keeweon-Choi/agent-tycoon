/**
 * The PC office HUD (hud-v3 P0): pictures and checks. The office at 1024x700 and 1600x1000 with eight fake
 * agents in mixed states (working, a question, a permission, resting), then 16 and 23. dist/cli.js in an
 * isolated HOME on a spare port, headless Chromium without a GPU, no model: the sessions are files in the temp
 * HOME (a `sleep` for the pid, a transcript each), the scene of capture-ui-hud-base.ts. The e2e harness only
 * starts the plain office (no Claude Code, so no agty office), hence a runner. Checks: no top bar; a click on a
 * figure and on a portrait open the inspector on the same employee and its × closes it; the party shows 8, 16
 * and 23 with every portrait reachable; the permission is visible on its portrait and the party's head; the dock
 * opens the messenger above its band; maximized, the dock folds to its handle. Since 11-06: a readable waiting
 * badge and the inspector beside the selected portrait; FEAT-HUD-CONTROL-CENTER: the bottom-left control center
 * (fake usage figures for Claude and Codex): folded it shows its parts, each target opens its own part (the usage,
 * the notification panel, the whole center), the open center holds the news, every agent's usage, 실행 중 (the
 * working count true), 시간 and the menu tiles, clear of the dock and the party; no corner ≡, no bottom-right panel.
 * Pictures go to agent-tycoon/artifacts/feat-hud-control-center/<PREFIX>-*.png (UI_THEME=modern|pixel picks the style);
 * a failed check exits 1.
 * Since 11-06 (fix-inspector-engine-buttons): `agent-tycoon` is also an engine project (stopped, in the temp HOME), so
 * its inspector carries 켜기 / 재시작 / 설정 / 삭제 plus 개발 현황 and 파일; 삭제 asks first (cancelled), 개발 현황
 * opens the devroom on it. Set OUT_DIR to put the pictures elsewhere.
 * LEFT_ONLY=1 (FEAT-OFFICE-CONTROLS-MODERN): a three-floor building, then only the elevator and camera column on the
 * left (rest, floor list open, a floor hovered, free view with a hover), 2x crops of each at 1600x1000 and 1024x700,
 * with the checks that it stays on screen and clear of the control center, the dock and the party.
 * Since 11-06 (FEAT-PARTY-V2): no expand toggle; the party sits centred on the window's height; a second party is
 * made (name, two members), shown and switched back; the member card has its head, three tabs, at most three big
 * buttons and ⋯ with the rest (삭제 there still asks first, cancelled; 개발 현황 there opens the devroom); the phone
 * shows the same card as a bottom sheet; compare-ref.png puts the card beside the mockup (ref-pc.png). Pictures in
 * agent-tycoon/artifacts/feat-party-v2/ (ports 18930-18939 too).
 *
 *   UI_THEME=pixel PREFIX=pixel npx tsx agent-tycoon/test/run-office-hud-pc.ts <port 18710-18719, 18840-18859 or 18900-18909>
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import {
  assertPortFree,
  fakeUsage,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  startDaemon,
  writeEngineProjects,
} from '../../server/src/agent-tycoon/testHome.js';
import { outDir, themePort, UI_THEME_INIT } from './uiTheme.js';

const port = Number(process.argv[2]);
if (!((port >= 18710 && port <= 18719) || (port >= 18840 && port <= 18859) || (port >= 18900 && port <= 18909) || themePort(port)))
  if (!(port >= 18930 && port <= 18939))
    throw new Error('port must be 18710-18719, 18830-18839, 18840-18859, 18900-18909, 18930-18939 or 18980-18989');
const PREFIX = process.env.PREFIX ?? 'after';
const PHONE_ONLY = process.env.PHONE_ONLY === '1';
const OUT = outDir(path.resolve('agent-tycoon/artifacts/feat-party-v2'));
const REF_PC = path.resolve('../specs/ui-mock-1104/hud-v3/base/ref-pc.png');

const INIT = `globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;`;
const STORE: Record<string, string> = {
  'agty.title-scene': 'off',
  'agty.office-iso': 'on',
  'agty.floor': '1',
  'agty.floor-view': 'one',
};

type Mode = 'work' | 'wait' | 'perm' | 'rest';
const CREW: Array<[string, Mode, number, string[]]> = [
  ['agent-tycoon', 'work', 62_000, ['Edit', 'Read', 'Bash']],
  ['pearl', 'work', 118_000, ['Read', 'Grep']],
  ['harvester', 'work', 31_000, ['Bash', 'Edit']],
  ['lemon', 'work', 154_000, ['Write', 'Read']],
  ['iris', 'wait', 88_000, []],
  ['sunglasses', 'perm', 47_000, []],
  ['postbox', 'rest', 171_000, []],
  ['kestrel', 'rest', 12_000, []],
];

const assistant = (content: object[], tokens: number) => ({
  type: 'assistant',
  message: {
    model: 'claude-opus-4-7',
    content,
    usage: { input_tokens: 10, cache_read_input_tokens: tokens, output_tokens: 200 },
  },
});

function session(home: string, n: number, name: string, mode: Mode) {
  const cwd = `/work/${name}`;
  const proc = spawn('sleep', ['1800'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = `b1106000-0000-4000-8000-${String(n).padStart(12, '0')}`;
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
      startedAt: Date.now() - 3_600_000 - n * 600_000,
      procStart,
      version: '2.1.306',
      kind: 'interactive',
      name,
      status: mode === 'work' || mode === 'perm' ? 'busy' : 'idle',
    }),
  );
  return { proc, file };
}

const INPUTS: Record<string, object> = {
  Edit: { file_path: '/work/app/src/App.tsx', old_string: 'a', new_string: 'b' },
  Read: { file_path: '/work/app/src/main.ts' },
  Bash: { command: 'npm test' },
  Grep: { pattern: 'TODO' },
  Write: { file_path: '/work/app/notes.md', content: 'x' },
};

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const crew = CREW.map(([name, mode, tokens, tools], i) => ({
    name,
    mode,
    tokens,
    tools,
    ...session(home, i + 1, name, mode),
  }));
  fs.writeFileSync(
    path.join(configDirectory(home), 'building.json'),
    JSON.stringify({
      version: 1,
      perProject: false,
      floors: (process.env.LEFT_ONLY ? ['1', '2', '3'] : ['1']).map((id) => ({ id, name: `${id}F`, rooms: [], characters: [] })),
    }),
  );
  const folder = path.join(home, 'ws/agent-tycoon');
  fs.mkdirSync(folder, { recursive: true });
  writeEngineProjects(home, [{ name: 'agent-tycoon', folder }]);
  // Real readings from fixtures: Claude's week (status line) and its Fable week (/usage), Codex's 5-hour and week.
  const usage = await fakeUsage(home, { sevenDay: 78, fable: 5 }, { fiveHour: 0, sevenDay: 17 });
  const daemon = startDaemon({ home, claudePath }, port, ['--no-terminal', '--allow-chat', '--engine', 'on', '--allow-actions'], usage.env);
  const browser = await launchBrowser({ partyFrame: true });
  const append = (file: string, r: object) => fs.appendFileSync(file, JSON.stringify(r) + '\n');
  let tick = 0;
  let driver: NodeJS.Timeout | undefined;
  try {
    const scene = () => {
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
    };
    const startDriver = () => {
      driver = setInterval(() => {
        tick++;
        for (const c of crew.filter((x) => x.mode === 'work')) {
          const tool = c.tools[Math.floor(tick / 2) % c.tools.length];
          const id = `tu-${c.name}-${Math.floor(tick / 2)}`;
          if (tick % 2 === 0)
            append(c.file, assistant([{ type: 'tool_use', id, name: tool, input: INPUTS[tool] }], c.tokens));
          else
            append(c.file, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu-${c.name}-${Math.floor((tick - 1) / 2)}`, content: 'ok' }] } });
        }
      }, 1600);
    };

    const login = await browser.newContext();
    const lp = await login.newPage();
    await lp.goto(await daemon.loginUrl());
    await lp.waitForURL(`http://127.0.0.1:${port}/`);
    const cookies = await login.cookies();
    await login.close();

    let sceneDone = false;
    const open = async (viewport: { width: number; height: number }) => {
      const ctx = await browser.newContext({ viewport, deviceScaleFactor: process.env.LEFT_ONLY ? 2 : 1 });
      await ctx.addInitScript(INIT + UI_THEME_INIT);
      await ctx.addInitScript(
        (pairs) => {
          try {
            localStorage.removeItem('agty.camera-mode');
          } catch {
            // about:blank
          }
          for (const [k, v] of pairs)
            try {
              if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
            } catch {
              // about:blank
            }
        },
        Object.entries(STORE),
      );
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.getByTestId('office-canvas').waitFor({ timeout: 60_000 });
      await page.locator('[data-testid="agent-card"]').first().waitFor({ timeout: 60_000 });
      if (!sceneDone) {
        sceneDone = true;
        scene();
        startDriver();
      }
      await page.waitForTimeout(12_000);
      return { ctx, page };
    };
    type Page = import('@playwright/test').Page;
    const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${PREFIX}-${name}.png`) });
    const failures: string[] = [];
    const check = (ok: boolean, what: string) => {
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
      if (!ok) failures.push(what);
    };
    const box = async (page: Page, sel: string) => {
      const loc = page.locator(sel).first();
      return (await loc.count()) ? loc.boundingBox() : null;
    };
    const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    const portraits = (page: Page) => page.locator('[data-testid="agent-card"][data-portrait]');
    const idOf = async (page: Page, name: string) =>
      Number(await page.locator(`[data-testid="agent-card"][title="${name}"]`).first().getAttribute('data-agent-id'));
    const inspectorId = (page: Page) => page.getByTestId('inspector').getAttribute('data-agent-id', { timeout: 3000 }).catch(() => null);
    /** A real click on the figure: just under its head icon, stepping down until it selects. */
    const clickFigure = async (page: Page, id: number) => {
      const head = await box(page, `[data-testid="status-icon-anchor"][data-agent-id="${id}"]`);
      if (!head) return;
      for (const dy of [14, 22, 30, 8, 38, 46]) {
        await page.mouse.click(head.x + 2, head.y + dy);
        await page.waitForTimeout(300);
        if ((await inspectorId(page)) === String(id)) return;
      }
    };
    const partyFits = async (page: Page, count: number) => {
      const n = await portraits(page).count();
      check(n === count, `party lists ${count} (has ${n})`);
      const bar = await box(page, '[data-testid="card-container"]');
      const view = page.viewportSize()!;
      check(!!bar && bar.y >= 0 && bar.y + bar.height <= view.height && bar.x + bar.width <= view.width, `party of ${count} stays on screen`);
      const last = portraits(page).nth(n - 1);
      await last.scrollIntoViewIfNeeded();
      const lb = await last.boundingBox();
      check(!!lb && !!bar && lb.y >= bar.y && lb.y + lb.height <= bar.y + bar.height, `the last of ${count} portraits scrolls into the party`);
    };
    const addSessions = (from: number, to: number) => {
      for (let n = from; n <= to; n++) {
        const name = `agent-${String(n).padStart(2, '0')}`;
        crew.push({ name, mode: 'work' as Mode, tokens: 20_000 + n * 3000, tools: ['Read', 'Edit'], ...session(home, n, name, 'work') });
      }
    };
    const waitParty = async (page: Page, count: number) => {
      await page.waitForFunction((c) => document.querySelectorAll('[data-testid="agent-card"][data-portrait]').length >= c, count, { timeout: 90_000 }).catch(() => undefined);
      await page.waitForTimeout(3000);
    };

    const visible = async (page: Page, id: string) => page.getByTestId(id).first().isVisible().catch(() => false);
    const clears = async (page: Page, sel: string, size: string, what: string) => {
      const b = await box(page, sel);
      for (const other of ['[data-testid="hud-dock"]', '[data-testid="card-container"]', '[data-testid="inspector"]', '[data-testid="hud-corner"]']) {
        const o = await box(page, other);
        if (b && o) check(!overlaps(b, o), `${size}: ${what} clears ${other}`);
      }
      return b;
    };
    /** The folded control center: its parts, real figures, the working count true, clear of the rest of the HUD. */
    const ccFolded = async (page: Page, size: string) => {
      const tb = await clears(page, '[data-testid="cc-tile"]', size, 'the folded control center');
      check(!!tb, `${size}: the folded control center shows`);
      if (!tb) return;
      const view = page.viewportSize()!;
      check(tb.x <= 16 && tb.y + tb.height >= view.height - 16, `${size}: it sits at the bottom left (${Math.round(tb.x)},${Math.round(tb.y)})`);
      for (const id of ['cc-seg-notices', 'cc-seg-usage', 'cc-seg-running', 'cc-clock', 'hud-menu'])
        check(await visible(page, id), `${size}: the folded tile shows ${id}`);
      const rows = await page.locator('[data-testid="cc-seg-usage"] [data-agent]').evaluateAll((els) =>
        els.map((e) => ({ agent: e.getAttribute('data-agent'), left: e.getAttribute('data-left') ?? '', text: e.textContent ?? '' })),
      );
      check(rows.length >= 1 && rows.length <= 2 && rows.every((r) => /^\d+$/.test(r.left) && r.text.includes(`${r.left}%`)), `${size}: the usage target shows the two agents closest to their limits (${JSON.stringify(rows)})`);
      const lefts = rows.map((r) => Number(r.left));
      check(lefts.every((l, k) => k === 0 || lefts[k - 1] <= l), `${size}: the tightest first`);
      const agents = Number(await page.getByTestId('cc-seg-running').getAttribute('data-agents'));
      const working = await portraits(page).and(page.locator('[data-state="work"]')).count();
      check(agents === working, `${size}: 실행 중 counts the agents working (${agents} / ${working})`);
      check((await page.getByTestId('usage-panel').count()) === 0, `${size}: no bottom-right usage panel`);
      check((await page.locator('[data-testid="hud-corner"] [data-testid="hud-menu"], [data-testid="hud-menu-list"].game-menu').count()) === 0, `${size}: no corner menu`);
      console.log(`     folded control center ${Math.round(tb.width)}x${Math.round(tb.height)} at ${Math.round(tb.x)},${Math.round(tb.y)}`);
    };
    /** Each folded target opens its own part, the grid button the whole center; pictures of each. */
    const ccParts = async (page: Page, size: string, tag: string) => {
      await page.getByTestId('cc-seg-usage').click();
      await page.waitForTimeout(400);
      check(await visible(page, 'cc-usage-pop'), `${size}: the usage target opens the usage part`);
      check(!(await visible(page, 'cc-center')) && !(await visible(page, 'cc-notice-pop')), `${size}: ... and only it`);
      const agents = await page.locator('[data-testid="cc-usage-pop"] [data-testid="cc-agent"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-agent')));
      check(agents.length === 2 && agents.includes('claude') && agents.includes('codex'), `${size}: one row per agent the usage knows (${JSON.stringify(agents)})`);
      const windows = await page.locator('[data-testid="cc-usage-pop"] [data-testid="cc-window"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-left')));
      check(JSON.stringify(windows) === JSON.stringify(['22', '95', '100', '83']), `${size}: every window with what is left (${JSON.stringify(windows)})`);
      await clears(page, '[data-testid="cc-usage-pop"]', size, 'the usage part');
      await shot(page, `${tag}-usage`);
      await page.getByTestId('cc-seg-usage').click(); // fold it
      await page.waitForTimeout(300);
      check(!(await visible(page, 'cc-usage-pop')), `${size}: the usage target folds its part again`);

      await page.getByTestId('cc-seg-notices').click();
      await page.waitForTimeout(400);
      check(await visible(page, 'notice-panel'), `${size}: the notifications target opens the notification panel`);
      check(!(await visible(page, 'cc-center')) && !(await visible(page, 'cc-usage-pop')), `${size}: ... and only it`);
      const nb = await clears(page, '[data-testid="cc-notice-pop"]', size, 'the notification panel');
      check(!!nb && nb.width <= 760 * 0.8 + 2 && nb.height <= 720 * 0.8 + 2, `${size}: the notification panel is about 80 % of its old size (${nb?.width} x ${nb?.height})`);
      await shot(page, `${tag}-notices`);
      await page.getByTestId('cc-seg-notices').click();
      await page.waitForTimeout(300);
      check(!(await visible(page, 'notice-panel')), `${size}: the notifications target folds the panel again`);

      await page.getByTestId('hud-menu').click();
      await page.waitForTimeout(400);
      check(await visible(page, 'cc-center'), `${size}: the grid button opens the whole control center`);
      for (const id of ['cc-notices', 'cc-usage', 'cc-running', 'cc-time', 'hud-menu-list'])
        check(await visible(page, id), `${size}: the open control center holds ${id}`);
      const tiles = await page.getByTestId('hud-menu-list').getByRole('button').allTextContents();
      check(['기기 추가', '보안', '범례', '설정'].every((n) => tiles.some((x) => x.includes(n))), `${size}: the menu tiles (${JSON.stringify(tiles)})`);
      const running = page.locator('[data-testid="cc-center"] [data-testid="cc-running"]');
      check((await running.getAttribute('data-agents')) === (await page.getByTestId('cc-seg-running').getAttribute('data-agents')), `${size}: 실행 중 in the open center counts the same`);
      const cb = await clears(page, '[data-testid="cc-center"]', size, 'the open control center');
      const view = page.viewportSize()!;
      check(!!cb && cb.y >= 0 && cb.y + cb.height <= view.height, `${size}: the open control center stays on screen (${cb?.width} x ${cb?.height})`);
      await shot(page, `${tag}-open`);
      // A tile opens its dialog (범례 here) and folds the center; a press on the dialog's backdrop closes it.
      await page.getByTestId('hud-menu-list').getByRole('button', { name: '범례' }).click();
      await page.waitForTimeout(500);
      check((await page.getByTestId('activity-legend').count()) > 0 && !(await visible(page, 'cc-center')), `${size}: 범례 opens its dialog and folds the center`);
      await page.mouse.click(4, 4);
      await page.waitForTimeout(300);
      check((await page.getByTestId('activity-legend').count()) === 0, `${size}: the dialog closes`);
    };
    /** The waiting badge reads: a real size, its count in words, inside the party. */
    const badgeChecks = async (page: Page, size: string) => {
      const badge = page.getByTestId('party-waiting');
      const bb = await badge.boundingBox();
      const pb = await box(page, '[data-testid="card-container"]');
      const font = await badge.evaluate((e) => parseFloat(getComputedStyle(e).fontSize)).catch(() => 0);
      check(!!bb && bb.height >= 16 && bb.width >= 44 && font >= 13, `${size}: the waiting badge is legible (${bb?.width}x${bb?.height}, ${font}px)`);
      check(!!bb && !!pb && bb.x >= pb.x && bb.x + bb.width <= pb.x + pb.width, `${size}: the waiting badge fits the party`);
      check((await badge.getAttribute('data-count')) === '2', `${size}: the badge counts the question and the permission`);
    };
    /** The member card (FEAT-PARTY-V2): its head, three tabs, at most three big buttons, ⋯ with the rest. */
    const cardChecks = async (page: Page, size: string, engine: boolean) => {
      const card = page.getByTestId('inspector');
      await card.waitFor({ timeout: 5000 }).catch(() => undefined);
      for (const id of ['member-head', 'inspector-name', 'member-state', 'stat-face', 'activity-text'])
        check((await card.getByTestId(id).count()) === 1, `${size}: the card shows ${id}`);
      const tabs = await card.getByRole('tab').allTextContents();
      check(JSON.stringify(tabs.map((x) => x.trim())) === JSON.stringify(['개요', '능력치', '기록']), `${size}: the tabs 개요 · 능력치 · 기록 (${JSON.stringify(tabs)})`);
      const main = await card.locator('[data-testid="member-actions"] button').allTextContents();
      console.log(`     big buttons: ${JSON.stringify(main)}`);
      check(main.length >= 1 && main.length <= 3, `${size}: one to three big buttons (${main.length})`);
      check(main[0]?.includes('메시지') ?? false, `${size}: 메시지 first`);
      if (engine) check(main.some((x) => /켜기|끄기/.test(x)), `${size}: the engine's 켜기/끄기 on the card`);
      await card.getByTestId('member-more').click();
      await page.waitForTimeout(300);
      const more = await card.locator('[data-testid="member-more-menu"] [role="menuitem"]').allTextContents();
      console.log(`     ⋯: ${JSON.stringify(more)}`);
      const want = engine ? ['꾸미기', '스탯 창', '개발 현황', '파일', '설정', '삭제'] : ['꾸미기', '스탯 창'];
      check(want.every((w) => more.some((x) => x.includes(w))), `${size}: ⋯ holds ${want.join(', ')}`);
      const ib = await box(page, '[data-testid="inspector"]');
      const mb = await box(page, '[data-testid="member-more-menu"]');
      const view = page.viewportSize()!;
      check(!!mb && mb.x >= 0 && mb.y + mb.height <= view.height, `${size}: the ⋯ menu stays on screen`);
      const clipped = await card.locator('[data-testid="member-actions"] button').evaluateAll((els, right) => els.filter((e) => e.getBoundingClientRect().right > right + 0.5 || e.scrollWidth > e.clientWidth + 1).length, ib ? ib.x + ib.width : 0);
      check(clipped === 0, `${size}: no big button is clipped or cut`);
      return more;
    };
    const closeMore = async (page: Page) => {
      if (await page.getByTestId('member-more-menu').isVisible().catch(() => false)) await page.getByTestId('member-more').click();
      await page.waitForTimeout(200);
    };
    /** The party sits centred on the window's height. */
    const centreCheck = async (page: Page, what: string) => {
      const bar = await box(page, '[data-testid="card-container"]');
      const view = page.viewportSize()!;
      const mid = bar ? bar.y + bar.height / 2 : -1;
      check(Math.abs(mid - view.height / 2) <= 8, `${what}: the party is centred on the window's height (${Math.round(mid)} / ${view.height / 2})`);
    };
    /** The inspector beside the selected portrait: its top on that row, or clamped above the bottom HUD. */
    const alignCheck = async (page: Page, id: number, what: string) => {
      await page.waitForTimeout(500);
      const ib = await box(page, '[data-testid="inspector"]');
      const cb = await box(page, `[data-testid="agent-card"][data-agent-id="${id}"]`);
      const view = page.viewportSize()!;
      const clamped = !!ib && ib.y + ib.height >= view.height - 120 - 8;
      check(!!ib && !!cb && (Math.abs(ib.y - cb.y) <= 6 || (clamped && ib.y < cb.y)), `${what}: the inspector sits beside its portrait (${ib?.y} / ${cb?.y}${clamped ? ', clamped' : ''})`);
      check(!!ib && ib.y >= 0 && ib.y + ib.height <= view.height - 120, `${what}: the inspector stays inside, above the dock (${ib && Math.round(ib.y + ib.height)} / ${view.height - 120})`);
    };

    /** The left column (elevator + camera): four states, 2x crops, on screen and clear of the HUD. */
    const leftColumn = async (page: Page, size: string) => {
      const slot = '.agty-elevator-slot';
      const view = page.viewportSize()!;
      const crop = async (state: string) => {
        await page.waitForTimeout(400);
        const b = await box(page, slot);
        if (!b) return check(false, `${size} ${state}: the left column shows`);
        const y = Math.max(0, b.y - 12);
        await page.screenshot({
          path: path.join(OUT, `${PREFIX}-left-${size}-${state}.png`),
          clip: { x: 0, y, width: Math.min(view.width, b.x + b.width + 180), height: Math.min(view.height - y, b.height + 24) },
        });
        check(b.x >= 0 && b.y >= 0 && b.x + b.width <= view.width && b.y + b.height <= view.height, `${size} ${state}: the column stays on screen`);
        for (const other of ['[data-testid="cc-tile"]', '[data-testid="hud-dock"]', '[data-testid="card-container"]']) {
          const o = await box(page, other);
          if (o) check(!overlaps(b, o), `${size} ${state}: the column clears ${other}`);
        }
        console.log(`     ${state}: ${Math.round(b.width)}x${Math.round(b.height)} at ${Math.round(b.x)},${Math.round(b.y)}`);
      };
      await crop('rest');
      await page.getByTestId('elevator-display').click();
      await page.waitForTimeout(300);
      check((await page.locator('.agty-floor-button').count()) === 3, `${size}: the lamp opens the three floors`);
      await page.locator('.agty-floor-button').nth(1).hover();
      await crop('list');
      await page.getByTestId('elevator-display').click();
      await page.getByTestId('camera-toggle').click();
      check((await page.getByTestId('camera-toggle').getAttribute('data-mode')) === 'free', `${size}: the camera button turns the view free`);
      await page.getByTestId('owner-follow').hover();
      await crop('free');
      await page.getByTestId('camera-toggle').click();
      await page.getByTestId('elevator-up').click();
      await page.waitForTimeout(1500);
      await page.mouse.move(700, 300);
      await crop('floor2');
    };
    if (process.env.LEFT_ONLY) {
      for (const viewport of [{ width: 1600, height: 1000 }, { width: 1024, height: 700 }]) {
        const { ctx, page } = await open(viewport);
        await leftColumn(page, `${viewport.width}x${viewport.height}`);
        await ctx.close();
      }
      if (failures.length) throw new Error(`${failures.length} check(s) failed:\n${failures.join('\n')}`);
      return;
    }

    // PHONE_ONLY=1: the phone part alone (the 화면 스타일 pass for the phone).
    if (!PHONE_ONLY) {
    // ── 1024x700: the compact PC, eight agents ────────────────────
    {
      const { ctx, page } = await open({ width: 1024, height: 700 });
      await shot(page, 'pc-1024x700');
      await page.locator('[data-testid="agent-card"][title="agent-tycoon"]').first().click();
      await page.waitForTimeout(1500);
      await shot(page, 'pc-1024x700-selected');
      const ib = await box(page, '[data-testid="inspector"]');
      const pb = await box(page, '[data-testid="card-container"]');
      // 1024 is still the PC layout (the drawer narrows under it, 768-1023): 260-300.
      check(!!ib && ib.width >= 260 && ib.width <= 300, `1024: the inspector is 260-300 wide (${ib?.width})`);
      check(!!ib && !!pb && ib.x + ib.width <= pb.x, '1024: the inspector sits left of the party');
      await alignCheck(page, await idOf(page, 'agent-tycoon'), '1024');
      await cardChecks(page, '1024', true);
      await shot(page, 'pc-1024x700-card-more');
      await closeMore(page);
      await centreCheck(page, '1024');
      await ccFolded(page, '1024');
      await badgeChecks(page, '1024');
      // The lowest portrait: the inspector follows it down (or clamps above the usage panel).
      const lowest = Number(await portraits(page).last().getAttribute('data-agent-id'));
      await portraits(page).last().click();
      await alignCheck(page, lowest, '1024 lowest portrait');
      await ccFolded(page, '1024 lowest selected');
      await shot(page, 'pc-1024x700-selected-low');
      await page.getByTestId('inspector-close').click();
      await page.waitForTimeout(300);
      await ccParts(page, '1024', 'pc-1024x700-cc');
      await ctx.close();
    }

    // ── 1600x1000 ─────────────────────────────────────────────────
    const { ctx, page } = await open({ width: 1600, height: 1000 });
    await shot(page, 'pc-1600x1000');
    check((await page.locator('[data-hud-id="usage"]').count()) === 0, 'no top bar');
    check((await page.locator('[data-testid="host-clock"]:not([data-testid="control-center"] *)').count()) === 0, 'no top bar clock (the clock is in the control center)');
    check(((await box(page, '[data-testid="office-canvas"]'))?.y ?? 99) <= 1, 'the office runs to the top');
    check((await page.getByTestId('hud-corner').count()) === 1, 'the corner (the CPU heat) is there');
    check(await page.getByTestId('hud-dock').isVisible(), 'the dock shows');
    check((await page.getByTestId('board-clock').count()) > 0, 'the billboard carries the date and time');
    await partyFits(page, 9); // the eight sessions and the stopped engine project's own figure
    await centreCheck(page, '1600 with 9');
    // FEAT-PARTY-V2: no expand toggle; `파티 (9)`; a second party (two members), shown, then everyone again.
    check((await page.getByTestId('party-fold').count()) === 0 && (await page.getByTestId('party-open').count()) === 0, 'no expand toggle, no roster button');
    const select = page.getByTestId('party-select');
    check(/파티\s*\(9\)/.test(await select.innerText()), `the head reads 파티 (9) (${await select.innerText()})`);
    await select.click();
    await page.getByTestId('party-new').click();
    await page.getByTestId('party-name').fill('프론트');
    await page.getByTestId('party-name-save').click();
    await page.waitForTimeout(300);
    const picks = page.getByTestId('party-pick');
    await picks.filter({ hasText: 'pearl' }).click();
    await picks.filter({ hasText: 'iris' }).click();
    await shot(page, 'pc-1600x1000-party-members');
    await page.getByTestId('party-members-done').click();
    await page.waitForTimeout(600);
    check((await portraits(page).count()) === 2 && (await select.getAttribute('data-count')) === '2', `the new party shows its two (${await portraits(page).count()})`);
    check(/프론트\s*\(2\)/.test(await select.innerText()), `the head reads 프론트 (2) (${await select.innerText()})`);
    await centreCheck(page, '1600 with 2');
    await shot(page, 'pc-1600x1000-party-two');
    // The daemon kept it: a reload shows the same party.
    await page.reload();
    await page.locator('[data-testid="agent-card"][data-portrait]').first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(3000);
    check((await portraits(page).count()) === 2, 'after a reload the party is still the two');
    await select.click();
    await shot(page, 'pc-1600x1000-party-menu');
    check((await page.getByTestId('party-option').count()) === 2, 'the list has 모두 and 프론트');
    await page.locator('[data-testid="party-option"][data-party="all"]').click();
    await page.waitForTimeout(600);
    check((await portraits(page).count()) === 9, 'back on 모두, all nine');
    await ccFolded(page, '1600');
    await badgeChecks(page, '1600');
    await ccParts(page, '1600', 'pc-1600x1000-cc');
    // 실행 중 opens the jobs list (the 현황판's 개발 tab).
    await page.getByTestId('cc-seg-running').click();
    await page.waitForTimeout(800);
    check((await page.locator('[data-hud-window="office"]').count()) > 0, '실행 중 opens the jobs list');
    await page.locator('[data-testid="hud-title-office"] button').last().click(); // close the 현황판
    await page.waitForTimeout(400);
    const lock = portraits(page).and(page.locator('[data-state="lock"]'));
    check((await lock.count()) === 1, 'the permission shows on its portrait (lock)');

    // A click on the figure → the inspector on it, the portrait outlined; × closes it.
    // The working agty (its stopped engine project has a figure of the same name, sometimes listed first).
    const working = page.locator('[data-testid="agent-card"][title="agent-tycoon"][data-state="work"]').first();
    const cg = (await working.count()) ? Number(await working.getAttribute('data-agent-id')) : await idOf(page, 'agent-tycoon');
    await clickFigure(page, cg);
    check((await inspectorId(page)) === String(cg), 'a click on the figure opens the inspector on it');
    check((await page.locator(`[data-testid="agent-card"][data-agent-id="${cg}"]`).getAttribute('data-variant')) === 'focused', 'the figure click selects the same portrait');
    await alignCheck(page, cg, 'figure click');
    const ib = await box(page, '[data-testid="inspector"]');
    const pb = await box(page, '[data-testid="card-container"]');
    check(!!ib && ib.width >= 260 && ib.width <= 300 && !!pb && ib.x + ib.width <= pb.x, `the inspector is 260-300 wide, left of the party (${ib?.width})`);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(600);
    await shot(page, 'pc-1600x1000-selected');
    await page.getByTestId('inspector').screenshot({ path: path.join(OUT, `${PREFIX}-card.png`) });
    for (const tab of ['stats', 'log'] as const) {
      await page.getByTestId(`member-tab-${tab}`).click();
      await page.waitForTimeout(300);
      await page.getByTestId('inspector').screenshot({ path: path.join(OUT, `${PREFIX}-card-${tab}.png`) });
    }
    check((await page.locator('[data-testid="inspector"] [data-testid="stat-section"]').count()) === 0, 'the 기록 tab replaces the 능력치 rows');
    await page.getByTestId('member-tab-overview').click();
    // The card: 삭제 in ⋯ asks first (cancelled, nothing is deleted); 개발 현황 in ⋯ opens the devroom on the project.
    await cardChecks(page, '1600', true);
    await shot(page, 'pc-1600x1000-card-more');
    await page.getByTestId('member-more-remove').click();
    await page.waitForTimeout(600);
    const sure = page.getByRole('dialog');
    check((await sure.count()) > 0, '삭제 shows the existing confirmation');
    await shot(page, 'pc-1600x1000-engine-confirm');
    const cancel = sure.getByRole('button', { name: /취소|아니/ }).first();
    if (await cancel.count()) await cancel.click();
    else await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    check((await page.getByRole('dialog').count()) === 0, 'the confirmation is cancelled');
    await page.getByTestId('member-more').click();
    await page.getByTestId('member-more-dev').click();
    await page.waitForTimeout(1500);
    check((await page.getByText('agent-tycoon').count()) > 0 && (await page.locator('[data-hud-window="office"], [aria-label="현황판 화면"]').count()) > 0, '개발 현황 opens the 현황판 on the project');
    await shot(page, 'pc-1600x1000-engine-dev');
    await page.locator('[data-testid="hud-title-office"] button').last().click(); // close the 현황판
    await page.waitForTimeout(400);
    await page.getByTestId('inspector-close').click();
    await page.waitForTimeout(400);
    check((await page.getByTestId('inspector').count()) === 0, 'the inspector closes with its ×');

    // A portrait → the same selection; the permission's portrait shows it in the inspector.
    if (await lock.count()) {
      const askId = Number(await lock.first().getAttribute('data-agent-id'));
      await lock.first().click();
      await page.waitForTimeout(500);
      check((await inspectorId(page)) === String(askId), 'a portrait click opens the inspector on it');
      await alignCheck(page, askId, 'portrait click');
      check((await page.locator('[data-testid="inspector"] [data-testid="activity-text"]').getAttribute('data-ring')) === 'permission', 'the inspector says it needs a permission');
      const chat = page.locator('[data-testid="inspector"] [data-testid="member-chat"]');
      check(await chat.isVisible(), 'the card offers 메시지 toward the answer');
      await cardChecks(page, 'a plain session', false);
      await closeMore(page);
      await page.getByTestId('inspector-close').click();
    }

    // The corner has no bell any more (owner 11-06 16:15); the control center opens the notifications.
    check((await page.getByTestId('notice-bell').count()) === 0, 'no corner bell on the PC');

    // The dock opens the messenger above its band.
    const messengerBtn = page.locator('[data-testid="hud-dock"] [data-hud-id="icon:messenger"] button');
    check((await messengerBtn.count()) === 1, 'the dock has the messenger');
    if (await messengerBtn.count()) {
      await messengerBtn.click();
      await page.waitForTimeout(800);
      const db = await box(page, '[data-testid="hud-dock"]');
      const mb = await box(page, '[data-hud-window="messenger"]');
      check(!!db && !!mb && mb.y + mb.height <= db.y, 'the messenger window ends above the dock');
      const input = page.locator('[data-hud-window="messenger"] textarea').first();
      if (await input.count()) check(!overlaps((await input.boundingBox())!, db!), 'the dock covers no part of the composer');
      await shot(page, 'pc-1600x1000-messenger');
      const titleButtons = page.locator('[data-testid="hud-title-messenger"] button');
      await titleButtons.nth((await titleButtons.count()) - 2).click(); // maximize
      await page.waitForTimeout(600);
      const handle = await box(page, '[data-testid="hud-dock-handle"]');
      check(!!handle, 'maximized, the dock folds to its handle');
      const max = await box(page, '[data-hud-window="messenger"]');
      check(!!max && max.height >= 1000 - 4, 'the maximized window keeps the whole height');
      if ((await input.count()) && handle) check(!overlaps((await input.boundingBox())!, handle), 'the handle covers no part of the composer');
      await shot(page, 'pc-1600x1000-messenger-max');
      await titleButtons.nth((await titleButtons.count()) - 2).click(); // restore
      await titleButtons.last().click(); // close
    }

    // 16 and 23 agents.
    addSessions(9, 16);
    await waitParty(page, 17);
    await partyFits(page, 17);
    addSessions(17, 23);
    await waitParty(page, 24);
    await partyFits(page, 24);
    // A portrait low in the scrolled party: the inspector follows the scroll to its row.
    const deep = portraits(page).nth(20);
    await deep.scrollIntoViewIfNeeded();
    const deepId = Number(await deep.getAttribute('data-agent-id'));
    await deep.click();
    await alignCheck(page, deepId, '23 agents, the 21st portrait');
    await ccFolded(page, '1600 with 23');
    await shot(page, 'pc-1600x1000-23');
    await ctx.close();
    } // PC_PARTS
    {
      // FEAT-PARTY-V2: the phone shows the same member card as a bottom sheet.
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await phone.addInitScript(INIT + UI_THEME_INIT);
      await phone.addInitScript(
        (pairs) => {
          for (const [k, v] of pairs)
            try {
              localStorage.setItem(k, v);
            } catch {
              // about:blank
            }
        },
        Object.entries(STORE),
      );
      await phone.addCookies(cookies);
      const p = await phone.newPage();
      await p.goto(`http://127.0.0.1:${port}/`);
      await p.getByTestId('office-canvas').waitFor({ timeout: 60_000 });
      await p.waitForTimeout(6_000);
      await shot(p, 'phone-390x844');
      // FEAT-PARTY-V2 (owner 11-06 18:54): the strip above the usage line is the party, not the old name cards.
      const strip = p.getByTestId('party-strip');
      const phonePortraits = strip.locator('[data-testid="agent-card"][data-portrait]');
      await phonePortraits.nth(7).waitFor({ timeout: 60_000 }).catch(() => undefined);
      check((await strip.count()) === 1 && (await phonePortraits.count()) >= 8, `phone: the strip is the party's portraits (${await phonePortraits.count()})`);
      check((await p.locator('[data-testid="mobile-agent-bar"] [data-compact], [data-testid="mobile-agent-bar"] [data-testid="card-name"]').count()) === 0, 'phone: no old name cards');
      check((await strip.locator('.game-portrait-face canvas').count()) === (await phonePortraits.count()), 'phone: every portrait draws its face (the shared mug shot)');
      // The same parties as the PC: make one here (the list opens upward), show it, then everyone again.
      const head = p.getByTestId('party-select');
      await head.tap();
      await p.waitForTimeout(300);
      const menu = await p.getByTestId('party-menu').boundingBox();
      check(!!menu && menu.y >= 0 && menu.x >= 0 && menu.x + menu.width <= 390, `phone: the party list opens on screen (${JSON.stringify(menu)})`);
      if (!PHONE_ONLY) check((await p.locator('[data-testid="party-option"][data-party]:not([data-party="all"])').filter({ hasText: '프론트' }).count()) === 1, "phone: the PC's party 프론트 is listed");
      await shot(p, 'phone-390x844-party-menu');
      await p.getByTestId('party-new').tap();
      await p.getByTestId('party-name').fill('모바일');
      await p.getByTestId('party-name-save').tap();
      await p.waitForTimeout(300);
      await p.getByTestId('party-pick').filter({ hasText: 'lemon' }).tap();
      await p.getByTestId('party-pick').filter({ hasText: 'postbox' }).tap();
      await p.getByTestId('party-members-done').tap();
      await p.waitForTimeout(600);
      check((await phonePortraits.count()) === 2 && /모바일/.test(await head.innerText()), `phone: the new party shows its two (${await phonePortraits.count()})`);
      await shot(p, 'phone-390x844-party-two');
      const card = phonePortraits.first();
      if (await card.count()) await card.tap();
      await p.waitForTimeout(1200);
      const sheet = p.locator('[data-testid="inspector"][data-sheet]');
      check((await sheet.count()) === 1, 'phone: a card tap opens the member card as a bottom sheet');
      const sb = await sheet.boundingBox().catch(() => null);
      check(!!sb && Math.abs(sb.y + sb.height - 844) <= 2 && sb.width >= 388, `phone: the sheet sits at the bottom, full width (${JSON.stringify(sb)})`);
      const buttons = await sheet.locator('[data-testid="member-actions"] button').count();
      check(buttons >= 1 && buttons <= 3, `phone: one to three big buttons (${buttons})`);
      await shot(p, 'phone-390x844-sheet');
      await sheet.getByTestId('inspector-close').tap();
      await p.waitForTimeout(300);
      await head.tap();
      await p.locator('[data-testid="party-option"][data-party="all"]').tap();
      await p.waitForTimeout(600);
      check((await phonePortraits.count()) >= 8, 'phone: back on 모두');
      await phone.close();
    }
    // The card beside the mockup (ref-pc.png's right-hand 에이전트 정보), for the eye.
    if (!PHONE_ONLY) {
      const cmp = await browser.newContext({ viewport: { width: 1200, height: 760 } });
      const cp = await cmp.newPage();
      const url = (f: string) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
      await cp.setContent(`<body style="margin:0;background:#111;display:flex;gap:16px;padding:16px;align-items:flex-start;font:14px sans-serif;color:#ccc">
        <figure style="margin:0"><figcaption>ref-pc.png</figcaption><div style="width:330px;height:820px;overflow:hidden"><img src="${url(REF_PC)}" style="margin-left:-1160px;margin-top:-90px"></div></figure>
        <figure style="margin:0"><figcaption>${PREFIX} overview</figcaption><img src="${url(path.join(OUT, `${PREFIX}-card.png`))}"></figure>
        <figure style="margin:0"><figcaption>${PREFIX} stats</figcaption><img src="${url(path.join(OUT, `${PREFIX}-card-stats.png`))}"></figure></body>`);
      await cp.screenshot({ path: path.join(OUT, `${PREFIX}-compare-ref.png`), fullPage: true });
      await cmp.close();
    }
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
