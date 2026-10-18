// Point lists as flat arrays. Outlines are arrays of [x, y] pairs, which are slow
// to copy between threads (or into browser storage) one small array at a time;
// they cross as one Float64Array each (exact, no rounding).

const PTS = '__strataPoints';
const packedLists = new WeakMap<object, unknown>();

export const isPlainObject = (x: unknown): x is Record<string, unknown> => {
  if (typeof x !== 'object' || x === null || Array.isArray(x) || ArrayBuffer.isView(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
};

const isPointList = (a: unknown[]) => {
  if (a.length < 2) return false;
  for (const p of a) if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number') return false;
  return true;
};

/** Swaps every list of [x, y] pairs in `x` for a flat array. Unchanged values pack to the same object every time. */
export function packPoints<T>(x: T): T {
  const pack = (v: unknown): unknown => {
    if (typeof v !== 'object' || v === null || ArrayBuffer.isView(v)) return v;
    if (packedLists.has(v)) return packedLists.get(v);
    let out: unknown = v;
    if (Array.isArray(v)) {
      if (isPointList(v)) {
        const flat = new Float64Array(v.length * 2);
        v.forEach((p, i) => ((flat[i * 2] = p[0]), (flat[i * 2 + 1] = p[1])));
        out = { [PTS]: flat };
      } else {
        const m = v.map(pack);
        if (m.some((e, i) => e !== v[i])) out = m;
      }
    } else if (isPlainObject(v)) {
      let o: Record<string, unknown> | null = null;
      for (const [k, e] of Object.entries(v)) {
        const pe = pack(e);
        if (pe !== e) (o ??= { ...v })[k] = pe;
      }
      if (o) out = o;
    }
    packedLists.set(v, out);
    return out;
  };
  return pack(x) as T;
}

/** Turns the flat arrays back into [x, y] lists, in place (the value is fresh off the wire). */
export function unpackPoints(x: unknown, done: Map<object, unknown> = new Map()): unknown {
  if (typeof x !== 'object' || x === null || ArrayBuffer.isView(x)) return x;
  if (done.has(x)) return done.get(x);
  if (isPlainObject(x) && PTS in x) {
    const flat = x[PTS] as Float64Array;
    const pts: [number, number][] = new Array(flat.length / 2);
    for (let i = 0; i < pts.length; i++) pts[i] = [flat[i * 2], flat[i * 2 + 1]];
    done.set(x, pts);
    return pts;
  }
  done.set(x, x);
  if (Array.isArray(x)) for (let i = 0; i < x.length; i++) x[i] = unpackPoints(x[i], done);
  else if (isPlainObject(x)) for (const k of Object.keys(x)) x[k] = unpackPoints(x[k], done);
  return x;
}
