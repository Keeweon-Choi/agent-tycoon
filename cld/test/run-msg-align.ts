/**
 * MSG-ALIGN in the real messenger: dist/cli.js with --engine on --allow-chat in an isolated HOME
 * whose `claude` is the engine fake, headless Chromium (--disable-gpu), desktop and phone 393x852.
 * A DM with lead replies, task notices, a folded command line, a background command's end and the
 * boss's own words. Measured: on the lead's side every bubble body, name, 더보기, time and command
 * line starts on one left line; the boss's side mirrors it on the right, its copy/답글 left of the
 * time. A task notice of a run whose employee was reused for a newer run keeps its employee's name
 * and face, also after a reload.
 *
 *   npx tsx cld/test/run-msg-align.ts <port 18256-18259>
 *
 * Screenshots: cld/artifacts/msg-align/*.png
 */
import type { BrowserContextOptions, Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { STAFF_NAMES } from '../../core/src/cld/staffNames.js';
import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
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
const OUT = path.join(REPO_ROOT, 'cld/artifacts/msg-align');
const DEADLINE_MS = 280_000;
const PHONE = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 393, height: 852 } };
})();
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__msgalign/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(configDirectory(home), { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify(
      ['alpha', 'beta', 'gamma'].map((name) => {
        const dir = path.join(home, 'work', name);
        fs.mkdirSync(dir, { recursive: true });
        return { name, folder: dir, room: '개발실', wantRunning: true };
      }),
    ),
  );
  // One employee, two runs: the older run's notice must keep the name though only the newer run is listed.
  const now = Date.now();
  const employee = STAFF_NAMES[0];
  fs.writeFileSync(
    path.join(configDirectory(home), 'roster.json'),
    JSON.stringify({
      v: 1,
      projects: {
        alpha: {
          employees: [{ id: 'emp-1', nameId: employee.id, hiredAt: now - 9e6, lastReleasedAt: now - 60_000, execution: null }],
          executions: {
            'claude:toolu_old': { employee: 'emp-1', started: now - 7_200_000, ended: now - 7_100_000, endedBy: 'end', paid: [] },
            'claude:toolu_new': { employee: 'emp-1', started: now - 120_000, ended: now - 60_000, endedBy: 'end', paid: [] },
          },
        },
      },
    }),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    { FAKE_TURN_MS: '600' },
  );
  const { child: server } = daemon;
  console.log(`port ${port}, daemon pid ${server.pid}`);
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server.exitCode === null) server.kill('SIGKILL');
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort('deadline'), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  // ── Claude, played: records go into the session's transcript; each returns its chat item id ──
  type Sess = { sessionId: string; cwd: string; name: string; jobId: string };
  const sessionOf = (name = 'alpha'): Sess | null => {
    for (const f of fs.existsSync(sessions) ? fs.readdirSync(sessions) : []) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8')) as Sess;
        if (s.name === name) return s;
      } catch {
        /* being written */
      }
    }
    return null;
  };
  let uuid = 0;
  // Seeded history an hour back, a second apart; what follows the seeding is written now.
  let clock = Date.now() - 3_600_000;
  let seeding = true;
  const say = (role: 'user' | 'assistant', text: string, who = 'alpha'): string => {
    const s = sessionOf(who)!;
    const file = transcriptPath(s.cwd, s.sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const id = `${(++uuid).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    clock = seeding ? clock + 1000 : Math.max(clock + 1, Date.now());
    const timestamp = new Date(clock).toISOString();
    fs.appendFileSync(
      file,
      `${JSON.stringify(
        role === 'user'
          ? { type: 'user', uuid: id, timestamp, message: { role, content: text } }
          : {
              type: 'assistant',
              uuid: id,
              timestamp,
              message: { role, content: [{ type: 'text', text }] },
            },
      )}\n`,
    );
    return `${clock}-${id.slice(0, 8)}-0`;
  };
  const browser = await launchBrowser();
  /** tsx names the arrow functions it passes to evaluate: give the page the helper it calls. */
  const nameShim = 'globalThis.__name = (fn) => fn;';
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const row = (conv: Locator, id: string) => conv.locator(`[data-chat-id="${id}"]`);
  try {
    for (const end = Date.now() + 40_000; !['alpha', 'beta', 'gamma'].every((n) => sessionOf(n));) {
      if (Date.now() > end) throw new Error('the engine did not revive alpha, beta and gamma');
      await new Promise((r) => setTimeout(r, 300));
    }
    const LONG = '긴 글 확인용 문장입니다. '.repeat(100);
    const lead = sessionOf('alpha')!;
    say('user', '[사장 · 메신저 · 10-24 12:00] ⟨m:bbbb3333⟩\n먼저 보내는 짧은 말');
    say('user', '[사장 · 메신저 · 10-24 12:00] ⟨m:bbbb3334⟩\n' + LONG);
    say('assistant', '짧은 답');
    say('assistant', LONG);
    say('assistant', '- 목록 하나\n- 목록 둘\n\n`코드` 도 있어요');
    fs.appendFileSync(
      transcriptPath(lead.cwd, lead.sessionId, home),
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'ffffffff-0000-4000-8000-000000000001',
        timestamp: new Date(clock + 1).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_bt', name: 'Task', input: { description: '로그 정리', prompt: 'x' } }],
        },
      })}\n`,
    );
    const notice = (tool: string, summary: string, result: string) =>
      say(
        'user',
        `<task-notification>\n<task-id>${tool}</task-id>\n${tool ? `<tool-use-id>${tool}</tool-use-id>\n` : ''}<status>completed</status>\n<summary>${summary}</summary>\n<result>${result}</result>\n</task-notification>`,
      );
    // The run whose employee was reused for a newer run, the newer run, a run the roster never saw.
    const oldRun = notice('toolu_old', 'Agent "Old run" finished', '오류 0건');
    notice('toolu_new', 'Agent "New run" finished', LONG);
    notice('toolu_none', 'Agent "Unknown run" finished', '이름 없는 알림');
    // A background command's end: the lead's folded command line.
    say(
      'user',
      '<task-notification>\n<task-id>sh1</task-id>\n<status>completed</status>\n<summary>Background command "wait for the gate" completed (exit code 0)</summary>\n</task-notification>',
    );
    const last = say('user', '[사장 · 메신저 · 10-24 12:01] ⟨m:cccc4444⟩\n고마워요');
    say('user', '[사장 · 메신저 · 10-24 12:01] ⟨m:cccc4445⟩\n한 줄 더');
    seeding = false;
    await new Promise((r) => setTimeout(r, 3_000));
    const url = await daemon.loginUrl();

    const openDm = async (page: Page, touch: boolean) => {
      const tap = (l: Locator) => (touch ? l.tap() : l.click());
      await tap(page.getByRole('button', { name: /^메신저/ }));
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      await tap(messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }));
      const conv = messenger.getByRole('region', { name: 'alpha 대화' });
      await row(conv, last).waitFor();
      await conv.getByTestId('chat-scroll').evaluate((s) => (s.scrollTop = s.scrollHeight));
      return conv;
    };
    /** Left/right edges (px) of what the conversation lines up, measured in the page. */
    const measure = (conv: Locator) =>
      conv.evaluate((el) => {
        const list = el.querySelector('[data-testid="chat-scroll"]') as HTMLElement;
        const lb = list.getBoundingClientRect();
        const lefts: Record<string, number[]> = { body: [], name: [], more: [], time: [], line: [] };
        const rights: Record<string, number[]> = { body: [], name: [], more: [], time: [] };
        let actionsLeftOfTime = true;
        let actionsRightOfTime = true;
        let tails = 0;
        for (const row of el.querySelectorAll<HTMLElement>('[data-chat-id]')) {
          const line = row.querySelector<HTMLElement>(':scope > details');
          if (line) {
            lefts.line.push(line.getBoundingClientRect().left);
            continue;
          }
          const box = row.querySelector<HTMLElement>('.bubble-box');
          if (!box) continue;
          const boss = !!row.querySelector('[data-testid="owner-face"]') || row.querySelector('[data-from="boss"]') !== null;
          const into = boss ? rights : lefts;
          const edge = (n: HTMLElement) => (boss ? n.getBoundingClientRect().right : n.getBoundingClientRect().left);
          tails += row.querySelector('[data-testid="bubble-tail"]') ? 1 : 0;
          into.body.push(edge(box.firstElementChild as HTMLElement));
          for (const n of row.querySelectorAll<HTMLElement>('[data-testid="from-name"]')) into.name.push(edge(n));
          for (const b of row.querySelectorAll<HTMLElement>('button.text-accent-text.mt-2')) into.more.push(edge(b));
          const time = row.querySelector<HTMLElement>('time');
          if (time) {
            const timeRow = time.parentElement!;
            into.time.push(edge(timeRow));
            const act = timeRow.querySelector<HTMLElement>('[data-testid="message-actions"]');
            const ar = act?.getBoundingClientRect();
            if (ar && ar.width > 0) {
              const tr = time.getBoundingClientRect();
              if (boss) actionsLeftOfTime &&= ar.right <= tr.left + 0.5;
              else actionsRightOfTime &&= ar.left >= tr.right - 0.5;
            }
          }
        }
        const guideL = lefts.body[0] - lb.left;
        const guideR = lb.left + list.clientLeft + list.clientWidth - rights.body[0];
        return { lefts, rights, guideL, guideR, actionsLeftOfTime, actionsRightOfTime, tails };
      });
    const spread = (xs: number[]) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);
    const verify = async (page: Page, conv: Locator, tag: string, actions: boolean) => {
      const m = await measure(conv);
      console.log(`  ${tag}: ${JSON.stringify(m)}`);
      const all = (o: Record<string, number[]>) => Object.values(o).flat();
      for (const k of ['body', 'name', 'more', 'time', 'line'])
        check(m.lefts[k].length > 0, `${tag}: measured lead-side ${k} (${m.lefts[k].length})`);
      for (const k of ['body', 'time', 'more'])
        check(m.rights[k].length > 0, `${tag}: measured boss-side ${k} (${m.rights[k].length})`);
      check(spread(all(m.lefts)) <= 1, `${tag}: lead side: bubble bodies, names, 더보기, times and command lines start on one line (spread ${spread(all(m.lefts)).toFixed(2)} px)`);
      check(spread(all(m.rights)) <= 1, `${tag}: boss side: bubble bodies, names, 더보기 and times end on one line (spread ${spread(all(m.rights)).toFixed(2)} px)`);
      check(Math.abs(m.guideL - m.guideR) <= 1, `${tag}: the two guide lines mirror each other (left ${m.guideL.toFixed(1)} px, right ${m.guideR.toFixed(1)} px)`);
      if (actions) check(m.actionsLeftOfTime && m.actionsRightOfTime, `${tag}: boss copy/답글 left of the time, lead's right of it`);
      check(m.tails >= 3, `${tag}: tails still drawn (${m.tails})`);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${tag}: no horizontal page scroll`);
      const list = await conv.getByTestId('chat-scroll').evaluate((l) => l.scrollWidth > l.clientWidth);
      check(!list, `${tag}: no horizontal list scroll`);
    };
    const faceGap = async (conv: Locator, tag: string) => {
      const ok = await conv.evaluate((el) =>
        [...el.querySelectorAll<HTMLElement>('[data-testid="bubble-tail"]')].every((t) => {
          const face = t
            .closest('[data-chat-id]')!
            .querySelector<HTMLElement>('[data-testid="sender-face"], [data-testid="owner-face"]')!
            .getBoundingClientRect();
          const x = t.getBoundingClientRect();
          return t.className.includes('bubble-tail-r') ? x.right <= face.left + 0.5 : x.left >= face.right - 0.5;
        }),
      );
      check(ok, `${tag}: no tail overlaps a face`);
    };
    /** The old run's notice names the employee the roster kept for it (not the plain label). */
    const notices = async (conv: Locator, tag: string) => {
      const named = async (id: string) =>
        row(conv, id).evaluate((r) => ({
          face: r.querySelector('[data-testid="sender-face"]')?.getAttribute('data-sender') ?? '',
          name: r.querySelector('[data-testid="from-name"]')?.textContent ?? '',
        }));
      const old = await named(oldRun);
      console.log(`  ${tag}: old run's notice ${JSON.stringify(old)}`);
      check(old.face === employee.ko, `${tag}: a reused employee's old notice keeps its face and name (${old.face})`);
      check(old.name.startsWith(`${employee.ko} \u00b7 `), `${tag}: and its name line (${old.name})`);
    };
    const hoverBoss = async (conv: Locator, page: Page, name: string) => {
      const r = conv.locator('[data-from="boss"]').last();
      await r.scrollIntoViewIfNeeded();
      await r.hover();
      await new Promise((res) => setTimeout(res, 200));
      await shot(page, name);
    };

    {
      const deskCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await deskCtx.addInitScript(nameShim);
      if (fs.existsSync(FONT))
        await deskCtx.route('**/__msgalign/malgun.ttf', (route) =>
          route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }),
        );
      const page = await deskCtx.newPage();
      page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
      await page.goto(url);
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      await page.addStyleTag({ content: FONT_CSS });
      const infoClose = page.getByRole('button', { name: '정보 창 닫기' });
      if (await infoClose.count()) await infoClose.click();
      const conv = await openDm(page, false);
      await conv.locator('button.text-accent-text.mt-2').first().waitFor();
      await verify(page, conv, 'desktop', true);
      await faceGap(conv, 'desktop');
      await notices(conv, 'desktop');
      await shot(page, 'desktop-dm');
      await hoverBoss(conv, page, 'desktop-dm-boss-actions');
      await conv.getByTestId('chat-scroll').evaluate((s) => (s.scrollTop = 0));
      await shot(page, 'desktop-dm-top');
      // A reload: the employee's old notice still has its name (the roster, not this page's staff list).
      await page.reload();
      await page.addStyleTag({ content: FONT_CSS });
      const again = await openDm(page, false);
      await notices(again, 'desktop after reload');
      await row(again, oldRun).scrollIntoViewIfNeeded();
      await shot(page, 'desktop-dm-reloaded');

      const ctx2 = await browser.newContext({ ...PHONE, storageState: await deskCtx.storageState() });
      await ctx2.addInitScript(nameShim);
      if (fs.existsSync(FONT))
        await ctx2.route('**/__msgalign/malgun.ttf', (route) =>
          route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }),
        );
      const p2 = await ctx2.newPage();
      p2.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
      await p2.goto(`http://127.0.0.1:${port}/`);
      await p2.addStyleTag({ content: FONT_CSS });
      const conv2 = await openDm(p2, true);
      await conv2.locator('button.text-accent-text.mt-2').first().waitFor();
      await verify(p2, conv2, 'phone', false);
      await faceGap(conv2, 'phone');
      await notices(conv2, 'phone');
      await shot(p2, 'phone-dm');
      await conv2.getByTestId('chat-scroll').evaluate((s) => (s.scrollTop = 0));
      await shot(p2, 'phone-dm-top');
      await ctx2.close();
    }
    console.log('done');
  } finally {
    await browser.close().catch(() => undefined);
    if (server.exitCode === null) {
      const exited = new Promise((r) => server.once('exit', r));
      server.kill('SIGTERM');
      const force = setTimeout(() => server.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(force);
    }
    clearTimeout(deadline);
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
