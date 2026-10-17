/** Owner passphrase check for cloud projects. Compared only on the server. */

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
