import { describe, expect, it } from 'vitest';
import { handleProjectsApi } from '../api/_lib/projectsApi';
import { memoryProjectStore } from '../api/_lib/projectStore';
import { cockpitConfig } from '../api/_lib/ownerAuth';
import { cookieDomain, cockpitSignInUrl, setCockpitSession } from '../src/state/cockpitAuth';
import { ownerBearer } from '../src/state/ownerToken';

const env = {
  STRATA_OWNER_TOKEN: 'owner-secret',
  VITE_SUPABASE_URL: 'https://cockpit.supabase.co/',
  VITE_SUPABASE_ANON_KEY: 'anon',
  STRATA_OWNER_EMAILS: 'Gabriel@Example.com, other@example.com',
};

/** A stand-in for Supabase's /auth/v1/user: two known tokens. */
function supabase() {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    const auth = new Headers(init?.headers).get('Authorization');
    const email = auth === 'Bearer jwt-gabriel' ? 'gabriel@example.com' : auth === 'Bearer jwt-stranger' ? 'stranger@example.com' : null;
    return email ? new Response(JSON.stringify({ email }), { status: 200 }) : new Response('{}', { status: 401 });
  }) as typeof fetch;
  return { f, calls };
}

const list = (authorization: string | undefined, deps: { env: NodeJS.ProcessEnv; fetch?: typeof fetch }) =>
  handleProjectsApi({ method: 'GET', authorization }, { store: memoryProjectStore(), ...deps });

describe('cockpit yoga sign-in on the server', () => {
  it('needs the project url, anon key and at least one owner email', () => {
    expect(cockpitConfig(env)).toEqual({ url: 'https://cockpit.supabase.co', key: 'anon', emails: ['gabriel@example.com', 'other@example.com'] });
    expect(cockpitConfig({ ...env, STRATA_OWNER_EMAILS: ' ' })).toBeUndefined();
  });

  it('lets an owner email in, keeps other accounts and bad tokens out', async () => {
    const { f, calls } = supabase();
    expect((await list('Bearer jwt-gabriel', { env, fetch: f })).status).toBe(200);
    expect(calls[0]).toBe('https://cockpit.supabase.co/auth/v1/user');
    expect((await list('Bearer jwt-stranger', { env, fetch: f })).status).toBe(401);
    expect((await list('Bearer forged', { env, fetch: f })).status).toBe(401);
    expect((await list(undefined, { env, fetch: f })).status).toBe(401);
  });

  it('asks Supabase once a minute per token, not on every request', async () => {
    const { f, calls } = supabase();
    await list('Bearer jwt-gabriel', { env, fetch: f });
    await list('Bearer jwt-gabriel', { env, fetch: f });
    expect(calls.length).toBeLessThanOrEqual(1);
  });

  it('still takes the passphrase, without asking Supabase', async () => {
    const { f, calls } = supabase();
    expect((await list('Bearer owner-secret', { env, fetch: f })).status).toBe(200);
    expect(calls).toEqual([]);
  });

  it('works with only the cockpit sign-in configured, and says 503 with neither', async () => {
    const { f } = supabase();
    const { STRATA_OWNER_TOKEN: _, ...cockpitOnly } = env;
    expect((await list('Bearer jwt-gabriel', { env: cockpitOnly, fetch: f })).status).toBe(200);
    expect((await list('Bearer jwt-gabriel', { env: {}, fetch: f })).status).toBe(503);
  });
});

describe('cockpit yoga sign-in in the browser', () => {
  it('shares the session across cockpit.yoga and its subdomains only', () => {
    expect(cookieDomain('strata.cockpit.yoga')).toBe('.cockpit.yoga');
    expect(cookieDomain('cockpit.yoga')).toBe('.cockpit.yoga');
    expect(cookieDomain('strata-git-main.vercel.app')).toBeUndefined();
    expect(cookieDomain('notcockpit.yoga')).toBeUndefined();
  });

  it('sends the passphrase when there is one, else the cockpit token', () => {
    const ls = new Map<string, string>();
    const storage = { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, v), removeItem: (k: string) => void ls.delete(k) } as unknown as Storage;
    expect(ownerBearer(storage)).toBeNull();
    setCockpitSession({ token: 'jwt-gabriel', email: 'gabriel@example.com' });
    expect(ownerBearer(storage)).toBe('jwt-gabriel');
    ls.set('strata.owner.token', 'owner-secret');
    expect(ownerBearer(storage)).toBe('owner-secret');
    setCockpitSession(null);
  });

  it('signs in on cockpit.yoga and comes back', () => {
    expect(cockpitSignInUrl('https://strata.cockpit.yoga/?x=1')).toBe('https://cockpit.yoga/account?next=https%3A%2F%2Fstrata.cockpit.yoga%2F%3Fx%3D1');
  });
});
