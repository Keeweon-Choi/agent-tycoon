/**
 * T-0021 independence check: the built daemon (dist/cli.js) with
 * `--engine on --allow-chat` on a spare port, in an isolated HOME with the
 * engine's fake `claude`, the fake `codex` (cld/test/fake-codex) and a fake
 * LibreHardwareMonitor (cld/test/hw/lhm-intel-nvidia.json served on a second
 * spare port). `office`, `nvidia-smi` and `tmux` are traps on PATH that log any
 * run; the real codex is not on PATH. The user's gpu.json in that HOME sets
 * the waiting numbers.
 *
 * Through the CLI, from the project folder: a GPU job holding the GPU alone,
 * a second one waiting for it, a Codex task waiting out a usage limit, and a
 * Codex task in a new worktree that finishes. Then, headless Chromium
 * (--disable-gpu, office hours off), desktop 1280x800: the office, the 작업실's Task tab (GPU
 * badges) and 에이전트 tab (Codex: 한도 대기, 완료, 엔진), HW (LHM GPU readings, the GPU
 * board), the 알림 list (codex_* and gpu_* in words), the Codex end notice, and the
 * messenger (the one-line notice typed into alpha's session). Screenshots go
 * to cld/artifacts/t0021/.
 *
 *   npx tsx cld/test/run-t0021.ts <port 18256-18259> <lhm port 18256-18259>
 */
