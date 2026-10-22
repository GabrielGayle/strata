/** The owner passphrase, kept in this browser after you enter it once. */

import { cockpitToken } from './cockpitAuth';

export const OWNER_TOKEN_KEY = 'strata.owner.token';

export function readOwnerToken(ls?: Storage): string | null {
  try {
    const store = ls ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
    const v = store?.getItem(OWNER_TOKEN_KEY)?.trim();
    return v || null;
  } catch {
    return null;
  }
}

export function writeOwnerToken(token: string | null, ls?: Storage): void {
  try {
    const store = ls ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
    if (!store) return;
    if (token?.trim()) store.setItem(OWNER_TOKEN_KEY, token.trim());
    else store.removeItem(OWNER_TOKEN_KEY);
  } catch {
    /* quota / private mode */
  }
}

/** What cloud requests send: the passphrase if one is stored, else a cockpit yoga sign-in. */
export function ownerBearer(ls?: Storage): string | null {
  return readOwnerToken(ls) ?? cockpitToken();
}
