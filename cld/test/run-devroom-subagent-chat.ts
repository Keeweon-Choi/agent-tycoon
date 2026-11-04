/**
 * DEVROOM-SUBCHAT (owner 11-04 22:09), a sub-agent's read-only view as a messenger, end to end:
 * dist/cli.js in a temp HOME on a spare port, a temp repository, the engine's fake claude (PTY host,
 * never a real claude) as Lead `shop-web`. The Lead's transcript gets two sub-agents whose records mix
 * words, tool calls, a failed tool, a written file and a commit. Desktop (Chromium --disable-gpu): the
 * words are bubbles, the calls fold into one summary line per run, the failure stays a line, the task
 * is a folded card, output chips show; 명령 모두 보기 turns it into the old list and back; a new saying
 * follows when the reader is at the bottom and does not when they read further up. Phone (390x844): the
 * same view. Screenshots in cld/artifacts/devroom-subagent-chat-view/.
 *
 *   nice -n 10 npx tsx cld/test/run-devroom-subagent-chat.ts <port 18480..18489>
 */
import type { Browser, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import { assertPortFree, killFakeSessions, launchBrowser, makeEngineHome, REPO_ROOT, startDaemon } from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 18480 && port <= 18489)) throw new Error('port: 18480..18489');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/devroom-subagent-chat-view');
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

type Rec = Record<string, unknown>;
let seq = 0;
const stamp = (r: Rec): Rec => ({ uuid: `u-${++seq}-${Math.random().toString(16).slice(2, 10)}`, timestamp: new Date().toISOString(), ...r });
const call = (id: string, name: string, input: Rec) => ({ type: 'tool_use', id, name, input });
const said = (content: Rec[]): Rec => stamp({ type: 'assistant', message: { model: 'claude-opus-4-5', content } });
const text = (s: string) => ({ type: 'text', text: s });
const result = (id: string, content: string, is_error = false): Rec =>
  stamp({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(is_error && { is_error: true }) }] } });
const sub = (parent: string, msg: Rec): Rec => stamp({ type: 'progress', parentToolUseID: parent, data: { type: 'agent_progress', message: msg } });

const SUBS = [
  { id: 'tu-s1', desc: '장바구니 합계 고치기', prompt: 'src/shop 의 테스트를 돌리고, 실패하면 원인을 찾아 고친 뒤 커밋해 주세요.\n끝나면 무엇을 고쳤는지 알려 주세요.' },
  { id: 'tu-s2', desc: '타입 검사', prompt: 'tsc --noEmit 으로 타입 오류를 모아 주세요.' },
];
const S1 = 'tu-s1';
const LONG = [
  '원인을 찾았어요. 정리하면 이렇습니다.',
  '',
  '- `sumPrice` 가 합계에 `1.0001` 을 곱해요.',
  '- 그래서 원 단위 반올림 테스트가 `10001` 이 되어 깨져요.',
  '- 곱셈을 빼면 18개 모두 통과해야 해요.',
  '',
  '```ts',
  'export const sumPrice = (xs: number[]) => xs.reduce((a, b) => a + b, 0);',
  '```',
  '',
  '고친 뒤 테스트를 다시 돌려 볼게요.',
].join('\n');

