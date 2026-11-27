/**
 * T-99 flow 15: Agent Tycoon is on this PC before Claude Code. The plain office says how to install it;
 * 다시 찾기 answers "not yet" until it is installed, then the daemon ends itself to restart (the test plays
 * the service manager that starts it again) and the page comes back as the full office by itself.
 * Selectors and the restart trick: agent-tycoon/test/run-agent-cli.ts.
 */
import fs from 'node:fs';
import path from 'node:path';

import { FAKE_CLAUDE } from '../../../server/src/agent-tycoon/testHome';
import { expect, test } from '../../fixtures/standalone';

/** The daemon's exit code that asks its supervisor for a restart (AGENT_CLI_RESTART_EXIT_CODE). */
const RESTART_EXIT_CODE = 75;

test.use({ standaloneOptions: { noClaude: true, env: { AGTY_TEST_RESTART: 'exit' } } });

test('without Claude Code the office says how to install it and picks it up once installed @area:office', async ({
  page,
  standalone,
}) => {
  const notice = page.getByTestId('agent-cli-notice');
  const menu = page.getByTestId('hud-menu');
  const dockMessenger = page
    .locator('[data-hud-id^="icon:"]')
    .getByRole('button', { name: /^메신저/ });

  // The plain office: the notice with this OS's install command, and no HUD.
  await expect(notice).toBeVisible({ timeout: 20_000 });
  await expect(notice).toContainText('에이전트 CLI(Claude Code)를 설치해 주세요');
  await expect(page.getByTestId('agent-cli-command-claude')).toContainText(
    process.platform === 'win32' ? 'https://claude.ai/install.ps1' : 'https://claude.ai/install.sh',
  );
  await expect(menu).toHaveCount(0);
  await expect(dockMessenger).toHaveCount(0);

  // 다시 찾기 with nothing installed: not yet, and the office stays as it is.
  const again = notice.getByRole('button', { name: '다시 찾기' });
  await again.click();
  await expect(notice.getByTestId('agent-cli-still')).toHaveText(/아직 설치되지 않았어요/, {
    timeout: 15_000,
  });
  await expect(notice).toHaveAttribute('data-state', 'missing');

  // "Install" Claude Code where its installer puts it (not on the daemon's PATH): the engine fake.
  const localBin = path.join(standalone.tmpHome, '.local', 'bin');
  fs.mkdirSync(localBin, { recursive: true });
  const claude = path.join(localBin, 'claude');
  fs.writeFileSync(
    claude,
    `#!/bin/sh\nexec "${process.execPath}" "${fs.realpathSync(path.join(FAKE_CLAUDE, 'engine.cjs'))}" "$@"\n`,
  );
  fs.chmodSync(claude, 0o755);

  const exited = standalone.hostExit();
  await again.click();
  await expect(notice).toContainText('다시 시작하는 중', { timeout: 15_000 });
  expect(await exited).toBe(RESTART_EXIT_CODE);
  await standalone.startHost(); // the service manager

  // The page reconnects by itself into the full office; the notice is gone.
  await expect(menu).toBeVisible({ timeout: 30_000 });
  await expect(dockMessenger).toBeVisible();
  await expect(notice).toHaveCount(0);
  await expect(page.getByTestId('agent-cli-bar')).toHaveCount(0);
});
