/**
 * T-115 사이드 질문: the drawer beside a working Lead's conversation. dist/cli.js with --engine on
 * --allow-chat in an isolated HOME whose `claude` is the engine fake (it answers the initialize probe
 * with the captured CLI answer, so the picker lists the CLI's models, and a side question with a fixed
 * answer, failing once on request), headless Chromium (--disable-gpu): desktop 1440x900 모던 and
 * 픽셀 감성, phone 390x844 모던. Open the drawer, ask, see the answer card with its model, 리드에게
 * 전달 (the Lead gets one message), a failure and 다시 시도 (on the phone an expired login, T-140), close.
 *
 *   npx tsx agent-tycoon/test/run-side-question.ts <port 18480-18499>
 *
 * Screenshots: agent-tycoon/artifacts/t0115/*.png
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { transcriptPath } from '../../server/src/agent-tycoon/providers/claudeProvider.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 18480 && port <= 18499)) throw new Error('port must be 18480-18499');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/t0115');
const DEADLINE_MS = 240_000;
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__sq/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const ANSWER = '여섯 번째 배포 검사 중이에요 (12분 중 8분째)';
const QUESTION = '지금 배포 몇 번째야?';

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  fs.mkdirSync(configDirectory(home), { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'config.json'),
    JSON.stringify({ accessChosen: true, port }),
  );
  fs.copyFileSync(
    path.join(REPO_ROOT, 'server/src/agent-tycoon/fixtures/claude-initialize.json'),
    path.join(home, 'fake-initialize.json'),
  );
  fs.writeFileSync(path.join(home, 'fake-side-answer.txt'), ANSWER);
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify([{ name: 'alpha', folder, room: '개발실', wantRunning: true }]),
  );
  const daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, [
    '--engine',
    'on',
    '--allow-chat',
    '--no-terminal',
  ]);
  const { child: server } = daemon;
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  type Sess = { sessionId: string; cwd: string; name: string };
  const session = (): [string, Sess] | null => {
    for (const f of fs.readdirSync(sessions)) {
      try {
        const x = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8')) as Sess;
        if (x.name === 'alpha') return [path.join(sessions, f), x];
      } catch {
        /* being written */
      }
    }
    return null;
  };
  const setStatus = (status: 'busy' | 'idle') => {
    const [file, x] = session()!;
    fs.writeFileSync(file, JSON.stringify({ ...x, status, statusUpdatedAt: Date.now() }));
  };
  let n = 0;
  const record = (role: 'user' | 'assistant', text: string) => {
    const x = session()![1];
    const file = transcriptPath(x.cwd, x.sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const message =
      role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] };
    const uuid = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    fs.appendFileSync(
      file,
      `${JSON.stringify({ type: role, uuid, timestamp: new Date().toISOString(), message })}\n`,
    );
  };
  const transcriptLines = () => {
    const x = session()![1];
    return fs
      .readFileSync(transcriptPath(x.cwd, x.sessionId, home), 'utf-8')
      .split('\n')
      .filter(Boolean).length;
  };
  const projectFiles = () => {
    const x = session()![1];
    return fs.readdirSync(path.dirname(transcriptPath(x.cwd, x.sessionId, home))).sort();
  };
  const sideLog = path.join(home, 'fake-claude-side.log');
  const sideCalls = () =>
    fs.existsSync(sideLog)
      ? fs
          .readFileSync(sideLog, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { argv: string[]; cwd: string; stdin: string })
      : [];
  const typedLog = path.join(home, 'fake-claude-typed.log');
  const typed = () =>
    fs.existsSync(typedLog)
      ? fs
          .readFileSync(typedLog, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { text: string })
      : [];
  const until = async (ok: () => boolean, what: string, ms = 20_000) => {
    for (const end = Date.now() + ms; !ok();) {
      if (Date.now() > end) throw new Error(`timed out: ${what}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  let page: Page | undefined;
  try {
    const font = fs.readFileSync(FONT);
    const loginUrl = await daemon.loginUrl();
    const base = `http://127.0.0.1:${port}/`;
    await until(() => !!session(), 'the engine revives alpha', 40_000);
    record('user', '3차 배포 올려 줘. 검사 끝나면 알려 줘.');
    record('assistant', '네, 3차 배포를 시작할게요. 배포 검사부터 돌리고 결과는 여기에 남길게요.');
    setStatus('busy');
    const filesBefore = JSON.stringify(projectFiles());
    await new Promise((r) => setTimeout(r, 3_000));
    browser = await launchBrowser();
    // Every name the office ever showed: the fork's live-session file must never add one.
    const officeNames = new Set<string>();
    let cookies: Awaited<ReturnType<import('@playwright/test').BrowserContext['cookies']>> | null =
      null;

    const open = async (device: 'desktop' | 'phone', theme: 'modern' | 'pixel') => {
      const phone = device === 'phone';
      const opts: BrowserContextOptions = phone
        ? {
            viewport: { width: 390, height: 844 },
            deviceScaleFactor: 2,
            isMobile: true,
            hasTouch: true,
          }
        : { viewport: { width: 1440, height: 900 } };
      const ctx = await browser!.newContext(opts);
      if (cookies) await ctx.addCookies(cookies);
      await ctx.addInitScript((th) => {
        try {
          localStorage.setItem('agty.ui-theme', th);
        } catch {
          /* about:blank */
        }
      }, theme);
      await ctx.route('**/__sq/malgun.ttf', (route) =>
        route.fulfill({ body: font, contentType: 'font/ttf' }),
      );
      const p = await ctx.newPage();
      page = p; // the debug shot shows where open() stopped
      p.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
      p.on('websocket', (ws) =>
        ws.on('framereceived', (f) => {
          try {
            const m = JSON.parse(String(f.payload)) as {
              type?: string;
              orchestrators?: { name: string }[];
            };
            if (m.type === 'officeSnapshot' && m.orchestrators)
              for (const o of m.orchestrators) officeNames.add(o.name);
          } catch {
            /* not JSON */
          }
        }),
      );
      await p.goto(cookies ? base : loginUrl);
      await p.waitForURL(base);
      cookies ??= await ctx.cookies();
      await p.addStyleTag({ content: FONT_CSS });
      if (phone) {
        await p.locator('[data-dock="messenger"]').waitFor({ timeout: 60_000 });
        await p.locator('[data-dock="messenger"]').tap();
      } else {
        await p.getByRole('button', { name: /^메신저/ }).click();
      }
      const messenger = p.getByRole('region', { name: '메신저', exact: true });
      await messenger
        .getByRole('list', { name: '연락처' })
        .getByRole('button', { name: /^alpha/ })
        .click();
      const alpha = messenger.getByRole('region', { name: 'alpha 대화' });
      await alpha
        .getByText('3차 배포를 시작할게요', { exact: false })
        .first()
        .waitFor({ timeout: 15_000 });
      return { p, alpha, ctx };
    };

    const ask = async (alpha: Awaited<ReturnType<typeof open>>['alpha'], question: string) => {
      const drawer = alpha.getByTestId('side-question');
      await drawer.getByRole('textbox', { name: '사이드 질문 입력' }).fill(question);
      await drawer.getByRole('button', { name: '물어보기' }).click();
      return drawer;
    };

    // --- desktop 모던: the whole flow ---
    {
      const { p, alpha, ctx } = await open('desktop', 'modern');
      page = p;
      const before = transcriptLines();
      await alpha.getByTestId('side-open').click();
      const drawer = alpha.getByTestId('side-question');
      await drawer
        .getByText('alpha은(는) 계속 일하는 중')
        .or(drawer.getByText('alpha는 계속 일하는 중'))
        .waitFor();
      await drawer
        .getByTestId('side-model-picker')
        .locator('option', { hasText: 'Sonnet 5.5' })
        .waitFor({ state: 'attached', timeout: 20_000 });
      check(
        (await drawer.getByTestId('side-model-picker').inputValue()) === 'sonnet',
        'the picker lists the CLI models and starts on the chosen default',
      );
      await ask(alpha, QUESTION);
      await drawer.getByRole('status').getByText('답을 쓰는 중', { exact: false }).waitFor();
      check(
        !(await drawer.getByRole('button', { name: '물어보기' }).isEnabled()),
        'one question at a time: 물어보기 waits',
      );
      await p.screenshot({ path: path.join(OUT, '01-desktop-modern-asking.png') });
      const card = drawer.getByTestId('side-card').last();
      await card.getByTestId('side-answer').waitFor({ timeout: 20_000 });
      check(
        (await card.getByTestId('side-answer').innerText()).includes(ANSWER),
        'the answer card shows the answer',
      );
      check(
        (await card.getByTestId('side-model').innerText()).includes('Sonnet 5.5'),
        'the card names the model that answered',
      );
      await p.screenshot({ path: path.join(OUT, '02-desktop-modern-answer.png') });
      const [call] = sideCalls();
      check(
        call.argv.includes('--fork-session') &&
          call.argv.includes('--no-session-persistence') &&
          call.argv[call.argv.indexOf('--resume') + 1] === session()![1].sessionId &&
          call.argv[call.argv.indexOf('--model') + 1] === 'sonnet' &&
          call.argv[call.argv.indexOf('--tools') + 1] === 'Read,Grep,Glob' &&
          fs.realpathSync(call.cwd) === fs.realpathSync(folder),
        'claude ran as a read-only, unsaved fork of the Lead session in its folder, with the picked model',
      );
      check(
        officeNames.size === 1 && officeNames.has('alpha'),
        `the fork's busy live-session file in alpha's folder added no agent to the office (${[...officeNames].join(', ')})`,
      );
      check(
        transcriptLines() === before && JSON.stringify(projectFiles()) === filesBefore,
        'the Lead conversation is untouched and no transcript was added beside it',
      );

      await card.getByRole('button', { name: '리드에게 전달' }).click();
      await card.getByRole('button', { name: '전달함' }).waitFor();
      await alpha
        .locator('[data-testid="pending"]', { hasText: '[사이드 질문]' })
        .waitFor({ timeout: 10_000 });
      setStatus('idle');
      await until(
        () => typed().some((x) => x.text.includes('[사이드 질문]')),
        'the forwarded message reaches the Lead',
        40_000,
      );
      const got = typed().filter((x) => x.text.includes('[사이드 질문]'));
      check(
        got.length === 1 &&
          got[0].text.includes(QUESTION) &&
          got[0].text.includes(ANSWER) &&
          got[0].text.includes('Sonnet 5.5'),
        '리드에게 전달: the Lead gets one ordinary message with the question and the answer',
      );
      setStatus('busy');

      fs.writeFileSync(path.join(home, 'fake-side-fail-next'), '');
      await ask(alpha, '검사 끝나면 뭐 해?');
      const failed = drawer.locator('[data-testid="side-card"][data-state="failed"]');
      await failed.waitFor({ timeout: 20_000 });
      check(
        (await failed.getByRole('button', { name: '다시 시도' }).count()) === 1,
        'a failure offers 다시 시도 and 닫기',
      );
      await p.screenshot({ path: path.join(OUT, '03-desktop-modern-failed.png') });
      await failed.getByRole('button', { name: '다시 시도' }).click();
      await drawer
        .getByTestId('side-card')
        .nth(1)
        .getByTestId('side-answer')
        .waitFor({ timeout: 20_000 });
      const calls = sideCalls();
      check(
        calls.length === 3 &&
          calls[2].stdin.includes(`Q: ${QUESTION}`) &&
          calls[2].stdin.includes(`A: ${ANSWER}`),
        '다시 시도 answered, and the question carried the earlier exchange of this drawer',
      );
      await drawer.getByRole('button', { name: '사이드 질문 닫기' }).click();
      await drawer.waitFor({ state: 'detached' });
      check(
        (await alpha.getByTestId('side-card').count()) === 0,
        'closed: the side exchanges are gone, never in the conversation',
      );
      await alpha.getByTestId('side-open').click();
      check((await alpha.getByTestId('side-card').count()) === 0, 'reopened drawer starts empty');
      await alpha.getByRole('button', { name: '사이드 질문 닫기' }).click();
      await ctx.close();
    }

    // --- desktop 픽셀 감성: the answer and a failure ---
    {
      const { p, alpha, ctx } = await open('desktop', 'pixel');
      page = p;
      await alpha.getByTestId('side-open').click();
      const drawer = await ask(alpha, QUESTION);
      await drawer.getByTestId('side-answer').waitFor({ timeout: 20_000 });
      fs.writeFileSync(path.join(home, 'fake-side-fail-next'), '');
      await ask(alpha, '검사 끝나면 뭐 해?');
      await drawer
        .locator('[data-testid="side-card"][data-state="failed"]')
        .waitFor({ timeout: 20_000 });
      await p.screenshot({ path: path.join(OUT, '04-desktop-pixel-answer-failed.png') });
      check(true, 'pixel style: answer and failure cards drawn');
      await ctx.close();
    }

    // --- phone 390x844 모던: the bottom sheet ---
    {
      const { p, alpha, ctx } = await open('phone', 'modern');
      page = p;
      await alpha.getByTestId('side-open').tap();
      const drawer = await ask(alpha, QUESTION);
      await drawer.getByTestId('side-answer').waitFor({ timeout: 20_000 });
      const box = await drawer.boundingBox();
      check(
        box && box.width >= 380 && box.y > 200,
        'phone: the drawer is a bottom sheet across the screen',
      );
      await p.screenshot({ path: path.join(OUT, '05-phone-modern-answer.png') });
      fs.writeFileSync(path.join(home, 'fake-side-fail-next'), 'login');
      await ask(alpha, '검사 끝나면 뭐 해?');
      const failed = drawer.locator('[data-testid="side-card"][data-state="failed"]');
      await failed.waitFor({ timeout: 20_000 });
      check(
        /\/login/.test((await failed.getByRole('alert').textContent()) ?? ''),
        'phone: an expired login says to run /login (T-140)',
      );
      await p.screenshot({ path: path.join(OUT, '06-phone-modern-failed.png') });
      await failed.getByRole('button', { name: '다시 시도' }).tap();
      await drawer
        .getByTestId('side-card')
        .nth(1)
        .getByTestId('side-answer')
        .waitFor({ timeout: 20_000 });
      await drawer.getByRole('button', { name: '사이드 질문 닫기' }).tap();
      await drawer.waitFor({ state: 'detached' });
      check(true, 'phone: failure, 다시 시도 and close');
      await ctx.close();
    }
    check(
      JSON.stringify(projectFiles()) === filesBefore,
      'no forked transcript appeared in the Lead project folder',
    );
  } catch (err) {
    await page
      ?.screenshot({ path: path.join(OUT, 'debug.png'), timeout: 5_000 })
      .catch((e: unknown) => console.error(`no debug shot: ${String(e)}`));
    throw err;
  } finally {
    await browser?.close();
    if (server.exitCode === null && server.signalCode === null) {
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
