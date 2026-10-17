/** Shared Playwright webServer / baseURL settings for fixture and live e2e. */

export const E2E_PORT_DEFAULT = 4173;

export function e2ePort(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.STRATA_E2E_PORT);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : E2E_PORT_DEFAULT;
}

export function e2eOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return `http://127.0.0.1:${e2ePort(env)}`;
}

/** Never reuse a leftover preview on CI — it may be another branch or a dummy on 4173. */
export function e2eReuseExistingServer(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.CI;
}

export function e2ePreviewCommand(env: NodeJS.ProcessEnv = process.env): string {
  const port = e2ePort(env);
  return `npm run build && npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`;
}
