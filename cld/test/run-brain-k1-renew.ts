/**
 * Brain K1 (BRN §3.2, §6.2 K1): the structured renew, end to end. dist/cli.js with --engine on in a
 * temp HOME whose `claude` is the engine fake; the project `alpha` is a git repository.
 * 1. A handoff in the form, renewed through the owner's CLI: the new conversation's first message
 *    has the safety lines, the six sections, then the work basis (session, branch, HEAD, changed
 *    files, worktrees, Tasks, running work), in that order; `orch_renew` says format ok.
 * 2. A free text renews too (format free; the notice line says "양식 아님").
 * 3. A start that fails (.fake-untrusted): the record is kept, nothing retries it, the
 *    conversation shows "교대 실패 · 다음 켤 때 새 대화"; the person's start is a new conversation
 *    (no --resume) whose first message is the handoff, and renew-history.json gets the term.
 * Headless Chromium without a GPU, desktop 1280x800. Pictures: cld/artifacts/brain-k1-renew/.
 *
 *   nice -n 10 taskset -c 8-11 npx tsx cld/test/run-brain-k1-renew.ts 18320
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { loadRegistry, registryPath } from '../../server/src/cld/engine/registry.js';
import {
  assertPortFree,
  engineCalls,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]) || 18320;
if (port < 18320 || port > 18329) throw new Error('K1 runs on 18320-18329');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/brain-k1-renew');
const DEADLINE_MS = 240_000;

let oks = 0;
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  oks++;
  console.log(`ok - ${what}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  for (const end = Date.now() + ms; ; await sleep(200)) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  const git = (...a: string[]) =>
    spawnSync('git', ['-c', 'user.email=k1@test', '-c', 'user.name=k1', ...a], { cwd: folder, encoding: 'utf-8' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(folder, 'README.md'), 'alpha\n');
  git('add', '.');
  git('commit', '-qm', 'first');
  const sha = git('rev-parse', '--short=7', 'HEAD').stdout.trim();
  fs.writeFileSync(path.join(folder, 'wip.txt'), 'not committed\n');
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify([{ name: 'alpha', folder, room: '개발실', wantRunning: true }]),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    { FAKE_TURN_MS: '600' },
  );
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  const deadline = setTimeout(() => {
    console.error(`K1: past the deadline ${DEADLINE_MS / 1000} s`);
    daemon.child.kill('SIGKILL'); // our own daemon only
    process.exit(1);
  }, DEADLINE_MS);
  const browser = await launchBrowser();
  let code = 0;
  try {
    const cli = (...args: string[]) =>
      JSON.parse(
        spawnSync(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args], {
          env: { ...process.env, HOME: home, CLD_OUTPUT: 'json' },
          encoding: 'utf8',
          timeout: 60_000,
        }).stdout || '{}',
      ) as Record<string, unknown>;
    const registry = () => loadRegistry(registryPath(home)).projects.find((p) => p.name === 'alpha');
    const sessionId = () => registry()?.sessionId ?? null;
    const renews = () =>
      fs
        .readFileSync(path.join(cfg, 'events.jsonl'), 'utf-8')
        .split('\n')
        .filter((l) => l.includes('"orch_renew"'))
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    /** Every handoff message the inbox got (waiting or delivered), oldest first. */
    const firstMessages = () => {
      const dir = path.join(cfg, 'inbox', 'alpha');
      const files = [dir, path.join(dir, 'delivered')].flatMap((d) => {
        try {
          return fs.readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => path.join(d, f));
        } catch {
          return [];
        }
      });
      return files
        .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
        .map((f) => fs.readFileSync(f, 'utf-8'))
        .filter((t) => t.includes('[agty renew · '));
    };
    await until('alpha runs', () => !!sessionId(), 60_000);
    const first = sessionId()!;

    // ── 1. A handoff in the form ──
    const sections = ['## 목표', '## 완료', '## 미해결', '## 다음 행동', '## 결정', '## 시도했다 버린 것'];
    const handoffFile = path.join(home, 'handoff.md');
    fs.writeFileSync(handoffFile, sections.map((h, i) => `${h}\n- [사실] 칸 ${i} (커밋 ${sha}, FR-OFC-001)`).join('\n'));
    const r1 = cli('renew', '--project', 'alpha', handoffFile);
    check(r1.ok === true, `agty renew accepted (${JSON.stringify(r1)})`);
    await until('the first renew is over', () => renews().length === 1, 60_000);
    check(renews()[0].ok === true && renews()[0].format === 'ok', `orch_renew ok, format ok (${JSON.stringify(renews()[0])})`);
    const second = sessionId()!;
    check(second !== first, 'a new conversation');
    await until('the handoff reached the inbox', () => firstMessages().length >= 1);
    const text = firstMessages()[0];
    const order = [
      '이전 대화와 아래 인수인계는 읽기 전용 참고다',
      '워크트리(`git status`)가 아래 기록과 다르면 워크트리가 정본이다',
      '먼저 어디서 멈췄는지',
      `--- 인수인계 (${handoffFile}) ---`,
      ...sections,
      '--- 작업 기준 (엔진이 직접 읽은 값) ---',
      `이전 세션: ${first}`,
      `폴더: ${folder} · 브랜치: main · HEAD: ${sha} · 바뀐 파일: 1개`,
      'task worktree: 없음',
      '열린 Task (',
      '돌고 있는 일: ',
      'Worker: ',
      '최근 이벤트 (24시간',
    ];
    const at = order.map((x) => text.indexOf(x));
    check(at.every((x) => x >= 0) && at.every((x, i) => i === 0 || x > at[i - 1]), `first message in order: safety, six sections, work basis (${at.join(',')})`);
    fs.writeFileSync(path.join(OUT, 'first-message.txt'), text);

    // ── 2. A free text ──
    fs.writeFileSync(handoffFile, '그냥 메모: 배포 스크립트 고치다 멈춤, 다음엔 시험부터');
    const r2 = cli('renew', '--project', 'alpha', handoffFile);
    check(r2.ok === true, 'a free handoff is accepted too');
    await until('the second renew is over', () => renews().length === 2, 60_000);
    check(renews()[1].ok === true && renews()[1].format === 'free', 'orch_renew ok, format free');
    const third = sessionId()!;

    // ── 3. A start that fails ──
    fs.writeFileSync(path.join(folder, '.fake-untrusted'), '');
    fs.writeFileSync(handoffFile, '## 목표\n- [사실] 시작 실패 시험\n## 완료\n## 미해결\n## 다음 행동\n- [판단] 다음 켤 때 이어서');
    check(cli('renew', '--project', 'alpha', handoffFile).ok === true, 'third renew accepted');
    await until('the third renew is over', () => renews().length === 3, 60_000);
    check(renews()[2].ok === false && renews()[2].code === 'start_failed', 'orch_renew start_failed');
    const rec = JSON.parse(fs.readFileSync(path.join(cfg, 'renewals', 'alpha.json'), 'utf-8')) as Record<string, unknown>;
    check(rec.v === 1 && rec.phase === 'starting' && !!rec.failed && rec.oldSessionId === third, 'the record is kept (v1, starting, failed)');
    check(Array.isArray(rec.refs) && (rec.base as { head?: string }).head === sha, `refs and base kept (${JSON.stringify(rec.base)})`);
    fs.rmSync(path.join(folder, '.fake-untrusted'));
    const bgBefore = engineCalls(home).filter((c) => c.argv[0] === '--bg').length;

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript('globalThis.__name = (fn) => fn;');
    const page = await ctx.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    const infoClose = page.getByRole('button', { name: '정보 창 닫기' });
    if (await infoClose.count()) await infoClose.click();
    await page.getByRole('button', { name: /^메신저/ }).first().click();
    const messenger = page.getByRole('region', { name: '메신저', exact: true });
    await messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }).click();
    const conv = messenger.getByRole('region', { name: 'alpha 대화' });
    const note = conv.getByTestId('renew-failed-note');
    await note.waitFor({ timeout: 20_000 });
    check((await note.innerText()).includes('교대 실패 · 다음 켤 때 새 대화'), 'the conversation says the renew failed and the next start is new');
    await page.screenshot({ path: path.join(OUT, 'desktop-renew-failed.png') });
    await sleep(4_000); // the watch's beats: nothing may start it meanwhile
    check(engineCalls(home).filter((c) => c.argv[0] === '--bg').length === bgBefore, 'no automatic retry');

    // The person's 켜기 (an engineAction over the page's own socket).
    const started = await page.evaluate(
      (port) =>
        new Promise<string>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
          ws.onopen = () => ws.send(JSON.stringify({ type: 'engineAction', requestId: 'k1-start', action: 'start', name: 'alpha' }));
          ws.onmessage = (m) => {
            const j = JSON.parse(String(m.data)) as { type?: string; requestId?: string };
            if (j.type === 'engineActionResult' && j.requestId === 'k1-start') resolve(String(m.data));
          };
          setTimeout(() => resolve('timeout'), 30_000);
        }),
      port,
    );
    check(started.includes('"ok":true'), `the person's start went through (${started.slice(0, 160)})`);
    const fourth = sessionId()!;
    const lastStart = engineCalls(home).filter((c) => c.argv[0] === '--bg').at(-1)!.argv.join(' ');
    check(fourth !== third && !lastStart.includes('--resume'), `a new conversation, not the old one (${lastStart.slice(0, 40)})`);
    await until('the handoff went in as its first message', () => firstMessages().some((t) => t.includes('시작 실패 시험')));
    check(!fs.existsSync(path.join(cfg, 'renewals', 'alpha.json')), 'the record is gone');
    const terms = (JSON.parse(fs.readFileSync(path.join(cfg, 'renew-history.json'), 'utf-8')) as { terms: Array<{ sessionId: string; next: string }> }).terms;
    check(
      terms.map((t) => `${t.sessionId}>${t.next}`).join(' ') === `${first}>${second} ${second}>${third} ${third}>${fourth}`,
      'renew-history.json chains the four conversations',
    );
    await note.waitFor({ state: 'detached', timeout: 20_000 });
    check(true, 'the failure note goes once the new conversation is up');
    await page.screenshot({ path: path.join(OUT, 'desktop-after-start.png') });
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
    await ctx.close();
    console.log(`\nK1: ${oks} checks passed. Pictures: ${OUT}`);
  } catch (err) {
    code = 1;
    console.error(err instanceof Error ? err.message : String(err));
    console.error(daemon.log.join('').split('\n').filter((l) => l.includes('renew')).slice(-20).join('\n'));
  } finally {
    clearTimeout(deadline);
    await browser.close();
    await daemon.stop();
    killFakeSessions(home);
  }
  process.exit(code);
}

void main();
