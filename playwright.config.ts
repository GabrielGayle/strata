import { defineConfig, devices } from '@playwright/test';
import { e2eCloudEnv, e2eOrigin, e2ePreviewCommand, e2eReuseExistingServer } from './playwright.env';

const liveNetwork = process.env.LIVE_MAP === '1' || process.env.LIVE_MAP_SCREENSHOTS === '1';
const origin = e2eOrigin();

function webServerEnv(): NodeJS.ProcessEnv {
  const env = e2eCloudEnv(process.env);
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
    baseURL: origin,
    acceptDownloads: true,
    trace: 'on-first-retry',
  },
  webServer: {
    command: e2ePreviewCommand(),
    url: origin,
    reuseExistingServer: liveNetwork ? false : e2eReuseExistingServer(),
    env: webServerEnv(),
    timeout: liveNetwork ? 300_000 : 180_000,
  },
});
