/**
 * RANK-LEVELS check: dist/cli.js with an isolated HOME on a spare port, headless Chromium
 * (--disable-gpu), desktop 1280x800 and phone 393x852. Fake sessions only, no model is called.
 *
 * The office: the Claude session `lead` (Lv 45) in /work/alpha and a pre-seeded roster of six
 * employees at Lv 1, 11, 31, 51, 71 and 101. `lead` spawns six sub-agents on different models;
 * - every temp wears the rank icon of its employee's level (read back from its ring), and the
 *   six ranks come out as the table says whatever the models are;
 * - the orchestrator keeps its crown and writes its rank in the details;
 * - the 화면 tab's 직급 아이콘 switches the icon between 사원증, 넥타이 and 메달 (the canvases
 *   differ, the choice survives a reload), on the desktop and on the phone.
 * Also draws cld/artifacts/rank-levels/icons-sheet.png (3 styles x 11 ranks).
 *
 *   npx tsx cld/test/run-rank-levels.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';
import { rankSprite } from '../../webview-ui/src/cld/ez/rankSprites.js';
import { RANK_STYLES } from '../../webview-ui/src/cld/rank.js';
import { THEME } from '../../webview-ui/src/cld/theme.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/rank-levels');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__st/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
/** Level of each pre-seeded employee, and the rank it should wear (the owner's table). */
const LEVELS: Array<[number, string]> = [
  [1, 'intern'],
  [11, 'staff'],
  [31, 'assistant'],
  [51, 'deputy'],
  [71, 'director'],
  [101, 'vicePresident'],
];
const LEAD_LEVEL = 45;
const KO: Record<string, string> = {
  intern: '인턴', staff: '사원', senior: '주임', assistant: '대리', manager: '과장', deputy: '차장',
  general: '부장', director: '이사', managing: '상무', seniorManaging: '전무', vicePresident: '부사장',
};
const NAME_IDS = ['harry-potter', 'ron-weasley', 'hermione-granger', 'gandalf', 'frodo-baggins', 'legolas'];
const xpOf = (level: number) => 50 * level * (level - 1);

type Rec = Record<string, unknown>;
const call = (id: string, name: string, input: Rec) => ({ type: 'tool_use', id, name, input });
const said = (content: Rec[]): Rec => ({ type: 'assistant', message: { model: 'claude-sonnet-4-5', content } });
const sub = (parent: string, msg: Rec): Rec => ({
  type: 'progress',
  parentToolUseID: parent,
  data: { type: 'agent_progress', message: msg },
});

let oks = 0;
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  oks++;
  console.log(`ok - ${what}`);
}
async function until(what: string, fn: () => Promise<boolean>, ms = 45_000): Promise<void> {
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
  const sessionId = 'c1024000-0000-4000-8000-000000000002';
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  const transcript = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(path.join(projectDir, sessionId, 'subagents'), { recursive: true });
  fs.writeFileSync(transcript, '');
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now() - 600_000, procStart, version: '2.1.306', kind: 'interactive', name, status: 'busy' }),
  );
  return { proc, transcript };
}

interface Plate {
  id: number;
  kind: string;
  level: number | null;
  rank: string | null;
  icon: string | null;
}
const plates = (page: Page): Promise<Plate[]> =>
  page.$$eval('[data-testid="agent-overlay"]', (nodes) =>
    nodes.map((n) => ({
      id: Number(n.getAttribute('data-agent-id')),
      kind: n.getAttribute('data-kind') ?? '',
      level: Number(/\d+/.exec(n.querySelector('[data-testid="level-ring"]')?.getAttribute('aria-label') ?? '')?.[0]) || null,
      rank: n.querySelector('[data-testid="rank-icon"]')?.getAttribute('data-rank') ?? null,
      icon: n.querySelector('[data-testid="rank-icon"] canvas')?.toDataURL() ?? null,
    })),
  );

