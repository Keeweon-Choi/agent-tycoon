import { defineConfig } from 'vitest/config';

// Fixture timestamps are product-local Seoul time, independent of the runner's zone.
process.env.TZ = 'Asia/Seoul';
process.env['ALLURE_LABEL_epic'] ??= 'server';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10_000,
    // ponytail: on a hosted CI runner (CI=true) a failed test gets two more tries: with 4,200 tests, one
    // that leans on timing fails there every other run (rc.7: three different ones in four runs). The
    // local merge gate has no CI variable and stays strict, so a flake is still seen where it gets fixed;
    // drop this once those waits are deterministic.
    retry: process.env.CI ? 2 : 0,
    include: ['__tests__/**/*.test.ts', 'src/**/*.test.ts'],
    // T-87: the run's HOME is a fresh temp dir, never the real one.
    globalSetup: ['../scripts/vitest-temp-home.mjs'],
    setupFiles: ['allure-vitest/setup'],
    reporters: [
      'default',
      [
        'allure-vitest/reporter',
        {
          resultsDir: '../allure-results/server',
        },
      ],
    ],
  },
});
