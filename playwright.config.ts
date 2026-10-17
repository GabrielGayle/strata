import { defineConfig, devices } from '@playwright/test';

const liveNetwork = process.env.LIVE_MAP === '1' || process.env.LIVE_MAP_SCREENSHOTS === '1';

function webServerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (liveNetwork) delete env.VITE_E2E_MAP_FIXTURES;
  else env.VITE_E2E_MAP_FIXTURES = '1';
  return env;
}

export default defineConfig({
  testDir: '.',
  testMatch: ['e2e/**/*.spec.ts', 'test/e2e/**/*.spec.ts'],
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  timeout: liveNetwork ? 300_000 : 360_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4173',
    acceptDownloads: true,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: liveNetwork ? false : !process.env.CI,
    env: webServerEnv(),
    timeout: liveNetwork ? 300_000 : 180_000,
  },
});
