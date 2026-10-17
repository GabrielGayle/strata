import { defineConfig, devices } from '@playwright/test';
import { e2eCloudEnv, e2eOrigin, e2ePreviewCommand } from './playwright.env';

const origin = e2eOrigin();

function webServerEnv(): NodeJS.ProcessEnv {
  const env = e2eCloudEnv(process.env);
  delete env.VITE_E2E_MAP_FIXTURES;
  return env;
}

export default defineConfig({
  testDir: 'e2e',
  testMatch: /(neasden-map-live|quick-map-live)\.spec\.ts$/,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'list',
  timeout: 300_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: origin,
    trace: 'on-first-retry',
  },
  webServer: {
    command: e2ePreviewCommand(),
    url: origin,
    reuseExistingServer: false,
    env: webServerEnv(),
    timeout: 300_000,
  },
});
