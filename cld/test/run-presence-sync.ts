/**
 * PRESENCE-SYNC check: dist/cli.js with an isolated HOME on a spare port, headless Chromium (no GPU),
 * the page clock fixed at 22:00 host time (after hours), on desktop (1280x800) and phone (iPhone 13).
 *
 * Three orchestrators: `busy` (a tool call in flight), `grace` (it worked, then its turn ended: it
 * sits in the go-home grace, which a fixed clock never ends) and `gone` (idle since the page opened:
 * home). For each, the card bar's tag and the messenger's contact dot and conversation header agree:
 * busy and grace say the overtime word, gone says the off-duty word with a grey dot.
 * Screenshots go to cld/artifacts/presence-sync/.
 *
 *   npx tsx cld/test/run-presence-sync.ts <port 18256-18259>
 */
import { type BrowserContextOptions, devices, type Locator, type Page } from '@playwright/test';
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

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/presence-sync');
const FONTS = {
  malgun: '/mnt/c/Windows/Fonts/malgun.ttf',
  emoji: '/mnt/c/Windows/Fonts/seguiemj.ttf',
};
const FONT_CSS = `
@font-face { font-family: 'FS Pixel Sans'; src: url('/__ct/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }
@font-face { font-family: 'FS Pixel Sans'; src: url('/__ct/emoji.ttf');
  unicode-range: U+2300-23FF, U+2600-27BF, U+FE0F, U+1F000-1FAFF; }`;
const KST = (day: number, hh: number, mm = 0) =>
  new Date(`2026-10-${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+09:00`);

type Rec = Record<string, unknown>;
const call = (id: string, name: string, input: Rec) => ({ type: 'tool_use', id, name, input });
const said = (content: Rec[]): Rec => ({
  type: 'assistant',
  message: { model: 'claude-opus-4-5', content },
});
const userResult = (id: string, text: string): Rec => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
});
const sub = (parent: string, msg: Rec): Rec => ({
  type: 'progress',
  parentToolUseID: parent,
  data: { type: 'agent_progress', message: msg },
});
const turnEnd: Rec = { type: 'system', subtype: 'turn_duration', durationMs: 1000 };

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
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

function session(home: string, k: number, name: string, cwd: string) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = `c0420000-0000-4000-8000-${String(k).padStart(12, '0')}`;
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  const transcript = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(transcript, '');
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
      status: 'idle',
    }),
  );
  const subDir = path.join(projectDir, sessionId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  return { proc, transcript, subDir };
}

const cardFor = (page: Page, name: string) =>
  page.locator('[data-testid="agent-card"]').filter({
    has: page.locator('[data-testid="card-name"]', { hasText: new RegExp(`^${name}$`) }),
  });
/** Each card's name:tag(:+n) as the bar draws it now. */
const tags = (page: Page): Promise<string[]> =>
  page.$$eval('[data-testid="agent-card"]', (cards) =>
    cards.map(
      (c) =>
        `${c.querySelector('[data-testid="card-name"]')?.textContent}:${
          c.querySelector('[data-testid="duty-mark"]')?.textContent ?? ''
        }:${c.querySelector('[data-testid="temp-chip"]')?.textContent ?? ''}`,
    ),
  );


const PHONE = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 393, height: 852 } };
})();
const OVERTIME = '야근';
const OFF_DUTY = '퇴근';
const NAMES = ['busy', 'grace', 'gone'];
const WANT: Record<string, string> = { busy: OVERTIME, grace: OVERTIME, gone: OFF_DUTY };

/** Each card's tag, by name. */
const cardTags = async (page: Page): Promise<Record<string, string>> =>
  Object.fromEntries(
    (await tags(page)).map((t) => {
      const [name, mark] = t.split(':');
      return [name, mark];
    }),
  );

/** A messenger dot's facts: its state, presence and the word it carries. */
const dotOf = (scope: Locator) =>
  scope.getByTestId('lead-state').first().evaluate((el) => ({
    state: el.getAttribute('data-state'),
    presence: el.getAttribute('data-presence'),
    word: el.parentElement?.getAttribute('title') ?? '',
  }));

