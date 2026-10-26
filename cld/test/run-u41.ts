/**
 * U-41: purple accent text is readable. dist/cli.js with --engine on in an isolated HOME,
 * headless Chromium (--disable-gpu), desktop 1280x800 and phone 393x852. Screenshots of the
 * messenger (a DM with a link), the HUD window and a selected workbench tab, each "after"
 * (this build) and "before" (the same build with the old token values injected: accent #6030ff
 * for fills and text alike), into cld/artifacts/u41/. Also reads the computed colour of the
 * selected tab's label against its background.
 *
 *   npx tsx cld/test/run-u41.ts <port 18256-18259>
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openOfficeWindow,
  openWorkbenchTab,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';
import { configDirectory } from '../../server/src/cld/configPath.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/u41');
const PHONE = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 393, height: 852 } };
})();
// eslint-disable-next-line pixel-agents/no-inline-colors -- the pre-U-41 token values, injected only to take the "before" shots
const BEFORE = ':root{--color-accent:#6030ff;--color-accent-text:#6030ff}';

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(configDirectory(home), { recursive: true });
  const dir = path.join(home, 'work', 'alpha');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify([{ name: 'alpha', folder: dir, room: '개발실', wantRunning: true }]),
  );
  const daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, [
    '--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal',
  ]);
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (daemon.child.exitCode === null) daemon.child.kill('SIGKILL');
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort('deadline'), 180_000);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  const url = await daemon.loginUrl();
  let sess: { sessionId: string; cwd: string } | null = null;
  for (const end = Date.now() + 30_000; !sess && Date.now() < end; await new Promise((r) => setTimeout(r, 200)))
    for (const f of fs.readdirSync(sessions)) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8'));
        if (s.name === 'alpha') sess = s;
      } catch { /* being written */ }
    }
  if (!sess) abort('no alpha session');
  const file = transcriptPath(sess!.cwd, sess!.sessionId, home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const t0 = Date.now() - 60_000;
  ['See [the report](https://example.com/report) and `src/index.css`.', 'Anything else?'].forEach((text, i) =>
    fs.appendFileSync(file, `${JSON.stringify({
      type: 'assistant', uuid: `0000000${i}-0000-4000-8000-000000000000`,
      timestamp: new Date(t0 + i * 1000).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    })}\n`),
  );

  const browser = await launchBrowser();
  const nameShim = 'globalThis.__name = (fn) => fn;';
  let state: Awaited<ReturnType<import('@playwright/test').BrowserContext['storageState']>> | undefined;
  try {
    for (const [label, opts, touch] of [
      ['desktop', { viewport: { width: 1280, height: 800 } }, false],
      ['phone', PHONE, true],
    ] as const) {
      const ctx = await browser.newContext(state ? { ...opts, storageState: state } : opts);
      await ctx.addInitScript(nameShim);
      const page: Page = await ctx.newPage();
      await page.goto(state ? `http://127.0.0.1:${port}/` : url); // the login link is single-use
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      state ??= await ctx.storageState();
      const close = page.getByRole('button', { name: '정보 창 닫기' });
      if (await close.count()) await close.click();
      const tap = (l: ReturnType<Page['locator']>) => (touch ? l.tap() : l.click());
      const shot = async (name: string) => {
        await page.screenshot({ path: path.join(OUT, `${label}-${name}-after.png`) });
        const style = await page.addStyleTag({ content: BEFORE });
        await page.screenshot({ path: path.join(OUT, `${label}-${name}-before.png`) });
        await style.evaluate((el) => el.remove());
      };

      await tap(page.getByRole('button', { name: /^메신저/ }));
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      await tap(messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }));
      await messenger.getByRole('region', { name: 'alpha 대화' }).getByText('the report').waitFor();
      await shot('messenger');
      await page.goto(`http://127.0.0.1:${port}/`);
      if (!touch) {
        await openOfficeWindow(page);
        await shot('hud');
      }
      await openWorkbenchTab(page, '에이전트', { tap: touch });
      await shot('tab-selected');
      // the selected tab: label colour vs the background it sits on
      const sel = page.getByRole('button', { name: '에이전트', exact: true }).first();
      console.log(label, 'selected tab colour', await sel.evaluate((e) => getComputedStyle(e).color));

      await ctx.close();
    }
  } finally {
    await browser.close();
    clearTimeout(deadline);
    await daemon.stop();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
