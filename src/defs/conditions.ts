// Message conditions as used in ebusd CSV files:
//   definition: *[name],circuit,,message,,field,zz,values
//   usage:      [name>=104][other='Text';'Other']r,...

/** One comparison of a condition reference, e.g. `>=104` or `='a';'b'` or `=1-5`. */
export interface ConditionCheck {
  op: '=' | '>=' | '<=' | '>' | '<' | '!=';
  values: Array<{ text: string } | { num: number } | { from: number; to: number }>;
}

/** A condition used in front of a message (`[name...]`). */
export interface ConditionRef {
  name: string;
  check?: ConditionCheck;
}

/** A condition definition line (`*[name],...`). */
export interface ConditionDef {
  name: string;
  circuit: string;
  message: string;
  field: string;
  zz?: number;
  check?: ConditionCheck;
  /** Defaults of the defining file, used when circuit or zz are empty. */
  fileCircuit?: string;
  fileZz?: number;
}

/** Splits the leading `[...]` condition groups off a type column. */
export function splitConditions(col: string): { refs: ConditionRef[]; rest: string } {
  const refs: ConditionRef[] = [];
  let rest = col.trim();
  while (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    if (end < 0) throw new Error(`unterminated condition in "${col}"`);
    refs.push(parseConditionRef(rest.slice(1, end)));
    rest = rest.slice(end + 1);
  }
  return { refs, rest };
}

export function parseConditionRef(text: string): ConditionRef {
  const m = /^([A-Za-z0-9_]+)\s*(.*)$/.exec(text.trim());
  if (!m) throw new Error(`invalid condition "${text}"`);
  const ref: ConditionRef = { name: m[1]! };
  if (m[2]) ref.check = parseCheck(m[2]);
  return ref;
}

/** Parses `op values` (op defaults to `=` for value lists in definitions). */
export function parseCheck(text: string): ConditionCheck {
  const m = /^(>=|<=|!=|=|>|<)?(.*)$/.exec(text.trim())!;
  const op = (m[1] ?? '=') as ConditionCheck['op'];
  const values: ConditionCheck['values'] = [];
  for (const raw of splitValues(m[2]!)) {
    const v = raw.trim();
    if (v.startsWith("'")) values.push({ text: v.replace(/^'|'$/g, '') });
    else {
      const range = /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/.exec(v);
      if (range) values.push({ from: Number(range[1]), to: Number(range[2]) });
      else if (v !== '' && Number.isFinite(Number(v))) values.push({ num: Number(v) });
      else if (v !== '') values.push({ text: v });
    }
  }
  return { op, values };
}

function splitValues(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of s) {
    if (ch === "'") quoted = !quoted;
    if (ch === ';' && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** A value a condition is checked against: numeric and/or text. */
export interface ConditionValue {
  num?: number;
  text: string;
}

/** Evaluates one check; undefined if the value is not known. */
export function evaluateCheck(check: ConditionCheck, value: ConditionValue | undefined): boolean | undefined {
  if (!value) return undefined;
  const results = check.values.map((v) => {
    if ('text' in v) {
      const eq = value.text.trim().toLowerCase() === v.text.toLowerCase();
      return check.op === '!=' ? !eq : check.op === '=' ? eq : false;
    }
    const n = value.num ?? Number(value.text);
    if (!Number.isFinite(n)) return false;
    if ('from' in v) {
      const inside = n >= v.from && n <= v.to;
      return check.op === '!=' ? !inside : inside;
    }
    switch (check.op) {
      case '=':
        return n === v.num;
      case '!=':
        return n !== v.num;
      case '>=':
        return n >= v.num;
      case '<=':
        return n <= v.num;
      case '>':
        return n > v.num;
      case '<':
        return n < v.num;
    }
  });
  return check.op === '!=' ? results.every(Boolean) : results.some(Boolean);
}

/** Combines condition results: false wins, then unknown, else true. */
export function combine(results: ReadonlyArray<boolean | undefined>): boolean | undefined {
  if (results.some((r) => r === false)) return false;
  if (results.some((r) => r === undefined)) return undefined;
  return true;
}
