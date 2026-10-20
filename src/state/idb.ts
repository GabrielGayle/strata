// One IndexedDB connection, reopened when the browser closes it. Browsers
// close idle connections (Safari after a tab sleeps, any browser when site
// data is cleared or another tab upgrades the database); a cached handle
// then throws "The database connection is closing" on every transaction.

/** True for the error a transaction on a closed or closing connection throws. */
export function isClosedDbError(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'InvalidStateError';
}

/**
 * Wraps an opener so every call shares one connection, drops it when the
 * browser closes it (or a newer tab upgrades the database), forgets a failed
 * open, and retries a call once on a fresh connection if the old one closed
 * under it. Calls must be safe to repeat (puts and deletes are).
 */
export function reopeningDb(openDb: () => Promise<IDBDatabase>) {
  let db: Promise<IDBDatabase> | null = null;
  const forget = (p: Promise<IDBDatabase>) => {
    if (db === p) db = null;
  };
  const get = (): Promise<IDBDatabase> => {
    if (db) return db;
    const p: Promise<IDBDatabase> = openDb().then((d) => {
      d.onclose = () => forget(p);
      d.onversionchange = () => {
        d.close();
        forget(p);
      };
      return d;
    });
    p.catch(() => forget(p));
    return (db = p);
  };
  return async function withDb<T>(fn: (d: IDBDatabase) => Promise<T>): Promise<T> {
    const p = get();
    try {
      return await fn(await p);
    } catch (e) {
      if (!isClosedDbError(e)) throw e;
      forget(p);
      return fn(await get());
    }
  };
}
