import { describe, expect, it } from 'vitest';
import { reopeningDb } from '../src/state/idb';

function closing() {
  return Object.assign(new Error("Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing."), { name: 'InvalidStateError' });
}

// A stand-in connection: `open` flips to false when the browser closes it.
function fakeDb(n: number) {
  const d = { n, open: true, onclose: null as null | (() => void), onversionchange: null as null | (() => void), close: () => void (d.open = false) };
  return d;
}

describe('reopeningDb', () => {
  it('reopens and retries once when the cached connection has closed', async () => {
    const made: ReturnType<typeof fakeDb>[] = [];
    const withDb = reopeningDb(async () => {
      const d = fakeDb(made.length + 1);
      made.push(d);
      return d as unknown as IDBDatabase;
    });
    const read = () =>
      withDb(async (d) => {
        const f = d as unknown as ReturnType<typeof fakeDb>;
        if (!f.open) throw closing();
        return f.n;
      });
    expect(await read()).toBe(1);
    made[0].open = false; // closed without telling us (no close event)
    expect(await read()).toBe(2);
    expect(await read()).toBe(2);
    made[1].close();
    made[1].onclose?.(); // the browser's close event drops it straight away
    expect(await read()).toBe(3);
    made[2].onversionchange?.(); // another tab upgrading: let go
    expect(made[2].open).toBe(false);
    expect(await read()).toBe(4);
  });

  it('forgets a failed open and passes other errors through', async () => {
    let tries = 0;
    const withDb = reopeningDb(async () => {
      if (++tries === 1) throw new Error('blocked');
      return fakeDb(tries) as unknown as IDBDatabase;
    });
    await expect(withDb(async () => 1)).rejects.toThrow('blocked');
    expect(await withDb(async () => 2)).toBe(2);
    await expect(
      withDb(async () => {
        throw new Error('quota');
      }),
    ).rejects.toThrow('quota');
    expect(tries).toBe(2);
  });
});
