/**
 * CH-4 꾸미기 check: dist/cli.js with an isolated HOME on a spare port, headless Chromium (no
 * GPU), desktop 1280x800 and phone 393x852. One fake Claude session (a `sleep` with a
 * transcript), no model is ever called.
 *
 * Desktop: the card's right-click opens the window; a mascot is changed (species, colour, face,
 * headgear) and saved: characters.json and the card face follow; 랜덤 then 되돌리기; 기본으로
 * pins the provider's Coral again; a person look is saved. Phone: card tap → the character's
 * menu → 꾸미기 opens as a page; a Dock button minimizes it. Screenshots: cld/artifacts/ch4/.
 *
 * CH-5: on the 사람 tab, part swatches (skin, hair, top, shoes) and two accessories are saved:
 * characters.json holds them, the card face has the hair colour; the phone's 꾸미기 page shows
 * the saved person. Screenshots: cld/artifacts/char-humanoid/.
 *
 *   npx tsx cld/test/run-looks.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { HUMANOID_SWATCHES, MASCOT_COLORS } from '../../core/src/cld/looks.js';
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
import { configDirectory } from '../../server/src/cld/configPath.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/ch4');

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
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true;');
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    return { ctx, page };
  };
  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
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
    await until('lead is pinned to Coral', () => looks().lead?.species === 'coral');
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
    await win.getByRole('button', { name: '퍼프' }).click();
    const pink = MASCOT_COLORS.puff[1];
    await win.getByRole('button', { name: pink }).click();
    await win.getByRole('button', { name: '졸림' }).click();
    await win.getByRole('button', { name: '왕관' }).click();
    await page.waitForTimeout(500);
    await shot(page, 'desktop-window');
    await win.screenshot({ path: path.join(OUT, 'desktop-window-close.png') });
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

    // 기본으로: the provider's Coral is pinned again.
    await win.getByRole('button', { name: '기본으로' }).click();
    await until('기본으로 pins Coral', () => looks().lead?.species === 'coral', 10_000);
    check(looks().lead?.gear === undefined, `기본으로 = the automatic look (${JSON.stringify(looks().lead)})`);

    // A person look.
    await win.getByRole('button', { name: '사람', exact: true }).click();
    await win.getByRole('button', { name: '모습 3' }).click();
    await page.waitForTimeout(300);
    await shot(page, 'desktop-window-person');
    await save.click();
    await until('the person look is saved', () => looks().lead?.palette === 2);
    await page.getByRole('button', { name: '꾸미기 닫기' }).click();
    await page.waitForTimeout(800);
    await shot(page, 'desktop-office-after');

    // CH-5: part colours and accessories on the person.
    const OUT5 = path.join(REPO_ROOT, 'cld/artifacts/char-humanoid');
    const S = HUMANOID_SWATCHES;
    const hair = S.hair[7]; // pink: easy to find on the card
    const colors = { skin: S.skin[3], hair, top: S.clothes[7], shoes: S.clothes[4] };
    await card.click({ button: 'right' });
    await win.waitFor();
    for (const [part, c] of Object.entries(colors)) await win.getByTestId(`looks-person-${part}-${c}`).click();
    await win.getByRole('button', { name: '안경' }).click();
    await win.getByRole('button', { name: '모자' }).click();
    check(
      (await win.locator('input[type="range"]').count()) === 0,
      'with part colours the hue slider is gone',
    );
    await page.waitForTimeout(500);
    await win.screenshot({ path: path.join(OUT5, 'desktop-person-tab.png') });
    await save.click();
    await until('the person colours are saved', () => looks().lead?.kind === 'humanoid');
    check(
      JSON.stringify(looks().lead) ===
        JSON.stringify({ v: 2, kind: 'humanoid', base: 2, colors, acc: ['glasses', 'cap'] }),
      `characters.json has the colours and accessories (${JSON.stringify(looks().lead)})`,
    );
    await until('the card face has the pink hair', () => cardHas(page, id, hair));
    check(true, 'the card face follows the part colours');
    await page.getByRole('button', { name: '꾸미기 닫기' }).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT5, 'desktop-office.png') });

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
    await phone5.screenshot({ path: path.join(OUT5, 'phone-office.png') });
    await phone5Card.tap();
    await phone5.getByRole('menuitem', { name: '꾸미기' }).tap({ timeout: 5_000 });
    const page5 = phone5.locator('[data-testid="looks-window"]');
    await page5.waitFor();
    check(
      (await page5.getByRole('button', { name: '모자' }).getAttribute('aria-pressed')) === 'true',
      'the phone page opens on the saved person (cap on)',
    );
    await phone5.waitForTimeout(500);
    await phone5.screenshot({ path: path.join(OUT5, 'phone-person-tab.png') });
    await page5.getByRole('button', { name: '안경' }).scrollIntoViewIfNeeded();
    await phone5.screenshot({ path: path.join(OUT5, 'phone-person-tab-accessories.png') });
    await phone5Ctx.close();

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
