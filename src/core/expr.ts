// Small, safe expression language for parameters.
// Supports numbers, identifiers, + - * / % ^, unary -, comparisons,
// ternary (a ? b : c), parentheses and a fixed set of functions.

export type Node =
  | { t: 'num'; v: number }
  | { t: 'id'; name: string }
  | { t: 'un'; op: string; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'tern'; c: Node; a: Node; b: Node }
  | { t: 'call'; name: string; args: Node[] };

const FUNCS: Record<string, (...a: number[]) => number> = {
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  abs: Math.abs,
  sqrt: Math.sqrt,
  sin: (d) => Math.sin((d * Math.PI) / 180),
  cos: (d) => Math.cos((d * Math.PI) / 180),
  tan: (d) => Math.tan((d * Math.PI) / 180),
  atan: (x) => (Math.atan(x) * 180) / Math.PI,
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  clamp: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
  lerp: (a, b, t) => a + (b - a) * t,
  pow: Math.pow,
  log: Math.log,
  exp: Math.exp,
};

const CONSTS: Record<string, number> = { pi: Math.PI, PI: Math.PI, e: Math.E };

export const FUNCTION_NAMES = Object.keys(FUNCS);

type Tok = { k: 'num' | 'id' | 'op'; v: string; pos: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n') {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i));
      if (!m) throw new Error(`Bad number at ${i}`);
      out.push({ k: 'num', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ k: 'id', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '==', '!=', '&&', '||'].includes(two)) {
      out.push({ k: 'op', v: two, pos: i });
      i += 2;
      continue;
    }
    if ('+-*/%^()<>?:,!'.includes(c)) {
      out.push({ k: 'op', v: c, pos: i });
      i++;
      continue;
    }
    throw new Error(`Unexpected '${c}' at ${i}`);
  }
  return out;
}

export function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => toks[p]?.k === 'op' && toks[p].v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`Expected '${v}'`);
    p++;
  };

  function ternary(): Node {
    const c = or();
    if (isOp('?')) {
      p++;
      const a = ternary();
      expect(':');
      const b = ternary();
      return { t: 'tern', c, a, b };
    }
    return c;
  }
  function binLevel(ops: string[], next: () => Node): () => Node {
    return () => {
      let a = next();
      while (peek()?.k === 'op' && ops.includes(peek().v)) {
        const op = toks[p++].v;
        a = { t: 'bin', op, a, b: next() };
      }
      return a;
    };
  }
  const unary = (): Node => {
    if (isOp('-') || isOp('+') || isOp('!')) {
      const op = toks[p++].v;
      return { t: 'un', op, a: unary() };
    }
    return power();
  };
  function power(): Node {
    const a = atom();
    if (isOp('^')) {
      p++;
      return { t: 'bin', op: '^', a, b: unary() };
    }
    return a;
  }
  const mul = binLevel(['*', '/', '%'], unary);
  const add = binLevel(['+', '-'], mul);
  const cmp = binLevel(['<', '>', '<=', '>=', '==', '!='], add);
  const and = binLevel(['&&'], cmp);
  const or = binLevel(['||'], and);

  function atom(): Node {
    const t = peek();
    if (!t) throw new Error('Unexpected end');
    if (t.k === 'num') {
      p++;
      return { t: 'num', v: parseFloat(t.v) };
    }
    if (t.k === 'id') {
      p++;
      if (isOp('(')) {
        p++;
        const args: Node[] = [];
        if (!isOp(')')) {
          args.push(ternary());
          while (isOp(',')) {
            p++;
            args.push(ternary());
          }
        }
        expect(')');
        if (!FUNCS[t.v]) throw new Error(`Unknown function '${t.v}'`);
        return { t: 'call', name: t.v, args };
      }
      return { t: 'id', name: t.v };
    }
    if (isOp('(')) {
      p++;
      const e = ternary();
      expect(')');
      return e;
    }
    throw new Error(`Unexpected '${t.v}'`);
  }

  if (toks.length === 0) throw new Error('Empty expression');
  const n = ternary();
  if (p < toks.length) throw new Error(`Unexpected '${toks[p].v}'`);
  return n;
}

export function identifiers(n: Node, out = new Set<string>()): Set<string> {
  switch (n.t) {
    case 'id':
      if (!(n.name in CONSTS)) out.add(n.name);
      break;
    case 'un':
      identifiers(n.a, out);
      break;
    case 'bin':
      identifiers(n.a, out);
      identifiers(n.b, out);
      break;
    case 'tern':
      identifiers(n.c, out);
      identifiers(n.a, out);
      identifiers(n.b, out);
      break;
    case 'call':
      n.args.forEach((a) => identifiers(a, out));
      break;
  }
  return out;
}

export function evaluate(n: Node, scope: Record<string, number>): number {
  switch (n.t) {
    case 'num':
      return n.v;
    case 'id': {
      if (n.name in CONSTS) return CONSTS[n.name];
      const v = scope[n.name];
      if (v === undefined) throw new Error(`Unknown name '${n.name}'`);
      return v;
    }
    case 'un': {
      const a = evaluate(n.a, scope);
      return n.op === '-' ? -a : n.op === '!' ? (a ? 0 : 1) : a;
    }
    case 'bin': {
      const a = evaluate(n.a, scope);
      const b = evaluate(n.b, scope);
      switch (n.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return a / b;
        case '%': return a % b;
        case '^': return Math.pow(a, b);
        case '<': return a < b ? 1 : 0;
        case '>': return a > b ? 1 : 0;
        case '<=': return a <= b ? 1 : 0;
        case '>=': return a >= b ? 1 : 0;
        case '==': return a === b ? 1 : 0;
        case '!=': return a !== b ? 1 : 0;
        case '&&': return a && b ? 1 : 0;
        case '||': return a || b ? 1 : 0;
      }
      throw new Error(`Bad op ${n.op}`);
    }
    case 'tern':
      return evaluate(n.c, scope) ? evaluate(n.a, scope) : evaluate(n.b, scope);
    case 'call':
      return FUNCS[n.name](...n.args.map((a) => evaluate(a, scope)));
  }
}

/** True if the source is a plain numeric literal (so it can be driven by a slider). */
export function isLiteral(src: string): boolean {
  return /^\s*-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(src);
}