async function agree(page: Page, tag: string, shot: (n: string) => Promise<unknown>) {
  const cards = await cardTags(page);
  console.log(`${tag} cards`, JSON.stringify(cards));
  for (const n of NAMES) check(cards[n] === WANT[n], `${tag}: card ${n} says ${WANT[n]} (${cards[n] || 'none'})`);
  await shot(`${tag}-cards`);
  await page.getByRole('button', { name: '메신저', exact: true }).click();
  const messenger = page.getByRole('region', { name: '메신저', exact: true });
  const list = messenger.getByRole('list', { name: '연락처' });
  for (const n of NAMES) await list.getByRole('button', { name: n }).waitFor();
  await page.waitForTimeout(1_000);
  for (const n of NAMES) {
    const d = await dotOf(list.locator('li').filter({ hasText: n }));
    console.log(`${tag} list ${n}`, JSON.stringify(d));
    check(d.word === cards[n], `${tag}: contact ${n} says what its card says (${d.word} vs ${cards[n]})`);
    if (n === 'gone')
      check(d.state === 'off' && d.presence === 'away', `${tag}: gone has a grey dot (${d.state})`);
    else check(d.state !== 'off', `${tag}: ${n} keeps the dot of its real activity (${d.state})`);
  }
  await shot(`${tag}-messenger-list`);
  for (const n of NAMES) {
    await list.getByRole('button', { name: n }).click();
    const conv = messenger.getByRole('region', { name: `${n} 대화` });
    await conv.waitFor();
    const d = await dotOf(conv);
    check(d.word === cards[n], `${tag}: ${n}'s conversation header says ${cards[n]} (${d.word})`);
    await shot(`${tag}-messenger-header-${n}`);
    if (page.viewportSize()!.width < 600) {
      // The phone shows one screen at a time: back to the list.
      const back = messenger.getByRole('button', { name: /목록|뒤로/ }).first();
      if (await back.count()) await back.click();
    }
  }
  await page.getByRole('button', { name: '메신저', exact: true }).click();
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const sessions = NAMES.map((n, i) => session(home, 1 + i, n, `/work/${n}`));
  const [busy, grace] = sessions;
  const started = startDaemon({ home, claudePath }, port, ['--allow-chat', '--no-terminal'], { TZ: 'Asia/Seoul' });
  const pageErrors: string[] = [];
  const fonts = { malgun: fs.readFileSync(FONTS.malgun), emoji: fs.readFileSync(FONTS.emoji) };
  const browser = await launchBrowser({ officeHours: true });
  const append = (s: { transcript: string }, records: Rec[]) => {
    for (const r of records) fs.appendFileSync(s.transcript, JSON.stringify(r) + '\n');
  };
  const setup = async (opts: BrowserContextOptions) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true;');
    await ctx.route('**/__ct/*.ttf', (route) =>
      route.fulfill({
        body: route.request().url().endsWith('emoji.ttf') ? fonts.emoji : fonts.malgun,
        contentType: 'font/ttf',
      }),
    );
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await page.clock.setFixedTime(KST(21, 22));
    return { ctx, page };
  };
  const fontsIn = async (page: Page) => {
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가📖'));
  };
  try {
    const loginUrl = await started.loginUrl();
    const { ctx, page } = await setup({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await page.goto(loginUrl);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await fontsIn(page);
    // The phone opens now too: an idle orchestrator that was already idle at load goes home on any page.
    const phone = await setup({ ...PHONE, storageState: await ctx.storageState() });
    await phone.page.goto(`http://127.0.0.1:${port}/`);
    await fontsIn(phone.page);
    for (const p of [page, phone.page])
      await until('the three cards', async () => (await tags(p)).length >= 3);
    await page.waitForTimeout(6_000); // the office settled: the idle ones went home
    // busy: a tool call in flight. grace: the same, then its turn ends (idle, still in the grace).
    const work = (id: string) => said([call(id, 'Read', { file_path: '/work/app.log' })]);
    append(busy, [work('tu-b1')]);
    append(grace, [work('tu-g1')]);
    await until('busy and grace on overtime', async () => {
      const c = await cardTags(page);
      const d = await cardTags(phone.page);
      return c.busy === OVERTIME && c.grace === OVERTIME && d.busy === OVERTIME && d.grace === OVERTIME;
    });
    append(grace, [userResult('tu-g1', 'ok'), said([{ type: 'text', text: 'done' }]), turnEnd]);
    await page.waitForTimeout(4_000);
    const shotD = (n: string) => page.screenshot({ path: path.join(OUT, `desktop-${n}.png`) });
    await agree(page, 'desktop', (n) => shotD(n.replace('desktop-', '')));
    await agree(phone.page, 'phone', (n) =>
      phone.page.screenshot({ path: path.join(OUT, `phone-${n.replace('phone-', '')}.png`) }),
    );
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ') || 'none'})`);
  } finally {
    await browser.close();
    await started.stop();
    for (const s of sessions) s.proc.kill('SIGKILL');
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
  console.log('all checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
