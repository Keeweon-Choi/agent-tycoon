/**
 * LOOKS-TABS (owner 11-04 18:17/18:19): 꾸미기 is open again with two tabs, 마스코트 and 사람; the
 * 사람 tab lists the 23 people, the built-in bunny and the owner's imported sheets, then '+ 캐릭터 추가'.
 * dist/cli.js with an isolated HOME on a spare port, headless Chromium (--disable-gpu), desktop
 * 1282x832. One fake Claude session, no model. The harness' later features are off
 * (window.__AGENT_TYCOON_LATER_FEATURES = 'off'), so 사람 꾸미기 and 커스텀 are hidden.
 *
 * Character menu → 꾸미기; exactly the tabs 마스코트 and 사람; 23 people, bunny, '+ 캐릭터 추가';
 * bunny saved → the card face and characters.json follow; a mascot saved likewise; one small sheet
 * imported from the 사람 tab is picked, saved, listed, and the window reopens on 사람 with it lit;
 * 설정 > 내 캐릭터 shows the same two tabs.
 * Run with `--on` (later features on, four tabs) to see the 'two tabs' check fail (negative control).
 * Screenshots to agent-tycoon/artifacts/looks-tabs-1104/.
 *
 *   npx tsx agent-tycoon/test/run-looks-tabs-1104.ts <port 18570-18579> [--on]
 */
import type { Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { CHAR_COUNT } from '../../core/src/assets/constants.js';
import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
  topBarButton,
  topBarReady,
} from '../../server/src/agent-tycoon/testHome.js';

const port = sparePort();
const ON = process.argv.includes('--on');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/looks-tabs-1104');
const SHEETS_DIR = ['../specs', '.worktrees/specs']
  .map((d) => path.join(REPO_ROOT, d, 'owner-iso-chars-1026'))
  .find((d) => fs.existsSync(d));

