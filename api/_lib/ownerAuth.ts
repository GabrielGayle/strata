/**
 * Owner check for cloud projects: the owner passphrase, or a cockpit yoga sign-in (the
 * Supabase account shared with lace and cockpit.yoga) whose email is in STRATA_OWNER_EMAILS.
 * Compared only on the server.
 */

import { timingSafeEqual } from 'node:crypto';

export class OwnerAuthError extends Error {
  status: 401 | 503;
  constructor(status: 401 | 503, message: string) {
    super(message);
    this.name = 'OwnerAuthError';
    this.status = status;
  }
}

export function configuredOwnerToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const t = env.STRATA_OWNER_TOKEN?.trim();
  return t || undefined;
}

/** Bearer token from an Authorization header. */
export function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const m = /^Bearer\s+(\S.*)$/i.exec(authorization.trim());
  const t = m?.[1]?.trim();
  return t || undefined;
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Throws 503 when the server has no owner token (cloud is not configured),
 * 401 when the request has none or the wrong one.
 */
export function assertOwner(authorization: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  const expected = configuredOwnerToken(env);
  if (!expected) {
    throw new OwnerAuthError(503, 'Cloud projects are not configured (STRATA_OWNER_TOKEN is missing).');
  }
  const given = bearerToken(authorization);
  if (!given || !sameToken(given, expected)) {
    throw new OwnerAuthError(401, 'Owner token required');
  }
}

/** The cockpit yoga project and who may use strata's cloud with it. Unset: passphrase only. */
export function cockpitConfig(env: NodeJS.ProcessEnv = process.env): { url: string; key: string; emails: string[] } | undefined {
  const url = env.VITE_SUPABASE_URL?.trim().replace(/\/+$/, '');
  const key = env.VITE_SUPABASE_ANON_KEY?.trim();
  const emails = (env.STRATA_OWNER_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return url && key && emails.length ? { url, key, emails } : undefined;
}

// a signed-in browser sends the same access token for up to an hour: ask Supabase once a minute
const seen = new Map<string, { email: string; until: number }>();
const SEEN_MS = 60_000;

/** The email behind a cockpit yoga access token, or undefined if Supabase doesn't accept it. */
async function cockpitEmail(token: string, cfg: { url: string; key: string }, f: typeof fetch): Promise<string | undefined> {
  const hit = seen.get(token);
  if (hit && hit.until > Date.now()) return hit.email;
  let res: Response;
  try {
    res = await f(`${cfg.url}/auth/v1/user`, { headers: { apikey: cfg.key, Authorization: `Bearer ${token}` } });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;
  const user = (await res.json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof user?.email === 'string' ? user.email.toLowerCase() : undefined;
  if (!email) return undefined;
  if (seen.size > 200) seen.clear();
  seen.set(token, { email, until: Date.now() + SEEN_MS });
  return email;
}

/**
 * assertOwner, or a cockpit yoga sign-in for one of STRATA_OWNER_EMAILS. Throws 503 when
 * neither is configured, 401 when the request carries neither.
 */
export async function assertOwnerOrCockpit(authorization: string | undefined, env: NodeJS.ProcessEnv = process.env, f: typeof fetch = fetch): Promise<void> {
  const cockpit = cockpitConfig(env);
  if (!cockpit) return assertOwner(authorization, env);
  const given = bearerToken(authorization);
  const expected = configuredOwnerToken(env);
  if (given && expected && sameToken(given, expected)) return;
  const email = given ? await cockpitEmail(given, cockpit, f) : undefined;
  if (email && cockpit.emails.includes(email)) return;
  throw new OwnerAuthError(401, 'Owner token or cockpit yoga sign-in required');
}
