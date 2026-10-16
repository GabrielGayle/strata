import { defineConfig, devices } from '@playwright/test';

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
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    env: webServerEnv(),
    timeout: 300_000,
  },
});