let failed = 0;
function check(ok: unknown, what: string): void {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} - ${what}`);
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
  const sessionId = 'c1104180-0000-4000-8000-000000000001';
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

/** The card portrait as pixels: it changes when the character's look does. */
const faceOf = (page: Page) =>
  page
    .locator('[data-testid="agent-card"] canvas')
    .first()
    .evaluate((c: HTMLCanvasElement) => c.toDataURL());

async function main() {
  if (!SHEETS_DIR) throw new Error('no owner-iso-chars-1026 sheets (SHEETS_DIR)');
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const store = path.join(configDirectory(home), 'characters.json');
  fs.writeFileSync(store, JSON.stringify({ $meta: { v: 2, pinnedAt: 'x' } }));
  const lead = session(home, 'lead', '/work/alpha');
  const daemon = startDaemon({ home, claudePath }, port, ['--no-terminal'], {});
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  const looks = () =>
    JSON.parse(fs.readFileSync(store, 'utf-8')) as Record<string, Record<string, unknown>>;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1282, height: 832 } });
    await ctx.addInitScript(
      `globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;${ON ? '' : " window.__AGENT_TYCOON_LATER_FEATURES = 'off';"}`,
    );
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await topBarReady(page, 60_000);
    const card = page.locator('[data-testid="agent-card"]').first();
    await card.waitFor();
    const info = page.getByRole('button', { name: '정보 창 닫기' });
    if (await info.count()) await info.first().click();
    await page.locator('[data-testid="agent-overlay"]').first().waitFor();
    await until('lead is pinned', () => typeof looks().lead?.palette === 'number');
    await page.waitForTimeout(800);
    const shot = (name: string) =>
      page.screenshot({ path: path.join(OUT, `${ON ? 'ON-' : ''}${name}.png`) });
    const win = page.locator('[data-testid="looks-window"]');
    const save = win.getByTestId('looks-save');
    const tabsOf = () =>
      win.getByRole('navigation', { name: '모습 종류' }).getByRole('button').allTextContents();
    const closeWin = async () => {
      await page.getByRole('button', { name: '꾸미기 닫기' }).click();
      await win.waitFor({ state: 'detached' });
    };

    // 1. the character's menu has 꾸미기
    await card.click();
    await page.locator('[data-testid="stat-open"]').first().waitFor({ timeout: 8_000 });
    const item = page.getByRole('menuitem', { name: '꾸미기' });
    check((await item.count()) === 1, 'the character menu has 꾸미기');
    await shot('character-menu');
    await item.click();
    await win.waitFor();

    // 2. exactly two tabs
    const tabs = await tabsOf();
    check(
      JSON.stringify(tabs) === JSON.stringify(['마스코트', '사람']),
      `the tabs are 마스코트 and 사람 (${tabs.join(', ')})`,
    );
    check(
      (await win
        .getByRole('button', { name: '사람', exact: true })
        .getAttribute('aria-pressed')) === 'true',
      'the lead (a person) opens on 사람',
    );

    // 3. 사람 tab: 23 people, the bunny, the add chip
    check(
      (await win.locator('[data-testid^="looks-people-"]').count()) === CHAR_COUNT,
      `the 사람 tab shows the ${CHAR_COUNT} people`,
    );
    const bunny = win.getByTestId('looks-sheetchar-builtin-bunny');
    check((await bunny.count()) === 1, 'the built-in bunny is a chip after the people');
    const add = win.getByTestId('looks-sheetchar-add');
    check(
      (await add.textContent())?.includes('캐릭터 추가'),
      "the '+ 캐릭터 추가' chip is the last one",
    );
    await win.screenshot({ path: path.join(OUT, `${ON ? 'ON-' : ''}people-tab.png`) });

    // 4. the bunny: saved, the card face and characters.json follow
    let face = await faceOf(page);
    await bunny.click();
    check((await bunny.getAttribute('aria-pressed')) === 'true', 'the bunny chip lights');
    await save.click();
    await until('the bunny is saved', () => looks().lead?.preset === 'builtin-bunny');
    check(
      JSON.stringify(looks().lead) === JSON.stringify({ preset: 'builtin-bunny' }),
      'characters.json has the bunny',
    );
    await until('the card face is the bunny', async () => (await faceOf(page)) !== face);
    check(true, 'the card face changed to the bunny');
    await page.waitForTimeout(800);
    await shot('office-bunny');

    // 5. a mascot: saved, the card follows
    face = await faceOf(page);
    await win.getByRole('button', { name: '마스코트' }).click();
    await win.getByRole('button', { name: '퍼프' }).click();
    await save.click();
    await until('the mascot is saved', () => looks().lead?.species === 'puff');
    await until('the card face is the mascot', async () => (await faceOf(page)) !== face);
    check(true, 'a mascot saved: characters.json and the card follow');
    await page.waitForTimeout(800);
    await shot('office-mascot');

    // 6. one small sheet added from the 사람 tab
    await win.getByRole('button', { name: '사람', exact: true }).click();
    await win.getByTestId('looks-sheetchar-add').click();
    await page.getByTestId('sheet-import-file').setInputFiles(path.join(SHEETS_DIR, 'char-3.png'));
    await page.getByTestId('sheet-import-report').waitFor({ timeout: 60_000 });
    await page.getByTestId('sheet-import-name').fill('내 캐릭터');
    await shot('sheet-import');
    await page.getByTestId('sheet-import-save').click();
    await save.waitFor({ timeout: 30_000 });
    check(
      (await win
        .getByRole('button', { name: '사람', exact: true })
        .getAttribute('aria-pressed')) === 'true',
      'after the import the window is on 사람',
    );
    const mine = win.locator('[data-testid^="looks-sheetchar-"][aria-pressed="true"]');
    await mine.first().waitFor({ timeout: 10_000 });
    const mineId = ((await mine.first().getAttribute('data-testid')) ?? '').replace(
      'looks-sheetchar-',
      '',
    );
    check(
      mineId !== '' && mineId !== 'builtin-bunny',
      `the new character is listed and picked (${mineId})`,
    );
    face = await faceOf(page);
    await save.click();
    await until('the sheet look is saved', () => looks().lead?.preset === mineId);
    await until('the card face is the new character', async () => (await faceOf(page)) !== face);
    check(true, 'the added character shows in the office');
    await win.getByTestId('looks-sheetchar-add').scrollIntoViewIfNeeded();
    await win.screenshot({ path: path.join(OUT, `${ON ? 'ON-' : ''}people-tab-added.png`) });
    await closeWin();
    await page.waitForTimeout(1000);
    await shot('office-added');

    // 7. reopened: the saved sheet look (a hidden tab's kind) opens on 사람 with its chip lit
    await card.click({ button: 'right' });
    await win.waitFor();
    check(
      (await win
        .getByRole('button', { name: '사람', exact: true })
        .getAttribute('aria-pressed')) === 'true' &&
        (await win.getByTestId(`looks-sheetchar-${mineId}`).getAttribute('aria-pressed')) ===
          'true',
      'a sheet look reopens on 사람 with its chip lit',
    );
    check(
      (await win.locator('[data-testid^="looks-people-"][aria-pressed="true"]').count()) === 0,
      'no one of the 23 is lit then',
    );
    await closeWin();

    // 8. 설정 > 내 캐릭터: the same two tabs
    await topBarButton(page, '설정');
    await page.getByTestId('owner-character-pick').click();
    await win.waitFor();
    const ownerTabs = await tabsOf();
    check(
      JSON.stringify(ownerTabs) === JSON.stringify(['마스코트', '사람']),
      `the owner's character window has the tabs 마스코트 and 사람 (${ownerTabs.join(', ')})`,
    );
    await shot('owner-looks');
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
    console.log(failed ? `${failed} checks FAILED` : 'all checks passed');
  } finally {
    await browser.close();
    await daemon.stop();
    lead.kill();
    killFakeSessions(home);
  }
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
