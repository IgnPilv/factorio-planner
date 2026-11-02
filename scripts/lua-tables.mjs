// A tolerant reader for the Lua prototype files in wube/factorio-data.
// It never executes Lua. It tokenizes the source, evaluates literal values
// (numbers, strings, tables, simple arithmetic and string concatenation, and
// top-level `local` constants), and returns every table that has string
// `type` and `name` fields. Anything it cannot evaluate becomes `undefined`.

const KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in',
  'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while',
]);

export function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if (src.startsWith('--', i)) {
      const m = /^--\[(=*)\[/.exec(src.slice(i, i + 20));
      if (m) {
        const close = ']' + m[1] + ']';
        const end = src.indexOf(close, i);
        i = end < 0 ? n : end + close.length;
      } else {
        const end = src.indexOf('\n', i);
        i = end < 0 ? n : end + 1;
      }
      continue;
    }
    const longStr = /^\[(=*)\[/.exec(src.slice(i, i + 20));
    if (longStr) {
      const close = ']' + longStr[1] + ']';
      const start = i + longStr[0].length;
      const end = src.indexOf(close, start);
      toks.push({ t: 'str', v: src.slice(start, end < 0 ? n : end) });
      i = end < 0 ? n : end + close.length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') {
          const e = src[j + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          j += 2;
        } else s += src[j++];
      }
      toks.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    const num = /^(0x[0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/.exec(src.slice(i, i + 40));
    if (num && /[0-9.]/.test(c) && !(c === '.' && !/\d/.test(src[i + 1]))) {
      toks.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i, i + 200));
    if (id) {
      toks.push({ t: KEYWORDS.has(id[0]) ? 'kw' : 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    const op = ['...', '..', '==', '~=', '<=', '>=', '//', '::'].find((o) => src.startsWith(o, i));
    if (op) { toks.push({ t: 'op', v: op }); i += op.length; continue; }
    toks.push({ t: 'op', v: c });
    i++;
  }
  return toks;
}

const OPEN = { '{': '}', '(': ')', '[': ']' };

class Reader {
  constructor(toks, env, untyped = false) {
    this.untyped = untyped;
    this.toks = toks;
    this.p = 0;
    this.env = env;
    this.found = [];
  }
  peek(o = 0) { return this.toks[this.p + o]; }
  is(v, o = 0) { const t = this.peek(o); return t && t.t === 'op' && t.v === v; }

  // Skip one balanced group starting at an opening bracket.
  skipGroup() {
    const open = this.peek().v;
    const close = OPEN[open];
    let depth = 0;
    while (this.p < this.toks.length) {
      const t = this.toks[this.p++];
      if (t.t === 'op' && t.v === open) depth++;
      else if (t.t === 'op' && t.v === close) { depth--; if (depth === 0) return; }
    }
  }

  // Parse a table constructor at the current `{`.
  parseTable() {
    this.p++; // {
    const obj = {};
    const arr = [];
    let hasKeys = false;
    while (this.p < this.toks.length && !this.is('}')) {
      if (this.is('[')) {
        // [expr] = value
        this.p++;
        const key = this.parseExpr();
        if (this.is(']')) this.p++;
        if (this.is('=')) this.p++;
        const val = this.parseExpr();
        if (key !== undefined) { obj[key] = val; hasKeys = true; }
      } else if (this.peek().t === 'id' && this.is('=', 1)) {
        const key = this.peek().v;
        this.p += 2;
        obj[key] = this.parseExpr();
        hasKeys = true;
      } else {
        arr.push(this.parseExpr());
      }
      if (this.is(',') || this.is(';')) this.p++;
      else if (!this.is('}')) this.skipTo([',', ';', '}']);
    }
    this.p++; // }
    let result;
    if (!hasKeys) result = arr;
    else {
      arr.forEach((v, i) => { obj[i + 1] = v; });
      result = obj;
    }
    if (hasKeys && typeof obj.name === 'string' && (typeof obj.type === 'string' || this.untyped)) this.found.push(obj);
    return result;
  }

  skipTo(stops) {
    while (this.p < this.toks.length) {
      const t = this.peek();
      if (t.t === 'op' && stops.includes(t.v)) return;
      if (t.t === 'op' && OPEN[t.v]) {
        if (t.v === '{') this.parseTable(); else this.skipGroup();
      } else this.p++;
    }
  }

  // Expression: a sequence of operands joined by binary operators.
  // Returns a value when every piece is known, otherwise undefined.
  parseExpr() {
    let parts = [];
    let ok = true;
    for (;;) {
      const v = this.parseOperand();
      if (v === UNKNOWN) ok = false;
      parts.push(v);
      const t = this.peek();
      if (t && ((t.t === 'op' && ['+', '-', '*', '/', '..', '^', '%', '==', '~=', '<', '>', '<=', '>=', '//'].includes(t.v)) || (t.t === 'kw' && (t.v === 'and' || t.v === 'or')))) {
        parts.push(t.v);
        this.p++;
        continue;
      }
      break;
    }
    if (!ok) return undefined;
    return evalParts(parts);
  }

  parseOperand() {
    const t = this.peek();
    if (!t) return UNKNOWN;
    if (t.t === 'op' && t.v === '-') { this.p++; const v = this.parseOperand(); return typeof v === 'number' ? -v : UNKNOWN; }
    if (t.t === 'kw' && t.v === 'not') { this.p++; this.parseOperand(); return UNKNOWN; }
    if (t.t === 'op' && t.v === '#') { this.p++; this.parseOperand(); return UNKNOWN; }
    let val;
    if (t.t === 'num' || t.t === 'str') { this.p++; val = t.v; }
    else if (t.t === 'kw' && (t.v === 'true' || t.v === 'false')) { this.p++; val = t.v === 'true'; }
    else if (t.t === 'kw' && t.v === 'nil') { this.p++; val = undefined; }
    else if (t.t === 'op' && t.v === '{') { val = this.parseTable(); }
    else if (t.t === 'op' && t.v === '(') {
      this.p++;
      val = this.parseExpr();
      if (this.is(')')) this.p++; else { this.skipTo([')']); this.p++; val = UNKNOWN; }
    } else if (t.t === 'kw' && t.v === 'function') {
      // anonymous function: skip to matching end
      this.skipFunctionBody();
      return UNKNOWN;
    } else if (t.t === 'id') {
      this.p++;
      val = Object.prototype.hasOwnProperty.call(this.env, t.v) ? this.env[t.v] : UNKNOWN;
    } else {
      return UNKNOWN;
    }
    // suffixes: .x  [x]  (args)  {table}  "str"  :m(args)
    for (;;) {
      if (this.is('.') && this.peek(1)?.t === 'id') { this.p += 2; val = UNKNOWN; continue; }
      if (this.is('[')) { this.skipGroup(); val = UNKNOWN; continue; }
      if (this.is(':')) { this.p += 2; continue; }
      if (this.is('(')) { this.parseArgs(); val = UNKNOWN; continue; }
      if (this.is('{')) { this.parseTable(); val = UNKNOWN; continue; }
      if (this.peek()?.t === 'str') { this.p++; val = UNKNOWN; continue; }
      break;
    }
    return val;
  }

  parseArgs() {
    this.p++; // (
    while (this.p < this.toks.length && !this.is(')')) {
      this.parseExpr();
      if (this.is(',')) this.p++;
      else if (!this.is(')')) this.skipTo([',', ')']);
    }
    this.p++;
  }

  skipFunctionBody() {
    // Skip `function (...) ... end`, counting nested blocks. Loops count at
    // `do`, so `while`/`for` are not counted separately.
    let depth = 0;
    while (this.p < this.toks.length) {
      const t = this.toks[this.p++];
      if (t.t === 'kw') {
        if (t.v === 'function' || t.v === 'if' || t.v === 'do' || t.v === 'repeat') depth++;
        else if (t.v === 'end' || t.v === 'until') { depth--; if (depth === 0) return; }
      } else if (t.t === 'op' && t.v === '{') { this.p--; this.parseTable(); }
    }
  }

  // Walk the whole file: record top-level `local x = literal` and every table.
  walk() {
    while (this.p < this.toks.length) {
      const t = this.peek();
      if (t.t === 'kw' && t.v === 'local' && this.peek(1)?.t === 'id' && this.is('=', 2)) {
        const name = this.peek(1).v;
        this.p += 3;
        const v = this.parseExpr();
        if (v !== undefined && !(name in this.env)) this.env[name] = v;
        continue;
      }
      if (t.t === 'op' && t.v === '{') { this.parseTable(); continue; }
      this.p++;
    }
    return this.found;
  }
}

const UNKNOWN = Symbol('unknown');

function evalParts(parts) {
  if (parts.length === 1) return parts[0] === UNKNOWN ? undefined : parts[0];
  // precedence: ^ > * / % // > + - > ..
  const prec = { '^': 4, '*': 3, '/': 3, '%': 3, '//': 3, '+': 2, '-': 2, '..': 1 };
  const vals = [parts[0]];
  const ops = [];
  const apply = () => {
    const b = vals.pop(), a = vals.pop(), op = ops.pop();
    if (op === '..') vals.push(String(a) + String(b));
    else if (typeof a !== 'number' || typeof b !== 'number') vals.push(undefined);
    else vals.push(op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : op === '/' ? a / b
      : op === '%' ? a % b : op === '//' ? Math.floor(a / b) : a ** b);
  };
  for (let i = 1; i < parts.length; i += 2) {
    const op = parts[i];
    if (!(op in prec)) return undefined;
    while (ops.length && prec[ops[ops.length - 1]] >= prec[op] && op !== '^' && op !== '..') apply();
    ops.push(op);
    vals.push(parts[i + 1]);
  }
  while (ops.length) apply();
  return vals[0];
}

/** Returns every table with string `type` and `name` fields (or only `name` when `untyped`). */
export function readPrototypes(src, { env = {}, untyped = false } = {}) {
  const r = new Reader(tokenize(src), { ...env }, untyped);
  return r.walk();
}
