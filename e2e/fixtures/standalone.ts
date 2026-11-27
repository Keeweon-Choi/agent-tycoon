import fs from 'node:fs';
import path from 'node:path';

import type { TestInfo } from '@playwright/test';
import { expect, test as base } from '@playwright/test';

import { applyAllureLabels } from '../helpers/allure-labels';
import { officeFile } from '../helpers/hooks';
import {
  launchStandalone,
  type LaunchStandaloneOptions,
  PHONE,
  type StandaloneSession,
} from '../helpers/standalone';

export type StandaloneContext = StandaloneSession;

async function attachFile(
  testInfo: TestInfo,
  name: string,
  filePath: string,
  contentType: string,
): Promise<void> {
  try {
    if (fs.existsSync(filePath))
      await testInfo.attach(name, { body: fs.readFileSync(filePath, 'utf8'), contentType });
  } catch {
    // Attachment failures are non-fatal in teardown.
  }
}

export const test = base.extend<{
  standalone: StandaloneContext;
  _allureLabels: void;
  /** Per-test daemon and HOME: `test.use({ standaloneOptions: { agents: [{ name: 'alpha' }], scenarios: [...] } })`. */
  standaloneOptions: LaunchStandaloneOptions;
}>({
  standaloneOptions: [{}, { option: true }],
  // Tags every test with an Allure epic + feature from its @area: tag and describe path.
  _allureLabels: [
    async ({}, use, testInfo) => {
      await applyAllureLabels(testInfo);
      await use();
    },
    { auto: true },
  ],
  standalone: async ({ page, standaloneOptions }, use, testInfo) => {
    const standalone = await launchStandalone(page, standaloneOptions);
    try {
      await use(standalone);
    } finally {
      const log = standalone.getHostLogs();
      if (log)
        await testInfo
          .attach('daemon-log', { body: log, contentType: 'text/plain' })
          .catch(() => undefined);
      await attachFile(
        testInfo,
        'server-json',
        officeFile(standalone.tmpHome, 'server.json'),
        'application/json',
      );
      // What the engine typed into its sessions, and what the scenarios played.
      await attachFile(
        testInfo,
        'typed',
        path.join(standalone.tmpHome, 'fake-claude-typed.log'),
        'text/plain',
      );
      await attachFile(
        testInfo,
        'mock-actions',
        path.join(standalone.tmpHome, '.claude-mock', 'actions.log'),
        'text/plain',
      );
      try {
        const shot = testInfo.outputPath('final-screenshot.png');
        await page.screenshot({ path: shot });
        await testInfo.attach('final-screenshot', { path: shot, contentType: 'image/png' });
      } catch {
        // Screenshot failures are non-fatal in teardown.
      }
      await standalone.cleanup();
    }
  },
});

export { expect, PHONE };