/** The first sub-agent's whole run, as its sidechain records in the Lead's transcript. */
function firstRun(): Rec[] {
  return [
    said([text('작업을 둘로 나눠 서브 에이전트에게 맡길게요.'), ...SUBS.map((x) => call(x.id, 'Agent', { description: x.desc, prompt: x.prompt, subagent_type: 'general-purpose' }))]),
    sub(S1, said([text('먼저 테스트부터 돌려 볼게요.'), call('s1-1', 'Bash', { command: 'cd /home/owner/projects/shop-web && npm test -- --run src/shop', description: '장바구니 테스트' })])),
    sub(S1, result('s1-1', [' ✓ src/shop/Cart.test.ts (11 tests)', ' ✗ src/shop/Total.test.ts > sumPrice rounds to won', '   → expected 10001 to be 10000', ' Tests  1 failed | 17 passed (18)'].join('\n'), true)),
    sub(S1, said([call('s1-2', 'Read', { file_path: '/home/owner/projects/shop-web/src/shop/Total.ts' }), call('s1-3', 'Grep', { pattern: 'sumPrice\\(', path: 'src' })])),
    sub(S1, result('s1-2', 'export const sumPrice = (xs: number[]) =>\n  xs.reduce((a, b) => a + b, 0) * 1.0001;\n')),
    sub(S1, result('s1-3', 'src/shop/Cart.ts:14:  const total = sumPrice(items.map((i) => i.price));')),
    sub(S1, said([text(LONG)])),
    sub(S1, said([call('s1-4', 'Edit', { file_path: '/home/owner/projects/shop-web/src/shop/Total.ts', old_string: ' * 1.0001', new_string: '' })])),
    sub(S1, result('s1-4', 'The file src/shop/Total.ts has been updated.')),
    sub(S1, said([call('s1-5', 'Bash', { command: 'npm test -- --run src/shop', description: '테스트 다시' })])),
    sub(S1, result('s1-5', ' Tests  18 passed (18)')),
    sub(S1, said([call('s1-6', 'Write', { file_path: '/home/owner/projects/shop-web/notes/sum-price-fix.md', content: '# sumPrice\n' }), call('s1-7', 'Bash', { command: 'git commit -am "fix: drop the 1.0001 factor in sumPrice"', description: '커밋' })])),
    sub(S1, result('s1-6', 'File created successfully')),
    sub(S1, result('s1-7', '[feat/sum-price 3fa9c1e] fix: drop the 1.0001 factor in sumPrice\n 1 file changed, 1 insertion(+), 1 deletion(-)')),
    sub('tu-s2', said([call('s2-1', 'Bash', { command: 'npx tsc --noEmit -p tsconfig.json', description: '타입 검사' })])),
    sub(S1, said([text('`sumPrice` 의 곱셈을 빼서 **18개 테스트가 모두 통과**해요. 커밋도 해 두었어요.')])),
  ];
}