/** All 3 styles x 11 ranks on one page, with the level band and both names under each. */
async function iconSheet(browser: Awaited<ReturnType<typeof launchBrowser>>): Promise<void> {
  const sprites = RANK_STYLES.map((style) => THEME.ranks.map((r) => rankSprite(style, r.id)));
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 640 } });
  await ctx.route('**/f.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
  await ctx.route('http://sheet.local/', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
  const page = await ctx.newPage();
  await page.goto('http://sheet.local/');
  const names = THEME.ranks.map((r, i) => ({
    ko: KO[r.id],
    from: r.from,
    to: THEME.ranks[i + 1] ? THEME.ranks[i + 1].from - 1 : null,
  }));
  const styleNames = ['사원증 (기본)', '넥타이', '메달'];
  await page.evaluate(
    ({ sprites, names, styleNames }) => {
      const S = 8;
      // eslint-disable-next-line pixel-agents/no-inline-colors -- the sheet page is not UI
      document.head.insertAdjacentHTML('beforeend', `<style>@font-face{font-family:F;src:url(/f.ttf)}body{margin:0;background:#1e1e2e;color:#e8e8f0;font:14px F,sans-serif}
        table{border-collapse:collapse;margin:16px}td,th{padding:6px 8px;text-align:center;border:1px solid #3a3a52;min-width:84px}th{font-weight:normal;font-size:12px;color:#b8b8c8}
        td.s{text-align:left;font-weight:bold;min-width:100px}canvas{image-rendering:pixelated}</style>`);
      const rows = ['<tr><th></th>' + names.map((n) => `<th>${n.ko}<br>${n.to ? `Lv ${n.from}-${n.to}` : `Lv ${n.from}+`}</th>`).join('') + '</tr>'];
      sprites.forEach((row, si) => {
        rows.push(`<tr><td class="s">${styleNames[si]}</td>${row.map((_, ri) => `<td><canvas data-s="${si}" data-r="${ri}"></canvas></td>`).join('')}</tr>`);
      });
      document.body.innerHTML = `<table>${rows.join('')}</table>`;
      document.querySelectorAll<HTMLCanvasElement>('canvas').forEach((c) => {
        const sp = sprites[Number(c.dataset.s)][Number(c.dataset.r)];
        c.width = 7 * S;
        c.height = 10 * S;
        const g = c.getContext('2d')!;
        sp.forEach((line, y) => line.forEach((col, x) => { if (col) { g.fillStyle = col; g.fillRect(x * S, y * S, S, S); } }));
      });
    },
    { sprites, names, styleNames },
  );
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'icons-sheet.png'), fullPage: true });
  await ctx.close();
}

