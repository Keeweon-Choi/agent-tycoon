/**
 * EDIT-ATTACH (owner 11-03): while a held message is edited (수정), 첨부 works: the picker and the
 * paste take a file, its chip shows, and 보내기 uploads it and sends the replacement text with the
 * file's line. dist/cli.js with --engine on --allow-chat in an isolated HOME whose `claude` is the
 * engine fake, headless Chromium (--disable-gpu), desktop 1400x900.
 *
 *   npx tsx agent-tycoon/test/run-edit-attach.ts <port 18314|18315>
 *
 * Screenshots: agent-tycoon/artifacts/edit-attach/*.png
 */
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
if (![18314, 18315].includes(port)) throw new Error('port must be 18314 or 18315');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/edit-attach');
const DEADLINE_MS = 150_000;
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__ea/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=',
  'base64',
);

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

  type Sess = { sessionId: string; cwd: string; name: string; jobId: string };
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
  // A turn running: its prompt is the transcript's newest record.
  const record = (role: 'user' | 'assistant', text: string, n: number) => {
    const x = session()![1];
    const file = transcriptPath(x.cwd, x.sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const message =
      role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] };
    fs.appendFileSync(
      file,
      `${JSON.stringify({ type: role, uuid: `0000000${n}-0000-4000-8000-000000000000`, timestamp: new Date().toISOString(), message })}\n`,
    );
  };
  const startTurn = () => {
    record('user', '빌드 돌려 줘', 1);
    setStatus('busy');
  };
  const typedLog = path.join(home, 'fake-claude-typed.log');
  const typed = () =>
    fs.existsSync(typedLog)
      ? fs
          .readFileSync(typedLog, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { id: string; text: string })
      : [];

  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    const font = fs.readFileSync(FONT);
    const url = await daemon.loginUrl();
    for (const end = Date.now() + 40_000; !session(); ) {
      if (Date.now() > end) throw new Error('the engine did not revive the session');
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 4_000));
    browser = await launchBrowser();
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.route('**/__ea/malgun.ttf', (route) =>
      route.fulfill({ body: font, contentType: 'font/ttf' }),
    );
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    await page.getByRole('button', { name: /^메신저/ }).click();
    const messenger = page.getByRole('region', { name: '메신저', exact: true });
    await messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }).click();
    const alpha = messenger.getByRole('region', { name: 'alpha 대화' });
    const box = alpha.getByRole('textbox', { name: '보낼 글' });

    // A lead that works takes no message: it waits in the queue, so 수정 is offered.
    startTurn();
    await alpha.getByTestId('typing').waitFor({ timeout: 10_000 });
    await box.fill('배포 전에 확인해 줘');
    await alpha.getByRole('button', { name: '보내기', exact: true }).click();
    const bubble = alpha.locator('[data-testid="pending"]', { hasText: '배포 전에 확인해 줘' });
    await bubble.getByText('보냄(대기 중)').waitFor({ timeout: 10_000 }).catch(async (e) => {
      await page.screenshot({ path: path.join(OUT, 'debug.png') });
      throw e;
    });
    await bubble.hover();
    await bubble.getByRole('button', { name: '수정' }).click();
    await alpha.getByText('메시지 수정 중').waitFor();

    // The picker and the paste both take a file while editing; the chip shows.
    check((await alpha.getByRole('button', { name: '첨부', exact: true }).count()) === 1, '수정: the 첨부 button is there');
    await alpha.getByLabel('첨부 파일 선택', { exact: true }).setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: PNG_BYTES });
    await alpha.getByLabel('첨부 파일', { exact: true }).getByText('shot.png').waitFor({ timeout: 10_000 });
    check(
      (await alpha.getByLabel('첨부 파일', { exact: true }).getByText('shot.png').count()) === 1,
      '수정: the picked file shows as a chip',
    );
    await box.fill('배포 전에 확인하고 그림도 봐 줘');
    await page.screenshot({ path: path.join(OUT, 'desktop-edit-with-chip.png') });
    await alpha.getByRole('button', { name: '보내기', exact: true }).click();

    const edited = alpha.locator('[data-testid="pending"]', { hasText: '배포 전에 확인하고 그림도 봐 줘' });
    await edited.getByText('수정함').waitFor({ timeout: 15_000 });
    await alpha.getByLabel('첨부 파일', { exact: true }).waitFor({ state: 'detached', timeout: 10_000 });
    check(
      (await edited.locator('img').count()) >= 1,
      '수정함: the bubble shows the attached picture and the composer chip list is empty',
    );
    await page.screenshot({ path: path.join(OUT, 'desktop-edited-bubble.png') });

    await edited.getByRole('button', { name: '지금 보내기' }).click();
    for (const end = Date.now() + 40_000; !typed().some((t) => t.text.includes('shot.png')); ) {
      if (Date.now() > end) throw new Error(`the edited message never reached the session: ${JSON.stringify(typed())}`);
      await new Promise((r) => setTimeout(r, 300));
    }
    const sent = typed().find((t) => t.text.includes('shot.png'))!.text;
    check(
      sent.includes('배포 전에 확인하고 그림도 봐 줘') &&
        /\[첨부\] \S+\.agty-inbox\/\S*shot\.png \(image\/png, \d+ KB\)/.test(sent) &&
        !typed().some((t) => t.text.endsWith('배포 전에 확인해 줘')),
      'the session got the edited text with the [첨부] line; the old text never went in',
    );
    await page.screenshot({ path: path.join(OUT, 'desktop-delivered.png') });
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
