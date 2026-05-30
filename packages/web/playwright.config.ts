import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 3100);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;
const requestedWorkers = process.env.PLAYWRIGHT_WORKERS;
const parsedWorkers = requestedWorkers ? Number(requestedWorkers) : Number.NaN;
const workers = Number.isInteger(parsedWorkers) && parsedWorkers > 0 ? parsedWorkers : 1;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
  webServer: {
    command: `pnpm --filter @claimflow/web exec next dev -p ${port}`,
    url: `${baseURL}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      NEXT_PUBLIC_API_BASE_URL: 'http://127.0.0.1:8080',
    },
  },
});
