import { defineConfig } from 'vitest/config';

// Fixture timestamps are product-local Seoul time, independent of the runner's zone.
process.env.TZ = 'Asia/Seoul';
process.env['ALLURE_LABEL_epic'] ??= 'server';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 10_000,
    include: ['__tests__/**/*.test.ts', 'src/**/*.test.ts'],
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
