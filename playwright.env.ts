/** Shared Playwright webServer / baseURL settings for fixture and live e2e. */

import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const E2E_PORT_DEFAULT = 4173;

export function e2ePort(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.STRATA_E2E_PORT);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : E2E_PORT_DEFAULT;
}

export function e2eOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return `http://127.0.0.1:${e2ePort(env)}`;
}

/** Second origin for cloud-library cross-origin tests (hostname localhost, different port). */
export function e2ePortB(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.STRATA_E2E_PORT_B);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : e2ePort(env) + 1;
}

export function e2eOriginB(env: NodeJS.ProcessEnv = process.env): string {
  return `http://localhost:${e2ePortB(env)}`;
}

export function e2eOwnerToken(env: NodeJS.ProcessEnv = process.env): string {
  return env.STRATA_OWNER_TOKEN?.trim() || 'strata-e2e-owner';
}

export function e2eProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.STRATA_PROJECTS_DIR?.trim() || join(tmpdir(), `strata-e2e-projects-${e2ePort(env)}`);
}

export function e2eCloudEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    STRATA_OWNER_TOKEN: e2eOwnerToken(env),
    STRATA_PROJECTS_DIR: e2eProjectsDir(env),
  };
}

/** Never reuse a leftover preview on CI — it may be another branch or a dummy on 4173. */
export function e2eReuseExistingServer(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.CI;
}

export function e2ePreviewCommand(env: NodeJS.ProcessEnv = process.env): string {
  const port = e2ePort(env);
  return `npm run build && npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`;
}

export function e2ePreviewCommandB(env: NodeJS.ProcessEnv = process.env): string {
  const port = e2ePortB(env);
  return `npm run preview -- --host localhost --port ${port} --strictPort`;
}
