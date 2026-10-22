/**
 * cockpit yoga sign-in: the account shared with lace and cockpit.yoga (one Supabase
 * project). The session is a cookie named `cockpit-auth`; on cockpit.yoga and its
 * subdomains it sits on `.cockpit.yoga`, so signing in on cockpit.yoga/account signs you in
 * here too. Keep the cookie name and domain rule the same as the other tools.
 *
 * Off (and never loaded) unless VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set. The
 * server decides whether the account may use the cloud (STRATA_OWNER_EMAILS); this only
 * holds the token to send.
 */

export const COCKPIT_COOKIE = 'cockpit-auth';
export const COCKPIT_DOMAIN = 'cockpit.yoga';
export const COCKPIT_ACCOUNT_URL = `https://${COCKPIT_DOMAIN}/account`;

const url = (import.meta.env?.VITE_SUPABASE_URL as string | undefined)?.trim() ?? '';
const key = (import.meta.env?.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ?? '';
export const cockpitConfigured = !!(url && key);

export interface CockpitSession {
  token: string;
  email: string;
}

let session: CockpitSession | null = null;
const listeners = new Set<() => void>();
let signOutImpl: (() => Promise<unknown>) | null = null;

export const getCockpitSession = (): CockpitSession | null => session;
/** The access token to send as the bearer, while signed in. */
export const cockpitToken = (): string | null => session?.token ?? null;

export function subscribeCockpit(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setCockpitSession(next: CockpitSession | null): void {
  if (next?.token === session?.token) return;
  session = next;
  for (const fn of listeners) fn();
}

/** `.cockpit.yoga` on the site and its subdomains, else the page's own host. */
export function cookieDomain(host: string): string | undefined {
  return host === COCKPIT_DOMAIN || host.endsWith(`.${COCKPIT_DOMAIN}`) ? `.${COCKPIT_DOMAIN}` : undefined;
}

/** Where "Sign in with cockpit yoga" goes: the site's account page, then back here. */
export function cockpitSignInUrl(here: string): string {
  return `${COCKPIT_ACCOUNT_URL}?next=${encodeURIComponent(here)}`;
}

export async function cockpitSignOut(): Promise<void> {
  await signOutImpl?.();
  setCockpitSession(null);
}

/** Read the shared session (and follow its refreshes). A no-op when not configured. */
export async function startCockpitAuth(): Promise<void> {
  if (!cockpitConfigured || typeof window === 'undefined') return;
  try {
    const { createBrowserClient } = await import('@supabase/ssr');
    const sb = createBrowserClient(url, key, {
      cookieOptions: { name: COCKPIT_COOKIE, domain: cookieDomain(location.hostname), path: '/', sameSite: 'lax', secure: location.protocol === 'https:' },
      // strata never handles the emailed link itself: cockpit.yoga/account does
      auth: { detectSessionInUrl: false },
    });
    signOutImpl = () => sb.auth.signOut();
    const toSession = (s: { access_token: string; user: { email?: string } } | null) => (s ? { token: s.access_token, email: s.user.email ?? '' } : null);
    const { data } = await sb.auth.getSession();
    setCockpitSession(toSession(data.session));
    sb.auth.onAuthStateChange((_event, s) => setCockpitSession(toSession(s)));
  } catch (e) {
    console.warn('cockpit yoga sign-in unavailable', e);
  }
}
