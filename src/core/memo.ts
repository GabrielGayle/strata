// Small caching helpers for the regeneration pipeline. Both are exact: they
// only ever hand back a result that is equal to what would be recomputed.

const caches = new WeakMap<object, Map<string, unknown>>();
const MAX_ENTRIES = 256;

/**
 * Memoise `fn` by an owner object (an image, a mesh, a shape) plus a string of
 * the plain values it depends on. Entries die with their owner; each owner keeps
 * at most MAX_ENTRIES results, oldest dropped first.
 */
export function cached<T>(owner: object, key: string, fn: () => T): T {
  let m = caches.get(owner);
  if (!m) caches.set(owner, (m = new Map()));
  if (m.has(key)) return m.get(key) as T;
  const value = fn();
  if (m.size >= MAX_ENTRIES) m.delete(m.keys().next().value!);
  m.set(key, value);
  return value;
}

const same = (a: unknown, b: unknown) => a === b || (a !== a && b !== b); // NaN-safe

/**
 * Structural sharing: returns `next`, except that every sub-object deeply equal
 * to its counterpart in `prev` is replaced by that counterpart (and `prev`
 * itself comes back when nothing changed). Downstream stages and React memos
 * that compare by identity then skip work for anything that did not change.
 * Only plain data (objects, arrays, typed arrays, primitives) is compared.
 */
export function share<T>(prev: T | undefined, next: T): T {
  return prev === undefined ? next : (merge(prev, next) as T);
}

function merge(a: any, b: any): any {
  if (same(a, b)) return a;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return b;
    // copy-on-write: `next` is only copied when some of it can be swapped for `prev`
    let out: any[] | null = null;
    let all = a.length === b.length;
    for (let i = 0; i < b.length; i++) {
      const m = i < a.length ? merge(a[i], b[i]) : b[i];
      if (m !== a[i]) all = false;
      if (m !== b[i]) (out ??= b.slice())[i] = m;
    }
    return all ? a : (out ?? b);
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    const x = a as unknown as ArrayLike<number>, y = b as unknown as ArrayLike<number>;
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.constructor !== b.constructor || x.length !== y.length) return b;
    for (let i = 0; i < x.length; i++) if (!same(x[i], y[i])) return b;
    return a;
  }
  const pa = Object.getPrototypeOf(a);
  if (pa !== Object.getPrototypeOf(b) || (pa !== Object.prototype && pa !== null)) return b; // class instances: identity only
  const kb = Object.keys(b);
  let out: any = null;
  let all = Object.keys(a).length === kb.length;
  for (const k of kb) {
    const m = k in a ? merge(a[k], b[k]) : b[k];
    if (m !== a[k] || !(k in a)) all = false;
    if (m !== b[k]) (out ??= { ...b })[k] = m;
  }
  return all ? a : (out ?? b);
}
