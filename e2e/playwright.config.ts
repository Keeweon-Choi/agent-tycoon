import { defineConfig } from '@playwright/test';
import path from 'path';

import { namespaceE2EPath } from './run-config';

process.env['ALLURE_LABEL_epic'] ??= 'e2e';

const artifactsDir = namespaceE2EPath(path.join(__dirname, '../test-results/e2e'));
const allureResultsDir = namespaceE2EPath(path.join(__dirname, '../allure-results/e2e'));
const htmlReportDir = namespaceE2EPath(path.join(__dirname, '../playwright-report/e2e'));

export default defineConfig({
  testDir: path.join(__dirname, 'tests'),
  timeout: 120_000,
  globalSetup: path.join(__dirname, 'global-setup.ts'),
  reporter: [
    ['list'],
    [
      'html',
      {
        // Must be outside outputDir to avoid Playwright clearing artifacts
        outputFolder: htmlReportDir,
        open: 'never',
      },
    ],
    [
      'allure-playwright',
      {
        resultsDir: allureResultsDir,
      },
    ],
  ],
  outputDir: artifactsDir,
  // Browser-context settings: `video` records every test's `page`.
  use: {
    video: 'on',
    // The screens' Korean names are the selectors (the runners' helpers match them).
    locale: 'ko-KR',
    // Headless chromium without a GPU: CI runners have none, and the dev PC's GPU path skews timings.
    launchOptions: { args: ['--disable-gpu'] },
  },
  // Default to one worker locally; CI can override this with --workers.
  workers: 1,
  // Shard distribution at test level (not file level), so shards stay balanced.
  // fullyParallel: tests are distributed individually.
  // workers=1 still keeps tests sequential within a shard; only the shard
  // assignment strategy changes.
  fullyParallel: true,
  // Retry once for tests that are sensitive to ordering / load (timing-driven
  // assertions about hook + file-watcher races). Tests that pass in isolation
  // but flake under serial load see this; the retry hides true flakes while
  // still surfacing genuinely broken tests.
  retries: 1,
});