async function main() {
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  // The roster and its levels, before the daemon starts.
  const cfg = path.join(home, '.config/cld-gui');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'roster.json'),
    JSON.stringify({
      v: 1,
      projects: {
        lead: {
          employees: LEVELS.map((_, k) => ({ id: `e${k + 1}`, nameId: NAME_IDS[k], hiredAt: 1, lastReleasedAt: k + 1, execution: null })),
          executions: {},
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(cfg, 'levels.json'),
    JSON.stringify({
      levels: {
        ...Object.fromEntries(LEVELS.map(([lv], k) => [`emp:e${k + 1}`, { xp: xpOf(lv), rebirths: 0 }])),
        'name:lead': { xp: xpOf(LEAD_LEVEL), rebirths: 0 },
      },
    }),
  );
  const lead = session(home, 'lead', '/work/alpha');
  const append = (records: Rec[]) => {
    for (const r of records) fs.appendFileSync(lead.transcript, JSON.stringify(r) + '\n');
  };
  const started = startDaemon({ home, claudePath }, port, ['--no-terminal', '--engine', 'on'], {});
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  try {
    await iconSheet(browser);
    const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
      const ctx = await browser.newContext(opts);
      await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true;');
      await ctx.route('**/__st/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
      const page = await ctx.newPage();
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      return { ctx, page };
    };
    const { ctx: desk, page } = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await page.goto(await started.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    const { page: phone } = await open({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    await phone.context().addCookies(await desk.cookies());
    await phone.goto(`http://127.0.0.1:${port}/`);
    for (const p of [page, phone]) {
      await p.addStyleTag({ content: FONT_CSS });
      await until('lead is in', async () => (await plates(p)).some((x) => x.kind === 'orchestrator'));
    }
    const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
    if (await closeInfo.count()) await closeInfo.click();

    // Six sub-agents on different models.
    const models = ['opus', 'sonnet', 'haiku', 'opus', 'sonnet', 'haiku'];
    append([
      said(models.map((m, k) => call(`tu-${k}`, 'Task', { description: `job ${k + 1}`, prompt: 'x', model: m }))),
      ...models.map((_, k) => sub(`tu-${k}`, said([call(`tu-${k}-1`, 'Grep', { pattern: 'x' })]))),
    ]);
    for (const p of [page, phone])
      await until('six temps with a level', async () => (await plates(p)).filter((x) => x.kind === 'subagent' && x.level).length === 6);
    await page.waitForTimeout(3_000);

    const rankTable = (lv: number) => LEVELS.filter(([from]) => lv >= from).at(-1)![1];
    for (const [tag, p] of [['desktop', page], ['phone', phone]] as const) {
      const temps = (await plates(p)).filter((x) => x.kind === 'subagent');
      check(
        temps.every((x) => x.rank === rankTable(x.level!)),
        `${tag}: every temp wears the rank of its level (${temps.map((x) => `Lv${x.level}=${x.rank}`).join(', ')})`,
      );
      check(
        JSON.stringify(temps.map((x) => x.level).sort((a, b) => a! - b!)) === JSON.stringify(LEVELS.map(([lv]) => lv)),
        `${tag}: the six levels 1 11 31 51 71 101 are all on the plates, whatever their models (opus, sonnet, haiku)`,
      );
      const leadPlate = (await plates(p)).find((x) => x.kind === 'orchestrator')!;
      check(leadPlate.rank === 'lead' && leadPlate.level === LEAD_LEVEL, `${tag}: the orchestrator keeps its crown at Lv ${leadPlate.level}`);
    }

    // The orchestrator's details write its rank (과장 at Lv 45); a temp's details write its own.
    const lp = (await plates(page)).find((x) => x.kind === 'orchestrator')!;
    const select = (id: number | null) =>
      page.evaluate((id) => (window as unknown as { __pixelAgentsTestHooks: { selectAgent: (id: number | null) => void } }).__pixelAgentsTestHooks.selectAgent(id as number), id);
    await select(lp.id);
    const leadRank = page.locator(`[data-testid="agent-overlay"][data-agent-id="${lp.id}"] [data-testid="rank-text"]`);
    await leadRank.waitFor({ timeout: 5_000 });
    check((await leadRank.textContent())?.includes(KO.manager), `the orchestrator's details say: ${await leadRank.textContent()}`);
    const icon = page.locator(`[data-testid="agent-overlay"][data-agent-id="${lp.id}"] [data-testid="rank-icon"]`);
    check((await icon.getAttribute('aria-label'))?.startsWith(KO.manager), `its icon's text starts with the rank (${await icon.getAttribute('aria-label')})`);
    const top = (await plates(page)).find((x) => x.kind === 'subagent' && x.level === 101)!;
    await select(top.id);
    const topRank = page.locator(`[data-testid="agent-overlay"][data-agent-id="${top.id}"] [data-testid="rank-text"]`);
    await topRank.waitFor({ timeout: 5_000 });
    check((await topRank.textContent())?.includes(KO.vicePresident), `the Lv 101 temp's details say: ${await topRank.textContent()}`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, 'desktop-details.png') });
    await select(null);

    // 설정 → 화면 → 직급 아이콘: each style, on both viewports.
    const iconsOf = async (p: Page) => Object.fromEntries((await plates(p)).filter((x) => x.kind === 'subagent').map((x) => [x.level, x.icon]));
    const seen: Record<string, Record<string, string | null>> = {};
    for (const [tag, p] of [['desktop', page], ['phone', phone]] as const) {
      await p.getByRole('button', { name: '설정', exact: true }).first().click();
      await p.getByRole('tab', { name: '화면', exact: true }).click();
      const option = p.getByTestId('rank-icon-option');
      check(await option.isVisible(), `${tag}: 설정 → 화면 has 직급 아이콘`);
      check((await option.locator('[aria-pressed="true"]').getAttribute('data-rank-style')) === 'badge', `${tag}: the default is 사원증`);
      for (const style of RANK_STYLES) {
        await option.locator(`[data-rank-style="${style}"]`).click();
        await p.waitForTimeout(300);
        if (style === 'tie') await p.screenshot({ path: path.join(OUT, `${tag}-settings.png`) });
        await p.getByRole('button', { name: 'x', exact: true }).last().click();
        await p.waitForTimeout(800);
        seen[`${tag}:${style}`] = await iconsOf(p);
        await p.screenshot({ path: path.join(OUT, `${tag}-${style}.png`) });
        if (style !== RANK_STYLES.at(-1)) {
          await p.getByRole('button', { name: '설정', exact: true }).first().click();
          await p.getByRole('tab', { name: '화면', exact: true }).click();
        }
      }
      const [a, b, c] = RANK_STYLES.map((s) => seen[`${tag}:${s}`]);
      check(
        [1, 11, 31, 51, 71, 101].every((lv) => a[lv] && b[lv] && c[lv] && a[lv] !== b[lv] && b[lv] !== c[lv] && a[lv] !== c[lv]),
        `${tag}: the three styles draw different icons for every rank`,
      );
      check(new Set(Object.values(a)).size === 6, `${tag}: six ranks, six different 사원증 icons`);
    }
    // The choice survives a reload.
    await page.reload();
    await page.addStyleTag({ content: FONT_CSS });
    await until('temps back', async () => (await plates(page)).filter((x) => x.kind === 'subagent' && x.level).length === 6);
    await page.waitForTimeout(1_000);
    const after = await iconsOf(page);
    check(JSON.stringify(after) === JSON.stringify(seen['desktop:medal']), 'the last choice (메달) is still in use after a reload');
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
    console.log(`all ${oks} checks passed`);
  } finally {
    await browser.close();
    started.child.kill();
    lead.proc.kill();
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
