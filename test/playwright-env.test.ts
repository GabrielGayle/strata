import { describe, expect, it } from 'vitest';
import { E2E_PORT_DEFAULT, e2eCloudEnv, e2eOrigin, e2eOriginB, e2eOwnerToken, e2ePort, e2ePortB, e2ePreviewCommand, e2eProjectsDir, e2eReuseExistingServer } from '../playwright.env';

describe('Playwright e2e port and CI reuse', () => {
  it('defaults to 4173 and reuses a local fixture server only when CI is unset', () => {
    expect(e2ePort({})).toBe(E2E_PORT_DEFAULT);
    expect(e2eOrigin({})).toBe('http://127.0.0.1:4173');
    expect(e2eReuseExistingServer({})).toBe(true);
    expect(e2eReuseExistingServer({ CI: '1' })).toBe(false);
    expect(e2eReuseExistingServer({ CI: 'true' })).toBe(false);
  });

  it('reads STRATA_E2E_PORT for baseURL and the preview command', () => {
    const env = { STRATA_E2E_PORT: '4199' };
    expect(e2ePort(env)).toBe(4199);
    expect(e2eOrigin(env)).toBe('http://127.0.0.1:4199');
    expect(e2ePreviewCommand(env)).toContain('--port 4199');
    expect(e2ePreviewCommand(env)).toContain('--strictPort');
    expect(e2ePort({ STRATA_E2E_PORT: 'nope' })).toBe(E2E_PORT_DEFAULT);
  });

  it('derives the second origin, owner token and shared projects dir from the e2e port', () => {
    const env = { STRATA_E2E_PORT: '4287' };
    expect(e2ePortB(env)).toBe(4288);
    expect(e2eOriginB(env)).toBe('http://localhost:4288');
    expect(e2eOwnerToken(env)).toBe('strata-e2e-owner');
    expect(e2eOwnerToken({ STRATA_OWNER_TOKEN: 'secret' })).toBe('secret');
    expect(e2eProjectsDir(env)).toContain('strata-e2e-projects-4287');
    const cloud = e2eCloudEnv(env);
    expect(cloud.STRATA_OWNER_TOKEN).toBe('strata-e2e-owner');
    expect(cloud.STRATA_PROJECTS_DIR).toContain('strata-e2e-projects-4287');
  });
});
