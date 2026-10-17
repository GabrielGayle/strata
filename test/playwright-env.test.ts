import { describe, expect, it } from 'vitest';
import { E2E_PORT_DEFAULT, e2eOrigin, e2ePort, e2ePreviewCommand, e2eReuseExistingServer } from '../playwright.env';

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
});
