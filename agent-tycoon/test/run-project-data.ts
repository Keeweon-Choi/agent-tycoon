/**
 * RENAME + PROJECT-DATA visual check: dist/cli.js in a temp HOME (the engine fake as `claude`) with
 * two running projects, alpha and beta, each with a conversation, a look and a level.
 *  - `agty rename --project alpha tycoon-admin` (the owner's CLI): applied after the turn, the
 *    session back as `-n tycoon-admin --resume <its id>`; its look and level follow, and the
 *    messenger lists tycoon-admin with alpha's history.
 *  - The remove dialog with its purge box, desktop and phone; beta removed with the box on: its
 *    level, look and inbox gone, its conversation file kept, and the messenger shows it as
 *    "(알 수 없음)" with its history, read-only (its own note).
 *  - 대화방 지우기 (desktop: beta; phone: tycoon-admin removed without the box): the confirmation,
 *    then its own conversation files gone (a renamed agent's copy and the conversation it
 *    continued), the other agent's kept, the contact off the list.
 * Screenshots in agent-tycoon/artifacts/project-data/.
 *
 *   npx tsx agent-tycoon/test/run-project-data.ts [port 18266|18267]
 */
import type { Browser, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { transcriptPath } from '../../server/src/agent-tycoon/providers/claudeProvider.js';
import {
  assertPortFree,
  engineCalls,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openOfficeWindow,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';
import { engineButton, engineRow } from './engineRow.js';

const port = Number(process.argv[2]) || 18266;
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/project-data');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__pd/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 300_000;
let oks = 0;
const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  oks++;
  console.log(`ok - ${text}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(what: string, test: () => boolean, timeout = 30_000): Promise<void> {
  for (const end = Date.now() + timeout; ; await wait(200)) {
    if (test()) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}

async function main() {
  if (port !== 18266 && port !== 18267) throw new Error('port 18266 or 18267');
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  const put = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(cfg, rel)), { recursive: true });
    fs.writeFileSync(path.join(cfg, rel), JSON.stringify(data));
  };
  const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(cfg, rel), 'utf8')) as Record<string, any>;
  // Our own temp HOME and port, never the live daemon's.
  put('config.json', { accessChosen: true, port });
  const folders = { alpha: path.join(home, 'work', 'alpha'), beta: path.join(home, 'work', 'beta') };
  for (const f of Object.values(folders)) fs.mkdirSync(f, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  put('projects.json', {
    v: 2,
    projects: [
      { projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: folders.alpha, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' },
      { projectId: 'p_bbbbbbbbbb', name: 'beta', folder: folders.beta, room: '개발실', leadAssignmentId: 'a_bbbbbbbbbb' },
    ],
  });
  put('assignments.json', {
    v: 1,
    assignments: [
      { assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true },
      { assignmentId: 'a_bbbbbbbbbb', projectId: 'p_bbbbbbbbbb', role: 'lead', provider: 'claude', wantRunning: true },
    ],
  });
  // Before the daemon reads them: each one's look and Lv/XP/환생.
  put('characters.json', { alpha: { palette: 3, hueShift: 90 }, beta: { palette: 1, hueShift: 0 } });
  put('levels.json', { v: 1, levels: { 'engine:alpha': { xp: 350, rebirths: 2 }, 'engine:beta': { xp: 120, rebirths: 1 } } });
  const daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, [
    '--engine',
    'on',
    '--allow-chat',
    '--allow-actions',
    '--no-terminal',
  ]);
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL'); // our own daemon only
  }, DEADLINE_MS);
  try {
    const cli = (...args: string[]) =>
      JSON.parse(
        spawnSync(process.execPath, [path.join(REPO_ROOT, 'agent-tycoon/bin/agty'), ...args], {
          env: { ...process.env, HOME: home, AGTY_OUTPUT: 'json' },
          encoding: 'utf8',
          timeout: 60_000,
        }).stdout || '{}',
      ) as Record<string, unknown>;
    type Session = { name: string; jobId: string; cwd: string; sessionId: string };
    const session = (name: string): Session | null => {
      for (const file of fs.readdirSync(path.join(home, '.claude/sessions'))) {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(home, '.claude/sessions', file), 'utf8')) as Session;
          if (s.name === name) return s;
        } catch {
          /* a fake is writing */
        }
      }
      return null;
    };
    await daemon.loginUrl();
    await eventually('both Leads revived', () => !!session('alpha') && !!session('beta'));
    // Each conversation has a little history (what the messenger reads).
    let serial = 0;
    const say = (s: Session, role: 'user' | 'assistant', text: string) => {
      const file = transcriptPath(s.cwd, s.sessionId, home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const uuid = `${(++serial).toString(16).padStart(8, '0')}-0d30-4000-8000-000000000000`;
      const message = role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] };
      fs.appendFileSync(file, `${JSON.stringify({ type: role, uuid, timestamp: new Date().toISOString(), message })}\n`);
      return file;
    };
    const alpha = session('alpha')!;
    say(alpha, 'user', '관리 세션 이름을 바꿔 줘');
    const alphaFile = say(alpha, 'assistant', 'alpha 의 지난 대화 한 줄');
    const beta = session('beta')!;
    say(beta, 'user', 'beta 에게 보낸 말');
    const betaTranscript = say(beta, 'assistant', 'beta 가 남긴 지난 대화');
    put('inbox/beta/1700000000000-x.md', 'pending for beta');

    // ── Rename (the owner's CLI) ──
    const r = cli('rename', '--project', 'alpha', 'tycoon-admin');
    check(r.ok === true && r.to === 'tycoon-admin', `agty rename --project alpha tycoon-admin: accepted (${JSON.stringify(r)})`);
    await eventually('tycoon-admin live', () => !!session('tycoon-admin'));
    // `claude --bg` resumes with flags into a copy holding the conversation (ADR-0013 §12); the fake
    // only makes the new id, so the copy's file is made here as Claude would.
    const renamed = session('tycoon-admin')!;
    if (renamed.sessionId !== alpha.sessionId)
      fs.copyFileSync(transcriptPath(alpha.cwd, alpha.sessionId, home), transcriptPath(renamed.cwd, renamed.sessionId, home));
    const resumed = engineCalls(home).map((c) => c.argv.join(' ')).filter((c) => c.startsWith('--bg -n tycoon-admin'));
    check(resumed.some((c) => c.includes(`--resume ${alpha.sessionId}`)), `restarted as -n tycoon-admin --resume ${alpha.sessionId.slice(0, 8)}`);
    await eventually('the registry says tycoon-admin', () => read('projects.json').projects.some((p: { name: string }) => p.name === 'tycoon-admin'));
    check(JSON.stringify(read('characters.json')['tycoon-admin']) === JSON.stringify({ palette: 3, hueShift: 90 }) && !read('characters.json').alpha, 'the look follows the new name');
    await eventually('the level follows', () => read('levels.json').levels['engine:tycoon-admin']?.xp >= 350 && !read('levels.json').levels['engine:alpha']);
    check(true, 'Lv/XP/환생 follow the new name (levels.json)');

    browser = await launchBrowser();
    const open = async (opts: Parameters<Browser['newContext']>[0]) => {
      const ctx = await browser!.newContext(opts);
      await ctx.addInitScript(() => {
        if (!localStorage.getItem('agty.status-tree')) localStorage.setItem('agty.status-tree', '{"rooms":true,"orchs":true}');
      });
      if (fs.existsSync(FONT)) await ctx.route('**/__pd/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
      return { ctx, page: await ctx.newPage() };
    };
    const hangul = (p: Page) => p.addStyleTag({ content: FONT_CSS });
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });

    const { ctx: desk, page } = await open({ viewport: { width: 1400, height: 900 } });
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await openOfficeWindow(page);
    await hangul(page);
    await page.locator('[data-testid="agent-overlay"] [data-testid="agent-name"]').getByText('tycoon-admin', { exact: true }).first().waitFor({ timeout: 20_000 });
    await shot(page, 'desktop-renamed-office');

    const messengerOf = (p: Page) => p.getByRole('region', { name: '메신저', exact: true });
    const contact = (p: Page, n: string) =>
      messengerOf(p).getByRole('list', { name: '연락처' }).getByRole('button', { name: new RegExp(`^${n.replace(/[()]/g, '\\$&')}( 안 읽음 \\d+)?$`) });
    await page.getByRole('button', { name: /^메신저/ }).click();
    await contact(page, 'tycoon-admin').click();
    const conv = messengerOf(page).getByRole('region', { name: 'tycoon-admin 대화' });
    await conv.getByText('alpha 의 지난 대화 한 줄').waitFor({ timeout: 20_000 });
    check(true, "the messenger lists tycoon-admin with alpha's history");
    await shot(page, 'desktop-renamed-messenger');
    // The messenger window sits over the 사무실 정보 drawer: minimized for the board's buttons.
    await page.locator('[data-hud-window="messenger"]').getByRole('button', { name: '최소화', exact: true }).click();

    // ── The remove dialog with its purge box (desktop) ──
    const betaCard = await engineRow(page, 'beta'); // the engine buttons are in the inspector now
    await (await engineButton(page, 'beta', '삭제')).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    const box = dialog.getByRole('checkbox');
    check(!(await box.isChecked()) && (await dialog.textContent())?.includes('관련 데이터(환생 이력 등)도 지우기'), 'the purge box, off by default');
    check(!(await dialog.textContent())?.includes('되돌릴 수 없어요'), 'no warning while it is off');
    await shot(page, 'desktop-remove-dialog');
    await box.check();
    await dialog.getByText('되돌릴 수 없어요.').waitFor();
    check(true, 'on: it says it cannot be undone');
    await shot(page, 'desktop-remove-dialog-purge');
    await dialog.getByRole('button', { name: '삭제', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '관련 데이터(환생 이력 등)도 지웠어요' }).waitFor({ timeout: 20_000 });
    check(true, 'removed with the purge (the toast says so)');
    check(!read('levels.json').levels['engine:beta'] && !Object.keys(read('levels.json').levels).some((k) => k.startsWith('engine:~')), "beta's Lv/XP/환생 deleted");
    check(!read('characters.json').beta, "beta's look deleted");
    check(!fs.existsSync(path.join(cfg, 'inbox/beta')), "beta's inbox deleted");
    check(fs.existsSync(betaTranscript), "beta's Claude conversation file kept");

    // The messenger keeps beta's history as "(알 수 없음)".
    await page.getByRole('button', { name: /^메신저/ }).click();
    await contact(page, '(알 수 없음)').click();
    await messengerOf(page).getByText('beta 가 남긴 지난 대화').first().waitFor({ timeout: 20_000 });
    check(true, 'the messenger shows the removed beta as (알 수 없음), its history readable');
    await shot(page, 'desktop-removed-unknown');
    check(
      (await messengerOf(page).getByTestId('no-send-note').innerText()).includes('삭제된 에이전트예요'),
      'its send box says it was removed (not the terminal note)',
    );

    // ── 대화방 지우기 (desktop) ──
    await messengerOf(page).getByRole('button', { name: '대화방 지우기', exact: true }).click();
    const ask = page.getByRole('alertdialog', { name: '이 대화방을 지울까요?' });
    await ask.waitFor();
    check((await ask.textContent())?.includes('되돌릴 수 없어요'), '대화방 지우기 asks first: it cannot be undone');
    await shot(page, 'desktop-delete-chat-confirm');
    await ask.getByRole('button', { name: '지우기', exact: true }).click();
    await eventually('beta\'s transcript deleted', () => !fs.existsSync(betaTranscript));
    await page.getByRole('status').filter({ hasText: '대화 파일 1개' }).waitFor({ timeout: 20_000 });
    check(true, 'the toast says how many conversation files were deleted (1)');
    await contact(page, '(알 수 없음)').waitFor({ state: 'detached', timeout: 20_000 });
    check(true, 'desktop: the conversation is off the contact list');
    const renamedFile = transcriptPath(renamed.cwd, renamed.sessionId, home);
    check(fs.existsSync(renamedFile), "the other agent's conversation file is kept");
    await shot(page, 'desktop-delete-chat-done');
    const phoneState = await desk.storageState();
    await desk.close();

    // ── The same dialog on a phone ──
    const { page: phone } = await open({ ...devices['iPhone 13'], storageState: phoneState });
    await phone.goto(`http://127.0.0.1:${port}/`);
    await hangul(phone);
    await phone.locator('[data-hud-id^="icon:"]').getByRole('button', { name: '현황판', exact: true }).click();
    await phone.getByLabel('현황판 화면').waitFor();
    await (await engineButton(phone, 'tycoon-admin', '삭제')).tap();
    const pdialog = phone.getByRole('alertdialog');
    await pdialog.waitFor();
    await pdialog.getByRole('checkbox').check();
    await pdialog.getByText('되돌릴 수 없어요.').waitFor();
    await shot(phone, 'phone-remove-dialog-purge');
    await pdialog.getByRole('checkbox').uncheck();
    await pdialog.getByRole('button', { name: '삭제', exact: true }).tap();
    await eventually('tycoon-admin removed', () => !read('projects.json').projects.some((p: { name: string }) => p.name === 'tycoon-admin'));
    check(fs.existsSync(renamedFile) && fs.existsSync(alphaFile), 'phone: removed without the box; its conversation files kept');

    // ── 대화방 지우기 (phone) ──
    await phone.getByRole('button', { name: /^메신저($| \()/ }).first().tap();
    const pm = messengerOf(phone);
    await contact(phone, '(알 수 없음)').tap();
    await pm.getByText('alpha 의 지난 대화 한 줄').first().waitFor({ timeout: 20_000 });
    await pm.getByRole('button', { name: '대화방 지우기', exact: true }).tap();
    const pask = phone.getByRole('alertdialog', { name: '이 대화방을 지울까요?' });
    await pask.waitFor();
    await shot(phone, 'phone-delete-chat-confirm');
    await pask.getByRole('button', { name: '지우기', exact: true }).tap();
    await eventually('its files deleted', () => !fs.existsSync(renamedFile) && !fs.existsSync(alphaFile));
    check(true, 'phone: 대화방 지우기 deleted the renamed copy and the conversation it continued');
    await contact(phone, '(알 수 없음)').waitFor({ state: 'detached', timeout: 20_000 });
    await shot(phone, 'phone-delete-chat-done');
    check(fs.existsSync(path.join(home, '.claude', 'sessions')), 'nothing else under ~/.claude was touched');
    console.log(`${oks} ok`);
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
