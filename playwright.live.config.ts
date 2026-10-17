import { defineConfig, devices } from '@playwright/test';
import { e2eOrigin, e2ePreviewCommand, e2eReuseExistingServer } from './playwright.env';

const origin = e2eOrigin();

function webServerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.VITE_E2E_MAP_FIXTURES;
  return env;
}

export default defineConfig({
  testDir: 'e2e',
  testMatch: /neasden-map-live\.spec\.ts$/,
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
    reuseExistingServer: e2eReuseExistingServer(),
    env: webServerEnv(),
    timeout: 300_000,
  },
});