async function main() {
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const repo = makeTempRepo();
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify({ v: 2, projects: [{ projectId: 'p_aaaaaaaaaa', name: 'shop-web', folder: repo.folder, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' }] }),
  );
  fs.writeFileSync(
    path.join(cfg, 'assignments.json'),
    JSON.stringify({ v: 1, assignments: [{ assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude-pty', wantRunning: true }] }),
  );
  const PATH = [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    { PATH, FAKE_TURN_MS: '240000', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C.UTF-8' },
    true,
  );
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL');
  }, DEADLINE_MS);
  try {
    const sessionOf = (name: string) => {
      for (const file of fs.readdirSync(path.join(home, '.claude/sessions'))) {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(home, '.claude/sessions', file), 'utf8')) as { name: string; sessionId: string; cwd: string };
          if (s.name === name) return s;
        } catch {
          /* written as we read */
        }
      }
      return undefined;
    };
    const transcriptOf = (name: string) => {
      const s = sessionOf(name);
      return s && path.join(home, '.claude/projects', s.cwd.replace(/[^a-zA-Z0-9-]/g, '-'), `${s.sessionId}.jsonl`);
    };
    await daemon.loginUrl();
    await eventually('the Lead revived', () => !!sessionOf('shop-web'), 60_000);
    await eventually("the Lead's transcript", () => { const f = transcriptOf('shop-web'); return !!f && fs.existsSync(f); });
    const lead = transcriptOf('shop-web')!;

    browser = await launchBrowser();
    const seen = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version.split('.').slice(0, 2).join('.');
    const newPage = async (opts: Parameters<Browser['newContext']>[0]) => {
      const ctx = await browser!.newContext(opts);
      await ctx.addInitScript((v) => localStorage.setItem('cld.changelogSeen', v), seen);
      const p = await ctx.newPage();
      await p.goto(await daemon.loginUrl());
      await p.waitForURL(`http://127.0.0.1:${port}/`);
      const toast = await p.getByText(/으로 업데이트됐어요/).first().textContent({ timeout: 5_000 }).catch(() => null);
      const v = toast?.match(/v([\d.]+)/)?.[1];
      if (v) {
        await p.evaluate((x) => localStorage.setItem('cld.changelogSeen', x), v);
        await p.reload();
      }
      return p;
    };
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });

    // The view under test, in whichever page: `root` holds the sub-agent view.
    const checkChat = async (p: Page, tag: string) => {
      const view = p.getByTestId('devroom-sub-view');
      await view.getByTestId('devroom-sub-steps').first().waitFor({ timeout: 20_000 });
      await p.waitForTimeout(800);
      check((await view.getAttribute('data-mode')) === 'chat', `${tag}: the default is the chat view`);
      const body = await view.innerText();
      check(body.includes('18개 테스트가 모두 통과'), `${tag}: the sub-agent's words show as bubbles (Markdown: bold is not **)`);
      check(!body.includes('**18개'), `${tag}: and Markdown is drawn, not shown raw`);
      check(!body.includes('Read(') && !body.includes('Grep('), `${tag}: the successful calls are not listed in the way`);
      const summaries = await view.getByTestId('devroom-sub-steps').allInnerTexts();
      check(summaries.length === 2, `${tag}: the calls fold into one line per run (${summaries.length}: ${summaries.map((s) => s.split('\n')[0]).join(' | ')})`);
      check(summaries.some((s) => /명령 1 · 파일 읽기 2/.test(s)) && summaries.some((s) => /명령 2 · 고침 2/.test(s)), `${tag}: a run says its kinds and counts`);
      check((await view.getByTestId('devroom-sub-failed').count()) === 1, `${tag}: the failed command stays a line, folded or not`);
      check((await view.getByTestId('devroom-sub-task').count()) === 1 && !(await view.getByTestId('devroom-sub-task').innerText()).includes('끝나면'), `${tag}: the lead's task is a folded card`);
      const chips = await view.getByTestId('devroom-sub-outputs').innerText();
      check(chips.includes('sum-price-fix.md') && chips.includes('3fa9c1e'), `${tag}: output chips name the file and the commit`);
      check((await view.getByTestId('devroom-sub-readonly').count()) === 1, `${tag}: one line says it is read-only`);
      check((await view.locator('textarea, input').count()) === 0, `${tag}: no input, no terminal`);
    };

    // ── Desktop ──
    const desk = await newPage({ viewport: { width: 1920, height: 1080 } });
    await desk.locator('[data-hud-id="icon:devroom"] button').click();
    const win = desk.locator('[data-hud-window="devroom"]');
    await win.waitFor({ timeout: 20_000 });
    await win.getByTestId('hud-title-devroom').dblclick();
    await win.getByTestId('devroom-trunk').first().click();
    const leadPane = win.locator('[data-testid="devroom-pane"][data-agent="shop-web"]');
    await leadPane.waitFor({ timeout: 20_000 });
    await desk.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('[data-testid="devroom-pane"][data-agent="shop-web"] .xterm-rows')].some((el) => el.innerText.includes('fake Claude Code (pty)')), undefined, { timeout: 30_000 });
    for (const r of firstRun()) fs.appendFileSync(lead, `${JSON.stringify(r)}\n`);
    await desk.waitForFunction(() => document.querySelector('[data-testid="devroom-pane"][data-agent="shop-web"] [data-testid="devroom-sub-chip"]')?.textContent?.includes('2'), undefined, { timeout: 30_000 });
    check(true, "the Lead's pane wears the sub chip");
    await leadPane.getByTestId('devroom-sub-chip').click();
    await leadPane.getByTestId('devroom-sub-list').waitFor();
    await leadPane.getByTestId('devroom-sub-row').filter({ hasText: SUBS[0].desc }).click();
    await checkChat(desk, 'desktop');
    await shot(desk, 'pc-chat');

    // A folded run opens to the old lines, and the whole view can go back to the old list.
    const view = desk.getByTestId('devroom-sub-view');
    await view.getByTestId('devroom-sub-steps').first().getByRole('button').click();
    await desk.waitForTimeout(300);
    check((await view.getByTestId('devroom-sub-tool').count()) >= 3, 'a run opens to its commands and results');
    await shot(desk, 'pc-chat-run-open');
    await view.getByTestId('devroom-sub-raw').click();
    await desk.waitForTimeout(400);
    check((await view.getAttribute('data-mode')) === 'raw' && (await view.getByTestId('devroom-sub-tool').count()) === 7, '명령 모두 보기: every one of the seven calls is listed again');
    check((await view.getByTestId('devroom-sub-result').first().getAttribute('data-failed')) === 'true', 'and the failed result is marked');
    await shot(desk, 'pc-all-commands');
    await view.getByTestId('devroom-sub-raw').click();
    check((await view.getAttribute('data-mode')) === 'chat', 'pressed again, it is the chat view');

    // Following: at the bottom a new saying is followed; scrolled up it is not.
    const bodyEl = view.getByTestId('devroom-sub-body');
    const geo = () => bodyEl.evaluate((el) => ({ top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight, over: el.scrollHeight > el.clientHeight }));
    await desk.waitForTimeout(300);
    for (let i = 1; i <= 8; i++) fs.appendFileSync(lead, `${JSON.stringify(sub(S1, said([text(`확인 ${i}: 이전 줄을 다시 읽어 봤어요. 특이한 점이 없어요.`)])))}\n`);
    await view.getByText('확인 8', { exact: false }).first().waitFor({ timeout: 20_000 });
    await desk.waitForTimeout(1500);
    const g0 = await geo();
    check(g0.gap < 40, `at the bottom after the load (gap ${g0.gap}, scrollable ${g0.over})`);
    fs.appendFileSync(lead, `${JSON.stringify(sub(S1, said([text('하나 더: 다른 곳에서 `sumPrice` 를 쓰는지도 확인했어요. 문제 없어요.')])))}\n`);
    await view.getByText('다른 곳에서', { exact: false }).first().waitFor({ timeout: 20_000 });
    await desk.waitForTimeout(1500);
    check((await geo()).gap < 40, 'a new saying at the bottom is followed');
    await shot(desk, 'pc-chat-followed');
    if (g0.over) {
      await bodyEl.evaluate((el) => { el.scrollTop = 0; });
      await desk.waitForTimeout(200);
      fs.appendFileSync(lead, `${JSON.stringify(sub(S1, said([text('마지막 확인까지 끝났어요.')])))}\n`);
      await view.getByText('마지막 확인까지', { exact: false }).first().waitFor({ state: 'attached', timeout: 20_000 });
      await desk.waitForTimeout(1500);
      check((await geo()).top < 5, 'read further up, a new saying does not pull the view down');
    } else check(false, 'the view should be taller than the pane for the follow check');

    // ── Phone ── (a page opened now only lists a sub-agent with a call running: one more, still waiting)
    fs.appendFileSync(lead, `${JSON.stringify(sub(S1, said([call('s1-8', 'Bash', { command: 'npm run build', description: '빌드' })])))}\n`);
    const phone = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await phone.locator('[data-dock="devroom"]').tap();
    await phone.getByTestId('devroom-trunk').first().tap();
    await phone.getByTestId('devroom-phone-term').waitFor({ timeout: 20_000 });
    await phone.getByTestId('devroom-phone-all').tap();
    await phone.locator('[data-testid="devroom-agent-card"][data-agent="shop-web"]').getByTestId('devroom-sub-chip').tap();
    await phone.getByTestId('devroom-sub-list').waitFor();
    await phone.getByTestId('devroom-sub-row').filter({ hasText: SUBS[0].desc }).tap();
    await phone.getByTestId('devroom-sub-view').getByTestId('devroom-sub-steps').first().waitFor({ timeout: 20_000 });
    await phone.waitForTimeout(800);
    check((await phone.getByTestId('devroom-sub-view').getAttribute('data-mode')) === 'chat', 'phone: the default is the chat view');
    check((await phone.getByTestId('devroom-sub-view').getByTestId('devroom-sub-steps').count()) === 3, 'phone: the same folded runs (a third for the call still running)');
    check((await phone.getByTestId('devroom-sub-view').getByTestId('devroom-sub-outputs').count()) === 1, 'phone: and the same chips');
    await shot(phone, 'phone-chat');
    await phone.getByTestId('devroom-sub-raw').tap();
    await phone.waitForTimeout(400);
    check((await phone.getByTestId('devroom-sub-view').getByTestId('devroom-sub-tool').count()) === 8, 'phone: 명령 모두 보기 lists the calls');
    await shot(phone, 'phone-all-commands');
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `phone: no sideways scroll (${overflow})`);

    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    console.error(err);
    fs.writeFileSync(path.join(os.tmpdir(), 'run-devroom-subagent-chat.daemon.log'), daemon.log.join(''));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    repo.cleanup();
    try {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (e) {
      console.error('cleanup:', (e as Error).message);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
