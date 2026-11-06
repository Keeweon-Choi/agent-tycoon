/**
 * DEVROOM-SUBVIEW (owner 11-03 10:43, 10:51), the 개발실's 터미널 tab as a board of agents, end to
 * end: dist/cli.js in a temp HOME on a spare port, a temp repository, the engine's fake claude
 * (PTY host, never a real claude) as Lead `shop-web` and two Workers. The Lead's transcript gets
 * five sub-agents with realistic steps (tests, a type check, a code search, a README edit, a web
 * look-up), one of which finishes. Desktop (Chromium --disable-gpu, 1920x1080): the status strip
 * groups the cards, 2×2 shows four panes, the Lead pane's `서브 5` chip lists the sub-agents, one
 * opens as a readable transcript (tool calls with their arguments, folded results), `← 터미널`
 * returns to the Lead's terminal; cards dragged onto pane edges make a free layout (the Lead left,
 * two Workers stacked right), a divider resizes it, a reload restores it. Phone (390x844): the cards in groups, one agent full screen, its
 * sub-agent list and one transcript. Screenshots in cld/artifacts/devroom-subview/.
 *
 *   nice -n 10 npx tsx cld/test/run-devroom-subview.ts <port 18270|18271>
 */
import type { Browser, Page } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import { assertPortFree, killFakeSessions, launchBrowser, makeEngineHome, REPO_ROOT, startDaemon } from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (port !== 18270 && port !== 18271) throw new Error('port: 18270 or 18271');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/devroom-subview');
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
const result = (id: string, content: string): Rec => stamp({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const sub = (parent: string, msg: Rec): Rec => stamp({ type: 'progress', parentToolUseID: parent, data: { type: 'agent_progress', message: msg } });

const SUBS = [
  { id: 'tu-s1', desc: '장바구니 테스트 실행', prompt: 'src/shop 의 테스트를 돌리고 실패한 것을 원인과 함께 알려 주세요.' },
  { id: 'tu-s2', desc: '타입 검사', prompt: 'tsc --noEmit 으로 타입 오류를 모아 주세요.' },
  { id: 'tu-s3', desc: 'sumPrice 호출 위치 찾기', prompt: 'sumPrice 를 부르는 곳을 모두 찾아 주세요.' },
  { id: 'tu-s4', desc: 'README 설치 절차 정리', prompt: 'README 의 설치 절차를 지금 스크립트에 맞게 고쳐 주세요.' },
  { id: 'tu-s5', desc: '결제 API 문서 조사', prompt: '결제 API 의 환불 엔드포인트 규칙을 조사해 주세요.' },
];

/** What each sub-agent did, as its sidechain records in the Lead's transcript. */
function subRecords(): Rec[] {
  const s = (i: number) => SUBS[i].id;
  return [
    said([text('작업을 다섯 갈래로 나눠 서브 에이전트에게 맡길게요.'), ...SUBS.map((x) => call(x.id, 'Agent', { description: x.desc, prompt: x.prompt, subagent_type: 'general-purpose' }))]),
    sub(s(0), said([text('테스트부터 돌려 볼게요.'), call('s1-1', 'Bash', { command: 'cd /home/owner/projects/shop-web && npm test -- --run src/shop', description: '장바구니 테스트' })])),
    sub(s(0), result('s1-1', [' RUN  v3.2.4 /home/owner/projects/shop-web', '', ' ✓ src/shop/Cart.test.ts (11 tests) 41ms', ' ✓ src/shop/Coupon.test.ts (6 tests) 12ms', ' ✗ src/shop/Total.test.ts > sumPrice rounds to won', '   → expected 10001 to be 10000', '', ' Test Files  1 failed | 2 passed (3)', '      Tests  1 failed | 17 passed (18)'].join('\n'))),
    sub(s(0), said([call('s1-2', 'Read', { file_path: '/home/owner/projects/shop-web/src/shop/Total.ts' })])),
    sub(s(0), result('s1-2', 'export const sumPrice = (xs: number[]) =>\n  xs.reduce((a, b) => a + b, 0) * 1.0001;\n')),
    sub(s(0), said([text('`sumPrice` 가 1.0001 을 곱해서 원 단위 반올림 테스트가 깨져요. 곱셈을 빼면 18개 모두 통과할 거예요.')])),
    sub(s(1), said([call('s2-1', 'Bash', { command: 'npx tsc --noEmit -p tsconfig.json', description: '타입 검사' })])),
    sub(s(1), result('s2-1', "src/api/rate.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/ui/Pay.tsx(40,15): error TS2339: Property 'total' does not exist on type 'Cart'.")),
    sub(s(1), said([call('s2-2', 'Read', { file_path: '/home/owner/projects/shop-web/src/api/rate.ts', offset: 1, limit: 30 })])),
    sub(s(2), said([call('s3-1', 'Grep', { pattern: 'sumPrice\\(', path: 'src', output_mode: 'content' })])),
    sub(s(2), result('s3-1', 'src/shop/Cart.ts:14:  const total = sumPrice(items.map((i) => i.price));\nsrc/ui/Pay.tsx:22:    {sumPrice(prices)}\nsrc/api/order.ts:51:  amount: sumPrice(lines),')),
    sub(s(2), said([call('s3-2', 'Glob', { pattern: 'src/**/*.test.ts' })])),
    sub(s(3), said([call('s4-1', 'Read', { file_path: '/home/owner/projects/shop-web/README.md' })])),
    sub(s(3), result('s4-1', '# shop-web\n\n## 설치\n\nnpm install\nnpm run dev')),
    sub(s(3), said([call('s4-2', 'Edit', { file_path: '/home/owner/projects/shop-web/README.md', old_string: 'npm install', new_string: 'npm ci' })])),
    sub(s(3), result('s4-2', 'The file README.md has been updated.')),
    sub(s(3), said([text('설치 절차를 `npm ci` 와 `npm run dev` 두 줄로 고쳤어요.')])),
    sub(s(4), said([call('s5-1', 'WebFetch', { url: 'https://docs.example.com/payments/refunds', prompt: '환불 규칙' })])),
    sub(s(4), result('s5-1', '환불은 결제 후 30일 안에 한 번, 부분 환불은 원래 금액까지 여러 번 가능합니다. 멱등 키(Idempotency-Key)를 꼭 보내야 합니다.')),
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
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args], { env: { PATH, HOME: home, CLD_OUTPUT: 'json' }, encoding: 'utf8', timeout: 60_000 });
    const json = (r: ReturnType<typeof cli>) => JSON.parse(r.stdout || '{}') as Record<string, any>;
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
    for (const [i, w] of ['web-worker', 'api-worker'].entries()) {
      check(json(cli('worker', 'add', 'shop-web', w)).ok === true, `Worker ${w} added`);
      const id = json(cli('task', 'add', `작업 ${i + 1}`, '--project', 'shop-web', '--assignee', w, '--status', 'doing')).task?.id as string;
      check(json(cli('worktree', 'new', '--task', id, '--assign', w)).ok === true, `${id} gets a worktree for ${w}`);
      check(json(cli('worker', 'start', w)).ok === true, `${w} started`);
      await eventually(`${w} live`, () => !!sessionOf(w), 60_000);
    }
    cli('send', 'web-worker', '장바구니 합계 계산을 sumPrice 로 분리해 주세요');

    browser = await launchBrowser();
    const seen = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version.split('.').slice(0, 2).join('.');
    const newPage = async (opts: Parameters<Browser['newContext']>[0]) => {
      const ctx = await browser!.newContext(opts);
      await ctx.addInitScript((v) => localStorage.setItem('cld.changelogSeen', v), seen);
      const p = await ctx.newPage();
      await p.goto(await daemon.loginUrl());
      await p.waitForURL(`http://127.0.0.1:${port}/`);
      // The "vX 으로 업데이트됐어요" toast names this build's version: mark that one seen too.
      const toast = await p.getByText(/으로 업데이트됐어요/).first().textContent({ timeout: 5_000 }).catch(() => null);
      const v = toast?.match(/v([\d.]+)/)?.[1];
      if (v) {
        await p.evaluate((x) => localStorage.setItem('cld.changelogSeen', x), v);
        await p.reload();
      }
      return p;
    };
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });

    // ── Desktop ──
    const desk = await newPage({ viewport: { width: 1920, height: 1080 } });
    await desk.locator('[data-hud-id="icon:devroom"] button').click();
    const win = desk.locator('[data-hud-window="devroom"]');
    await win.waitFor({ timeout: 20_000 });
    await win.getByTestId('hud-title-devroom').dblclick();
    await win.getByTestId('devroom-trunk').first().click();
    const leadPane = win.locator('[data-testid="devroom-pane"][data-agent="shop-web"]');
    await leadPane.waitFor({ timeout: 20_000 });
    check(true, "the trunk's pick shows the Lead in the pane");
    // DEVROOM-PANE-CHAT: panes open in 대화 and the cards sit behind the status chips.
    const terminals = () =>
      desk.evaluate(() =>
        document
          .querySelectorAll<HTMLElement>('[data-testid="devroom-pane"]:not([data-view="terminal"]) [data-testid="devroom-pane-view"][data-view="terminal"]')
          .forEach((b) => b.click()),
      );
    const strip = async (open = true) => {
      if ((await win.getByTestId('devroom-strip').count()) !== (open ? 1 : 0)) await win.getByTestId('devroom-status-chip').first().click();
    };
    await terminals();
    await desk.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('[data-testid="devroom-pane"][data-agent="shop-web"] .xterm-rows')].some((el) => el.innerText.includes('fake Claude Code (pty)')), undefined, { timeout: 30_000 });
    check(true, "the Lead's pane shows its live terminal");

    await eventually("the Lead's transcript", () => { const f = transcriptOf('shop-web'); return !!f && fs.existsSync(f); });
    const lead = transcriptOf('shop-web');
    check(lead, `the Lead's transcript (${lead})`);
    for (const r of subRecords()) fs.appendFileSync(lead!, `${JSON.stringify(r)}\n`);
    const chip = leadPane.getByTestId('devroom-sub-chip');
    await desk.waitForFunction(() => document.querySelector('[data-testid="devroom-pane"][data-agent="shop-web"] [data-testid="devroom-sub-chip"]')?.textContent?.includes('5'), undefined, { timeout: 30_000 });
    check(true, `the Lead's pane wears ${await chip.innerText()}`);
    await strip();
    const card = win.locator('[data-testid="devroom-agent-card"][data-agent="shop-web"]');
    check((await card.getByTestId('devroom-sub-chip').count()) === 1, "and so does the Lead's card");
    const groups = await win.getByTestId('devroom-agent-group').evaluateAll((els) => els.map((e) => e.getAttribute('data-bucket')));
    check(groups.length >= 1, `the strip groups the cards by status (${groups.join(', ')})`);
    await strip(false);
    // One sub-agent finishes: its spawn comes back.
    fs.appendFileSync(lead!, `${JSON.stringify(result('tu-s4', '설치 절차를 고쳤어요.'))}\n`);
    await desk.waitForTimeout(1500);
    await shot(desk, 'pc-board-1');

    await win.getByTestId('devroom-layout-4').click();
    await desk.waitForFunction(() => document.querySelectorAll('[data-testid="devroom-pane"]').length === 4, undefined, { timeout: 10_000 });
    const shownAgents = await win.getByTestId('devroom-pane').evaluateAll((els) => els.map((e) => e.getAttribute('data-agent')));
    check(shownAgents.filter(Boolean).length === 3, `2×2: the three agents fill three panes (${shownAgents.join(', ')})`);
    await terminals();
    await desk.waitForFunction(() => document.querySelectorAll('[data-testid="devroom-pane"] .xterm-rows').length === 3, undefined, { timeout: 30_000 });
    await desk.waitForTimeout(1500);
    await shot(desk, 'pc-board-2x2');

    await chip.click();
    const list = leadPane.getByTestId('devroom-sub-list');
    await list.waitFor();
    const rows = await list.getByTestId('devroom-sub-row').allInnerTexts();
    check(rows.length === 5, `the chip lists the five sub-agents (${rows.map((r) => r.split('\n')[0]).join(' | ')})`);
    await desk.waitForTimeout(300);
    await shot(desk, 'pc-sub-list');
    await list.getByTestId('devroom-sub-row').filter({ hasText: SUBS[0].desc }).click();
    const view = leadPane.getByTestId('devroom-sub-view');
    await view.getByTestId('devroom-sub-tool').first().waitFor({ timeout: 20_000 });
    const body = await view.innerText();
    check(body.includes('npm test -- --run src/shop'), 'the transcript shows the Bash call with its whole command');
    check(body.includes('Total.ts'), 'and the Read call with its path');
    check(body.includes('sumPrice'), "and the sub-agent's own text");
    check((await view.getByTestId('devroom-sub-result').count()) >= 2, 'and the results, folded');
    await view.getByText(/줄 더 보기/).first().click();
    await desk.waitForTimeout(400);
    await shot(desk, 'pc-sub-detail');
    await win.getByTestId('devroom-layout-1').click();
    await desk.waitForTimeout(600);
    await shot(desk, 'pc-sub-detail-1');
    await win.getByTestId('devroom-sub-back').click();
    await desk.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('[data-testid="devroom-pane"][data-agent="shop-web"] .xterm-rows')].some((el) => el.innerText.includes('fake Claude Code (pty)')), undefined, { timeout: 30_000 });
    check(true, '← 터미널 returns to the Lead terminal');
    await desk.waitForTimeout(600);
    await shot(desk, 'pc-lead-terminal');

    // ── Free layout (owner 11-03 10:54, Orca): one big pane left, two stacked right, a divider moved. ──
    await win.getByTestId('devroom-layout-1').click();
    await desk.waitForFunction(() => document.querySelectorAll('[data-testid="devroom-pane"]').length === 1, undefined, { timeout: 10_000 });
    const paneOf = (name: string) => win.locator(`[data-testid="devroom-pane"][data-agent="${name}"]`);
    const cardOf = (name: string) => win.locator(`[data-testid="devroom-agent-card"][data-agent="${name}"]`);
    const dragTo = async (from: string, to: string, fx: number, fy: number, previewShot?: string) => {
      const a = (await cardOf(from).boundingBox())!;
      const b = (await paneOf(to).boundingBox())!;
      await desk.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await desk.mouse.down();
      await desk.mouse.move(b.x + b.width * fx, b.y + b.height * fy, { steps: 8 });
      await desk.mouse.move(b.x + b.width * fx + 2, b.y + b.height * fy + 2, { steps: 2 });
      if (previewShot) {
        await win.getByTestId('devroom-drop-zone').waitFor({ timeout: 5_000 });
        await shot(desk, previewShot);
      }
      await desk.mouse.up();
    };
    await strip();
    await dragTo('web-worker', 'shop-web', 0.95, 0.5, 'pc-drop-preview');
    await paneOf('web-worker').waitFor({ timeout: 10_000 });
    await strip();
    await dragTo('api-worker', 'web-worker', 0.5, 0.95);
    await paneOf('api-worker').waitFor({ timeout: 10_000 });
    await terminals();
    const tree = await win.getByTestId('devroom-split').evaluateAll((els) => els.map((e) => e.getAttribute('data-dir')));
    check(tree.join() === 'row,col', `a card on an edge splits there: the Lead left, two stacked right (${tree.join(', ')})`);
    const divider = win.getByTestId('devroom-divider').first();
    const d = (await divider.boundingBox())!;
    await desk.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
    await desk.mouse.down();
    await desk.mouse.move(d.x + d.width / 2 + 220, d.y + d.height / 2, { steps: 6 });
    await desk.mouse.up();
    const wide = (await paneOf('shop-web').boundingBox())!.width;
    check(wide > (await paneOf('web-worker').boundingBox())!.width, `the divider resizes: the Lead pane is wider (${Math.round(wide)} px)`);
    await desk.waitForFunction(() => document.querySelectorAll('[data-testid="devroom-pane"] .xterm-rows').length === 3, undefined, { timeout: 30_000 });
    await desk.waitForTimeout(1500);
    await shot(desk, 'pc-free-layout');
    await desk.reload();
    try {
      await desk.locator('[data-hud-window="devroom"]').waitFor({ timeout: 8_000 });
    } catch {
      await desk.locator('[data-hud-id="icon:devroom"] button').click();
    }
    await desk.locator('[data-hud-window="devroom"] [data-testid="devroom-pane"]').nth(2).waitFor({ timeout: 30_000 });
    const back = await desk.locator('[data-hud-window="devroom"] [data-testid="devroom-split"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-dir')));
    check(back.join() === 'row,col', 'a reload restores the free layout');

    // ── Phone ──
    const phone = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await phone.locator('[data-dock="devroom"]').tap();
    await phone.getByTestId('devroom-trunk').first().tap();
    const term = phone.getByTestId('devroom-phone-term');
    await term.waitFor({ timeout: 20_000 });
    check((await term.getAttribute('data-agent')) === 'shop-web', 'phone: the trunk opens the Lead full screen');
    await term.locator('[data-testid="devroom-pane-view"][data-view="terminal"]').tap();
    await phone.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('[data-testid="devroom-phone-term"] .xterm-rows')].some((el) => el.innerText.includes('fake Claude Code (pty)')), undefined, { timeout: 30_000 });
    await phone.waitForTimeout(600);
    await shot(phone, 'phone-lead-terminal');
    await phone.getByTestId('devroom-phone-all').tap();
    await phone.getByTestId('devroom-agent-card').first().waitFor();
    check((await phone.getByTestId('devroom-agent-card').count()) === 3, 'phone: 모든 에이전트 lists the three agents as cards');
    await phone.waitForTimeout(400);
    await shot(phone, 'phone-cards');
    await phone.locator('[data-testid="devroom-agent-card"][data-agent="shop-web"]').getByTestId('devroom-sub-chip').tap();
    await phone.getByTestId('devroom-sub-list').waitFor();
    await phone.waitForTimeout(400);
    await shot(phone, 'phone-sub-list');
    await phone.getByTestId('devroom-sub-row').filter({ hasText: SUBS[2].desc }).tap();
    await phone.getByTestId('devroom-sub-tool').first().waitFor({ timeout: 20_000 });
    check((await phone.getByTestId('devroom-sub-view').innerText()).includes('sumPrice\\( in src'), 'phone: the Grep call shows its pattern and path');
    await phone.waitForTimeout(400);
    await shot(phone, 'phone-sub-detail');
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `phone: no sideways scroll (${overflow})`);

    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    fs.writeFileSync(path.join(os.tmpdir(), 'run-devroom-subview.daemon.log'), daemon.log.join(''));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    repo.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
