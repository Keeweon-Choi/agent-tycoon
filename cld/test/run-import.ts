/** Browser check for T-0104. Run only with the fake HOME and port 18256 or 18257. */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openOfficeWindow,
  sparePort,
  startDaemon,
  writeEngineProjects,
} from '../../server/src/cld/testHome.js';

const port = sparePort();

async function main() {
  await assertPortFree(port);
  const { home, bin } = makeEngineHome();
  const root = path.join(home, 'projects');
  const existing = path.join(root, 'existing');
  const resumed = path.join(root, 'resumed');
  const fresh = path.join(root, 'fresh');
  for (const folder of [existing, resumed, fresh]) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'CLAUDE.md'), 'fixture\n');
  }
  writeEngineProjects(home, [{ name: 'existing', folder: existing }]);
  const conversationId = '00000000-0000-4000-8000-000000000104';
  const transcript = path.join(
    home,
    '.claude',
    'projects',
    normalizeProjectPath(resumed),
    `${conversationId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '{"type":"user","message":{"content":"기존 작업 이어서"}}\n');
  const daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, [
    '--engine',
    'on',
    '--no-terminal',
    '--allow-actions',
  ]);
  const deadline = setTimeout(() => {
    daemon.child.kill('SIGKILL');
    process.exit(1);
  }, 120_000);
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => {
      localStorage.setItem('cld.status-tree', '{"rooms":true,"orchs":true}');
    });
    const page = await context.newPage();
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await openOfficeWindow(page);
    await page.getByRole('button', { name: '폴더에서 가져오기' }).click();
    const picker = page.getByLabel('폴더 고르기');
    await picker.getByRole('button', { name: '이 폴더 선택' }).click();
    const found = page.getByRole('list', { name: '찾은 프로젝트' });
    await found.getByText('이미 등록됨').waitFor();
    await found.getByText('기존 작업 이어서').waitFor();
    const rows = found.locator('li');
    await rows.filter({ hasText: resumed }).getByLabel('이름').fill('resumed');
    await rows.filter({ hasText: fresh }).getByRole('checkbox').first().uncheck();
    await page.getByRole('button', { name: '가져오기', exact: true }).click();
    const result = page.getByRole('list', { name: '가져오기 결과' });
    await result.getByText('resumed · 추가됨').waitFor();
    await result.getByText('existing · 이미 등록되어 건너뜀', { exact: false }).waitFor();
    await page.getByLabel('폴더에서 가져오기').getByRole('button', { name: '닫기' }).click();
    await page.getByRole('heading', { name: 'resumed', exact: true }).waitFor();
    await page.getByRole('button', { name: '폴더에서 가져오기' }).click();
    await picker.getByRole('button', { name: '이 폴더 선택' }).click();
    await rows.filter({ hasText: fresh }).getByLabel('대화').selectOption('new');
    await page.getByRole('button', { name: '가져오기', exact: true }).click();
    await result.getByText('fresh · 추가됨').waitFor();
    await page.getByRole('heading', { name: 'fresh', exact: true }).waitFor({ state: 'attached' });
    await page.getByRole('button', { name: '이번 가져오기 되돌리기' }).click();
    await result.getByText('fresh · 등록 취소됨').waitFor();
    await page.getByLabel('폴더에서 가져오기').getByRole('button', { name: '닫기' }).click();
    await page.getByRole('heading', { name: 'resumed', exact: true }).waitFor();
    if (await page.getByRole('heading', { name: 'fresh', exact: true }).count())
      throw new Error('undo left fresh in the office');
    console.log('ok - imported two projects, displayed them, and undid one registry row');
    await context.close();
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

void main();
