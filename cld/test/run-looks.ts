/**
 * CH-4 꾸미기 check: dist/cli.js with an isolated HOME on a spare port, headless Chromium (no
 * GPU), desktop 1280x800 and phone 393x852. One fake Claude session (a `sleep` with a
 * transcript), no model is ever called.
 *
 * Desktop: the card's right-click opens the window; a mascot is changed (species, colour, face,
 * headgear) and saved: characters.json and the card face follow; 랜덤 then 되돌리기; 기본으로
 * pins a built-in person again; a person look is saved. Phone: card tap → the character's
 * menu → 꾸미기 opens as a page; a Dock button minimizes it.
 *
 * CHARS-1104: the lead (a named agent) is first pinned to a built-in person, not a mascot; the 사람
 * tab is the 23 people to pick from (three groups), the phone's 꾸미기 page opens on the saved one.
 * Screenshots: cld/artifacts/chars-1104/looks-*.png.
 *
 *   npx tsx cld/test/run-looks.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { CHAR_COUNT } from '../../core/src/assets/constants.js';
import { MASCOT_COLORS } from '../../core/src/cld/looks.js';
import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { configDirectory } from '../../server/src/cld/configPath.js';
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
const OUT = path.join(REPO_ROOT, 'cld/artifacts/chars-1104');

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => Promise<boolean> | boolean, ms = 30_000): Promise<void> {
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
  const sessionId = 'c1024400-0000-4000-8000-000000000001';
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  // At work (reading a file), so it stays at its desk and can be selected.
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-haiku-4-5',
        content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: `${cwd}/README.md` } }],
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
  fs.writeFileSync(store, JSON.stringify({ $meta: { v: 2, pinnedAt: 'x' } }));
  const lead = session(home, 'lead', '/work/alpha');
  const started = startDaemon({ home, claudePath }, port, ['--no-terminal'], {});
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;');
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    return { ctx, page };
  };
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `looks-${name}.png`) });
  const isPerson = (l: Record<string, unknown> | undefined) =>
    typeof l?.palette === 'number' && l.palette < CHAR_COUNT && l.hueShift === 0;
  const looks = () => JSON.parse(fs.readFileSync(store, 'utf-8')) as Record<string, Record<string, unknown>>;

  try {
    const loginUrl = await started.loginUrl();
    const { ctx: desk, page } = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    await page.goto(loginUrl);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    const card = page.locator('[data-testid="agent-card"]').first();
    await card.waitFor();
    const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
    if (await closeInfo.count()) await closeInfo.click();
    await until('lead is pinned to a built-in person', () => isPerson(looks().lead));
    const id = Number(await card.getAttribute('data-agent-id'));

    // The phone: card tap → the character's menu → 꾸미기 as a page.
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
    // A card tap follows nothing until the character exists (just after a login it may not yet).
    await phone.locator('[data-testid="agent-overlay"]').first().waitFor();
    await phone.waitForTimeout(500);
    await phoneCard.tap();
    await phone.getByRole('menuitem', { name: '꾸미기' }).tap({ timeout: 5_000 });
    const page2 = phone.locator('[data-testid="looks-window"]');
    await page2.waitFor();
    await page2.getByRole('button', { name: '마스코트' }).tap();
    await phone.waitForTimeout(500);
    await shot(phone, 'phone-page');
    check(await phone.getByTestId('mobile-dock').isVisible(), 'the Dock stays visible over the 꾸미기 page');
    await phone.locator('[data-dock="board"]').tap();
    await phone.waitForTimeout(300);
    check(!(await page2.isVisible()), 'another Dock button minimizes 꾸미기');
    await phone.locator('[data-dock="office"]').tap();
    await phone.waitForTimeout(500);
    await shot(phone, 'phone-office-after');
    await phoneCtx.close();

    // Desktop entry: the card's right-click.
    await card.click({ button: 'right' });
    const win = page.locator('[data-testid="looks-window"]');
    await win.waitFor();
    check((await win.getAttribute('data-name')) === 'lead', 'the card opens 꾸미기 for its character');
    const save = win.getByTestId('looks-save');
    check(await save.isDisabled(), '저장 is off while nothing changed');
    // CHARS-1104: the lead is a person, so the window opens on the 사람 tab
    await win.getByRole('button', { name: '마스코트' }).click();
    await win.getByRole('button', { name: '퍼프' }).click();
    const pink = MASCOT_COLORS.puff[1];
    await win.getByRole('button', { name: pink }).click();
    await win.getByRole('button', { name: '졸림' }).click();
    await win.getByRole('button', { name: '왕관' }).click();
    await page.waitForTimeout(500);
    await shot(page, 'desktop-window');
    await win.screenshot({ path: path.join(OUT, 'looks-desktop-window-close.png') });
    await save.click();
    await until('the look is saved', () => looks().lead?.species === 'puff');
    check(
      JSON.stringify(looks().lead) ===
        JSON.stringify({ v: 2, kind: 'mascot', species: 'puff', color: pink, expr: 'sleepy', gear: 'crown' }),
      `characters.json has the saved look (${JSON.stringify(looks().lead)})`,
    );
    await until('the card face is the pink Puff', () => cardHas(page, id, pink));
    check(true, 'the card face follows at once');

    // 랜덤 changes the draft; 되돌리기 brings back the saved look.
    await win.getByRole('button', { name: '랜덤' }).click();
    const revert = win.getByRole('button', { name: '되돌리기' });
    await until('랜덤 made a change', async () => !(await revert.isDisabled()));
    await revert.click();
    check(await save.isDisabled(), '되돌리기: back to the saved look (nothing to save)');

    // 기본으로: a built-in person is pinned again (a named agent's automatic look).
    await win.getByRole('button', { name: '기본으로' }).click();
    await until('기본으로 pins a person', () => isPerson(looks().lead), 10_000);
    check(true, `기본으로 = the automatic look (${JSON.stringify(looks().lead)})`);

    // The 사람 tab: the 23 people in three groups; one is saved.
    await win.getByRole('button', { name: '사람', exact: true }).click();
    const people = win.locator('[data-testid^="looks-people-"]');
    check((await people.count()) === CHAR_COUNT, `the 사람 tab shows the ${CHAR_COUNT} people`);
    for (const group of ['공대 너드', '실리콘밸리', '인도 공대 형님'])
      check(await win.getByRole('region', { name: group }).isVisible(), `the ${group} group is there`);
    const pick = looks().lead?.palette === 2 ? 12 : 2;
    await win.getByTestId(`looks-people-${pick}`).click();
    await page.waitForTimeout(300);
    await shot(page, 'desktop-window-person');
    await win.screenshot({ path: path.join(OUT, 'looks-desktop-people-tab.png') });
    await save.click();
    await until('the person look is saved', () => looks().lead?.palette === pick);
    check(
      JSON.stringify(looks().lead) === JSON.stringify({ palette: pick, hueShift: 0 }),
      `characters.json has the person (${JSON.stringify(looks().lead)})`,
    );
    await page.getByRole('button', { name: '꾸미기 닫기' }).click();
    await page.waitForTimeout(800);
    await shot(page, 'desktop-office-after');

    const { ctx: phone5Ctx, page: phone5 } = await open({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    await phone5Ctx.addCookies(await desk.cookies());
    await phone5.goto(`http://127.0.0.1:${port}/`);
    const phone5Card = phone5.locator('[data-testid="agent-card"]').first();
    await phone5Card.waitFor();
    const phone5Info = phone5.getByRole('button', { name: '정보 창 닫기' });
    if (await phone5Info.count()) await phone5Info.click();
    await phone5.locator('[data-testid="agent-overlay"]').first().waitFor();
    await phone5.waitForTimeout(800);
    await shot(phone5, 'phone-office');
    await phone5Card.tap();
    await phone5.getByRole('menuitem', { name: '꾸미기' }).tap({ timeout: 5_000 });
    const page5 = phone5.locator('[data-testid="looks-window"]');
    await page5.waitFor();
    check(
      (await page5.getByTestId(`looks-people-${pick}`).getAttribute('aria-pressed')) === 'true',
      'the phone page opens on the saved person',
    );
    await phone5.waitForTimeout(500);
    await shot(phone5, 'phone-people-tab');
    await phone5Ctx.close();

    // Review: sheets that have not arrived (a slow phone): 꾸미기 opens on the 사람 tab without them.
    const { ctx: lateCtx, page: late } = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    await lateCtx.addCookies(await desk.cookies());
    let held = 0;
    await lateCtx.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => {
        if (typeof m === 'string' && m.includes('"characterSpritesLoaded"')) held++;
        else ws.send(m);
      });
    });
    await late.goto(`http://127.0.0.1:${port}/`);
    const lateCard = late.locator('[data-testid="agent-card"]').first();
    await lateCard.waitFor();
    const lateInfo = late.getByRole('button', { name: '정보 창 닫기' });
    if (await lateInfo.count()) await lateInfo.click();
    await until('the sheets were held back', () => held > 0);
    await lateCard.click({ button: 'right' });
    const lateWin = late.locator('[data-testid="looks-window"]');
    await lateWin.waitFor();
    await late.waitForTimeout(800);
    check(
      (await lateWin.isVisible()) &&
        (await lateWin.getByRole('button', { name: '사람', exact: true }).getAttribute('aria-pressed')) === 'true',
      'without the sheets 꾸미기 opens on the 사람 tab and stays up',
    );
    check((await lateWin.locator('[data-testid^="looks-people-"]').count()) === 0, 'no person to pick before the sheets');
    await shot(late, 'desktop-people-tab-no-sheets');
    await lateCtx.close();

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