import type { Browser } from '@playwright/test';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
import {
  assertPortFree,
  hostHealth,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openWorkbenchTab,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort(2);
const lhmPort = sparePort(3);
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0021');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0021/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 240_000;

let checks = 0;
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  checks += 1;
  console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 30_000) {
  for (const end = Date.now() + ms; !(await fn());) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main() {
  if (port === lhmPort) throw new Error('two different ports in 18256-18259');
  await assertPortFree(port, lhmPort);
  fs.mkdirSync(OUT, { recursive: true });

  // ── The isolated HOME ──
  const { home, bin } = makeEngineHome();
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  const work = path.join(home, 'work', 'alpha');
  fs.mkdirSync(work, { recursive: true });
  const gitEnv = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@x',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@x',
  };
  const git = (args: string[]) => execFileSync('git', args, { cwd: work, env: gitEnv });
  git(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(work, 'README.md'), 'alpha\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  fs.writeFileSync(path.join(work, 'spec-limit.md'), '# 한도에 걸리는 일\n');
  fs.writeFileSync(path.join(work, 'spec-done.md'), '# 끝나는 일\n');
  const cfg = path.join(home, '.config/cld-gui');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'projects.json'),
    JSON.stringify([{ name: 'alpha', folder: work, room: '개발실', wantRunning: true }]),
  );
  // The user's numbers: with them, a second GPU job waits behind one that holds it alone.
  fs.writeFileSync(
    path.join(cfg, 'gpu.json'),
    JSON.stringify({ exclusiveGib: 4.5, sharedBudgetGib: 4.5 }),
  );
  // Traps: anything that runs office, nvidia-smi or tmux is logged (and fails).
  const traps = path.join(home, 'trap-bin');
  const trapLog = path.join(home, 'traps.log');
  fs.mkdirSync(traps);
  for (const name of ['office', 'nvidia-smi', 'tmux']) {
    fs.writeFileSync(
      path.join(traps, name),
      `#!/bin/sh\necho "${name} $*" >> "${trapLog}"\nexit 1\n`,
    );
    fs.chmodSync(path.join(traps, name), 0o755);
  }
  const PATH = [
    traps,
    bin,
    path.join(REPO_ROOT, 'cld/test/fake-codex'),
    path.dirname(process.execPath),
    '/usr/bin',
    '/bin',
  ].join(':');
  const env = {
    HOME: home,
    PATH,
    LANG: 'C.UTF-8',
    XDG_RUNTIME_DIR: home, // no systemd user manager here: setsid, never systemd-run
    FAKE_TURN_MS: '600',
  };
  const realCodex = spawnSync('sh', ['-c', 'command -v codex'], { env }).stdout.toString().trim();
  check(
    realCodex === path.join(REPO_ROOT, 'cld/test/fake-codex/codex'),
    `codex on PATH is the fake (${realCodex})`,
  );

  // ── Fake LHM ──
  const lhmJson = fs.readFileSync(path.join(REPO_ROOT, 'cld/test/hw/lhm-intel-nvidia.json'));
  const lhm = http
    .createServer((req, res) => {
      if (req.url === '/data.json') res.end(lhmJson);
      else res.writeHead(404).end();
    })
    .listen(lhmPort, '127.0.0.1');

  // ── The daemon ──
  // Strict environment: HOME and PATH (traps, fakes, node) only, as the traps assume.
  const daemon = startDaemon(
    { home },
    port,
    ['--engine', 'on', '--allow-chat', '--lhm-port', String(lhmPort), '--no-terminal'],
    { PATH: env.PATH, LANG: env.LANG, FAKE_TURN_MS: env.FAKE_TURN_MS },
    true,
  );
  const { child: server, log: serverLog } = daemon;
  const cleanup = () => {
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    // The jobs this run started (detached groups), by their records in this HOME only.
    const jobs = path.join(home, '.local/state/cld-gui/jobs');
    for (const f of fs.existsSync(jobs) ? fs.readdirSync(jobs) : []) {
      if (!f.endsWith('.json')) continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(jobs, f), 'utf-8')) as { pid?: number };
        const env = fs.readFileSync(`/proc/${r.pid}/environ`, 'utf-8').split('\0');
        if (r.pid && r.pid > 1 && env.includes(`HOME=${home}`)) process.kill(-r.pid, 'SIGKILL');
      } catch {
        /* ended */
      }
    }
    killFakeSessions(home);
    lhm.close();
  };
  const abort = (why: string) => {
    console.error(`aborted: ${why}\n${serverLog.join('').slice(-4000)}`);
    cleanup();
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  const cli = (args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args], {
      cwd: work,
      env: { ...env, ...extra },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const events = () =>
    fs
      .readFileSync(path.join(cfg, 'events.jsonl'), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const session = () => {
    const dir = path.join(home, '.claude/sessions');
    for (const f of fs.readdirSync(dir))
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as {
          name: string;
          cwd: string;
          sessionId: string;
          jobId: string;
        };
        if (s.name === 'alpha') return s;
      } catch {
        /* being written */
      }
    return null;
  };
  // Claude, played: what the engine types into alpha becomes a prompt and a reply.
  const typedLog = path.join(home, 'fake-claude-typed.log');
  const typed = () =>
    fs.existsSync(typedLog)
      ? fs
          .readFileSync(typedLog, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { id: string; text: string })
      : [];
  let answered = 0;
  let n = 0;
  const say = (role: 'user' | 'assistant', text: string) => {
    const s = session();
    if (!s) return;
    const file = transcriptPath(s.cwd, s.sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const uuid = `${(++n).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const timestamp = new Date().toISOString();
    fs.appendFileSync(
      file,
      `${JSON.stringify(
        role === 'user'
          ? { type: 'user', uuid, timestamp, message: { role, content: text } }
          : {
              type: 'assistant',
              uuid,
              timestamp,
              message: { role, content: [{ type: 'text', text }] },
            },
      )}\n`,
    );
  };
  const replier = setInterval(() => {
    const all = typed();
    for (const t of all.slice(answered)) {
      say('user', t.text.replaceAll('\r', '\n'));
      say('assistant', '확인했어요. Codex 결과를 검증할게요.');
    }
    answered = all.length;
  }, 300);

  let browser: Browser | undefined;
  try {
    const url = await daemon.loginUrl();
    const health = await hostHealth(port, home);
    check(health.pid === server.pid, `port ${port} answers for our daemon (pid ${health.pid})`);
    await until('alpha revived by the engine', () => session() !== null, 40_000);
    await new Promise((r) => setTimeout(r, 4_000)); // the revive notice typed in and answered

    // ── The CLI, from alpha's folder ──
    const holder = cli(['job', '--gpu', '--exclusive', '--label', '학습', 'echo train; sleep 150']);
    check(
      holder.code === 0 && holder.out.includes('GPU 차례를 기다렸다가 돈다'),
      `job --gpu: ${holder.out.trim()}`,
    );
    await until('the first GPU job leases', () =>
      events().some((e) => e.type === 'gpu_lease' && e.project === 'alpha'),
    );
    const waiter = cli(['job', '--gpu', '--vram', '2', '--label', '추론', 'echo infer']);
    check(waiter.code === 0, 'a second GPU job is accepted');
    await until('the second waits in the queue', () =>
      cli(['gpu', '--json']).out.includes('"position":1'),
    );
    const board = JSON.parse(cli(['gpu', '--json']).out) as {
      dir: string;
      holders: Array<{ label: string; exclusive: boolean }>;
      queue: Array<{ label: string; position: number }>;
    };
    fs.writeFileSync(path.join(OUT, 'gpu-board.json'), `${JSON.stringify(board, null, 2)}\n`);
    check(
      board.dir === path.join(home, '.local/share/cld-gui/gpu') &&
        board.holders[0]?.label === '학습' &&
        board.queue[0]?.label === '추론',
      `cld-gui gpu: our own queue folder, 학습 holds, 추론 waits (${board.dir})`,
    );
    const jobs = JSON.parse(cli(['jobs']).out) as { jobs: Array<{ gpu: string | null }> };
    check(
      jobs.jobs
        .map((j) => j.gpu)
        .sort()
        .join(',') === 'leased,queued',
      'cld-gui jobs: gpu leased and queued',
    );

    fs.writeFileSync(
      path.join(home, 'fake-codex.json'),
      JSON.stringify({ scenario: 'limit', resetS: 900 }),
    );
    const limited = cli(['codex', 'spec-limit.md']);
    check(
      limited.code === 0 && limited.out.includes('Codex 에 맡김'),
      `codex: ${limited.out.split('\n')[0]}`,
    );
    const limitedId = /작업 (\S+)/.exec(limited.out)![1];
    await until('the task waits out its limit', () =>
      events().some((e) => e.type === 'codex_limit' && e.id === limitedId),
    );
    fs.writeFileSync(path.join(home, 'fake-codex.json'), JSON.stringify({ scenario: 'success' }));
    const done = cli(['codex', '-m', 'test-model', '--worktree', 'spec-done.md']);
    check(
      done.code === 0 && done.out.includes('task/codex-'),
      `codex --worktree: ${done.out.split('\n')[0]}`,
    );
    const doneId = /작업 (\S+)/.exec(done.out)![1];
    await until('the worktree task ends', () =>
      events().some((e) => e.type === 'codex_end' && e.id === doneId),
    );
    const tasks = JSON.parse(cli(['codex']).out) as {
      tasks: Array<{ id: string; state: string; limit: { reset_at: string } | null }>;
    };
    fs.writeFileSync(path.join(OUT, 'codex-tasks.json'), `${JSON.stringify(tasks, null, 2)}\n`);
    check(
      tasks.tasks.find((t) => t.id === limitedId)?.state === 'limit' &&
        !!tasks.tasks.find((t) => t.id === limitedId)?.limit?.reset_at &&
        tasks.tasks.find((t) => t.id === doneId)?.state === 'done',
      'cld-gui codex: one waits (limit, reset_at), one done',
    );
    await until(
      'the one-line notices reach alpha (typed in by the messenger)',
      () => typed().filter((t) => t.text.includes('[cld-gui codex]')).length >= 2,
      40_000,
    );
    const notices = typed().filter((t) => t.text.includes('[cld-gui codex]'));
    check(
      notices.some((t) => t.text.includes(`작업 ${limitedId} 이 Codex 사용량 한도에 걸렸다`)) &&
        notices.some((t) => t.text.includes(`작업 ${doneId} 끝: done`)),
      `the orchestrator got both notices (${notices.length})`,
    );

    // ── The office ──
    const font = fs.readFileSync(FONT);
    browser = await launchBrowser();
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    await ctx.addInitScript(() => localStorage.setItem('cld.office-hours', '{"on":false}'));
    await ctx.route('**/__t0021/malgun.ttf', (route) =>
      route.fulfill({ body: font, contentType: 'font/ttf' }),
    );
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
    await page.waitForTimeout(3_000);
    const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
    await shot('desktop-office');
    // T-0046's lobby board, fed by the engine's gpu_* events (no office here).
    const lobby = page.locator('[data-testid="lobby-board"]');
    await lobby.locator('[data-testid="board-tab-gpu"]').click();
    await lobby.locator('[data-testid="board-holder"]').first().waitFor();
    const holderText = await lobby.locator('[data-testid="board-holder"]').first().innerText();
    check(
      holderText.includes('alpha') &&
        holderText.includes('학습') &&
        (await lobby.locator('[data-testid="board-queuer"]').count()) === 1,
      `lobby board: alpha holds (${holderText.replace(/\s+/g, ' ')}), one in line`,
    );
    await lobby.scrollIntoViewIfNeeded();
    await shot('desktop-lobby-gpu');
    // T-0077: the 현황판 icon opens its window (open already on a desktop's first load).
    if (!(await page.getByRole('navigation', { name: '사무실 메뉴' }).isVisible()))
      await page
        .locator('[data-hud-id^="icon:"]')
        .getByRole('button', { name: '현황판', exact: true })
        .click();
    const tab = async (name: string) => {
      await page
        .getByRole('navigation', { name: '사무실 메뉴' })
        .getByRole('button', { name, exact: true })
        .click();
      await page.waitForTimeout(800);
    };

    // UI-C1: the job cards are alpha's Task tab (실행) in the 작업실; its Codex runs, the 에이전트 tab.
    await openWorkbenchTab(page, 'Task', { project: 'alpha' });
    await page.waitForTimeout(800);
    // DEV-BOARD: Task opens on 업무; the job cards are its 실행 half.
    await page
      .getByRole('group', { name: '작업 보기' })
      .getByRole('button', { name: '실행', exact: true })
      .click();
    await page.locator('[data-testid="job-gpu"]').first().waitFor();
    const badges = await page.locator('[data-testid="job-gpu"]').allTextContents();
    check(
      badges.some((b) => b.includes('GPU 예약')),
      `작업: GPU badge (${badges.map((b) => b.trim()).join(' | ')})`,
    );
    // U-03: the job waiting in the queue is a status of its own, not 실행 중.
    const statuses = await page.locator('[data-testid="job-status"]').allTextContents();
    check(
      statuses.some((s) => s.startsWith('GPU 대기')) && statuses.some((s) => s.startsWith('실행 중')),
      `작업: GPU 대기 and 실행 중 apart (${statuses.join(' | ')})`,
    );
    check(
      (await page.locator('[data-testid="job-card"]').count()) === 2,
      '작업: the two GPU jobs only (the Codex workers are tasks, not jobs)',
    );
    await shot('desktop-jobs-gpu');

    await openWorkbenchTab(page, '에이전트', { project: 'alpha' });
    await page.waitForTimeout(800);
    const states = await page.locator('[data-testid="codex-state"]').allTextContents();
    check(
      states.includes('한도 대기') && states.includes('끝남(성공)'),
      `Codex: 한도 대기 and 끝남(성공) (${states.join(', ')})`,
    );
    check((await page.getByText('· 엔진').count()) >= 2, 'Codex: both rows say 엔진');
    await shot('desktop-codex');

    await tab('HW');
    await page.locator('[data-testid="gpu-board"]').waitFor();
    const hw = await page.locator('main, body').first().innerText();
    check(/LHM/.test(hw) && /GPU/.test(hw), 'HW: readings from LHM (no nvidia-smi)');
    const boardText = await page.locator('[data-testid="gpu-board"]').innerText();
    check(
      boardText.includes('예약') &&
        boardText.includes('학습') &&
        boardText.includes('대기 1') &&
        boardText.includes('추론'),
      `HW: the GPU board (${boardText.replace(/\s+/g, ' ')})`,
    );
    await page.locator('[data-testid="gpu-board"]').scrollIntoViewIfNeeded();
    await shot('desktop-hw-gpu');

    await page.getByTestId('notice-bell').click(); // T-0070: the events are in the 알림 list
    const feed = await page.getByTestId('notice-list').innerText();
    check(
      feed.includes('GPU 차례 옴: alpha') &&
        feed.includes('GPU 줄 섬: alpha') &&
        feed.includes('한도를 기다려요'),
      '알림 list: gpu_* and codex_* in words',
    );
    await shot('desktop-feed');
    await page.getByRole('button', { name: '알림 닫기' }).click();

    // The Codex end notice (T-0039): a task that ends while the office is open.
    cli(['codex', 'spec-done.md']);
    await until(
      'a toast for the Codex end',
      async () =>
        ((await page.locator('[data-testid="notice-toast"]').textContent()) ?? '').includes(
          '끝났어요',
        ), // T-0068: in words, no task id
    );
    await shot('desktop-codex-toast');
    await page.locator('[data-testid="notice-bell"]').click();
    const items = await page.locator('[data-testid="notice-item"]').allTextContents();
    check(
      items.some((t) => t.includes('🏁') && t.includes('끝났어요')),
      `notices: the Codex end (${items.join(' | ')})`,
    );
    await shot('desktop-notices');
    await page.getByRole('button', { name: '알림 닫기' }).click();

    // The messenger: alpha's conversation has the one-line notice.
    await page.getByRole('button', { name: /^메신저/ }).click();
    const messenger = page.getByRole('region', { name: '메신저', exact: true });
    await messenger
      .getByRole('list', { name: '연락처' })
      .getByRole('button', { name: /^alpha/ })
      .click();
    const conv = messenger.getByRole('region', { name: 'alpha 대화' });
    await conv
      .getByText(`작업 ${doneId} 끝: done`, { exact: false })
      .first()
      .waitFor({ timeout: 15_000 });
    check(true, 'messenger: the Codex notice in alpha’s conversation');
    await shot('desktop-messenger');

    const trapped = fs.existsSync(trapLog) ? fs.readFileSync(trapLog, 'utf-8') : '';
    fs.writeFileSync(
      path.join(OUT, 'traps.log.txt'),
      trapped || '(nothing ran office, nvidia-smi or tmux)\n',
    );
    check(trapped === '', `no office, nvidia-smi or tmux was run (${trapped.trim() || 'none'})`);
    check(errors.length === 0, `no page errors${errors.map((e) => `\n  ${e}`).join('')}`);
    fs.writeFileSync(
      path.join(OUT, 'events.jsonl.txt'),
      events()
        .filter((e) => /^(gpu_|codex_|job_)/.test(String(e.type)))
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
    );
    fs.writeFileSync(path.join(OUT, 'server-log.txt'), serverLog.join(''));
    console.log(`all ${checks} checks passed`);
  } finally {
    clearTimeout(deadline);
    clearInterval(replier);
    await browser?.close();
    cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
