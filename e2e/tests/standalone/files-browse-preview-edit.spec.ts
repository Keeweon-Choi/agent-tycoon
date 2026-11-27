/**
 * T-99 flow 11: browse a stopped project's files from the 파일 icon, preview Markdown and CSV,
 * download a file, see a sensitive file refused, edit a file and save it; the saved line is still
 * there after a reload. Selectors follow agent-tycoon/test/run-files.ts and run-files-edit.ts.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';

const SECRET = 'T99-FILES-MARKER-SECRET';
const NEW_LINE = 'export const answer = 43;';

test.use({ standaloneOptions: { agents: [{ name: 'alpha', running: false }] } });

test('browse a project, preview, download, edit and save a file @area:files', async ({
  page,
  standalone,
}) => {
  const alpha = standalone.agentFolder('alpha');
  const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(alpha, rel)), { recursive: true });
    fs.writeFileSync(path.join(alpha, rel), body);
  };
  spawnSync('git', ['init', '-q', alpha], { env: { ...process.env, HOME: standalone.tmpHome } });
  write('docs/guide.md', '# 안내서\n\n프로젝트 **안내**.\n');
  write('data.csv', 'name,count\nalpha,3\nbeta,5\n');
  write('src/main.ts', 'export const answer = 42;\n');
  write('.env', `TOKEN=${SECRET}\n`);

  await page.locator('[data-hud-id="icon:files"] button').click();
  const explorer = page.locator('section[aria-label="파일 탐색"]');
  await expect(explorer).toBeVisible({ timeout: 15_000 });
  await explorer
    .locator('button[aria-pressed]')
    .filter({ hasText: /^alpha$/ })
    .click();
  const tree = explorer.locator('[aria-label$="파일 탐색기"]');
  // Tree rows, not the 최근 산출물 list above them; a row reads "▸ docs" or "▤ data.csv".
  const node = (name: string) =>
    tree
      .locator('button:not([aria-label="최근 산출물"] button)')
      .filter({ hasText: new RegExp(`^[▸▾▤]\\s*${name.replace(/\./g, '\\.')}$`) });
  const pane = page.locator('[aria-label="파일 미리보기"]');

  for (const name of ['docs', 'src', 'data.csv']) await expect(node(name)).toBeVisible();
  await expect(node('.env')).toHaveCount(0);
  await expect(node('.git')).toHaveCount(0);

  // Markdown is rendered: its heading is a heading.
  await node('docs').click();
  await node('guide.md').click();
  await expect(pane.getByRole('heading', { name: '안내서' })).toBeVisible();

  // CSV as a table, and its download delivers the file.
  await node('data.csv').click();
  await expect(pane.getByRole('cell', { name: 'beta' })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    pane.getByRole('button', { name: '다운로드' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('data.csv');
  const saved = path.join(standalone.tmpHome, 'dl.csv');
  await download.saveAs(saved);
  expect(fs.readFileSync(saved, 'utf8')).toBe('name,count\nalpha,3\nbeta,5\n');

  // Hidden files on: .env is listed, opening it is refused, and its content never reaches the page.
  await explorer.getByLabel('숨김 파일').check();
  await node('.env').click();
  await expect(pane.getByRole('alert')).toContainText('민감한 파일');
  await expect(page.locator('body')).not.toContainText(SECRET);
  await expect(node('.git')).toHaveCount(0);
  await explorer.getByLabel('숨김 파일').uncheck();

  // Edit and save; 저장 waits for a change.
  await node('src').click();
  await node('main.ts').click();
  await expect(pane.getByText('export const answer = 42;')).toBeVisible();
  await pane.getByTestId('edit-switch').click();
  const editor = pane.getByTestId('code-editor').locator('.cm-content');
  await expect(editor).toBeVisible({ timeout: 20_000 });
  await expect(pane.getByTestId('edit-save')).toBeDisabled();
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(NEW_LINE);
  await expect(pane.getByTestId('edit-save')).toBeEnabled();
  await pane.getByTestId('edit-save').click();
  await expect(pane.getByTestId('edit-status')).toContainText('저장했어요', { timeout: 10_000 });
  await pane.getByTestId('edit-switch').click();
  await expect(pane.getByTestId('code-editor')).toHaveCount(0);
  await expect(pane.getByText(NEW_LINE)).toBeVisible();

  // After a reload the project is still chosen and the file holds the saved line.
  await page.reload();
  await page.locator('[data-hud-id="icon:files"] button').click();
  await expect(node('src')).toBeVisible({ timeout: 15_000 });
  if (!(await node('main.ts').isVisible())) await node('src').click();
  await node('main.ts').click();
  await expect(pane.getByText(NEW_LINE)).toBeVisible();
  await expect(pane.getByText('export const answer = 42;')).toBeVisible();
});
