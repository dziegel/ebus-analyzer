// Writes message definitions as eBUS TypeSpec (TSP-3), following the
// conventions of ebusd-configuration (see its guidelines.md and the csv2tsp
// converter): one namespace per circuit, @zz on the namespace, @id per model,
// value lists as enums, @out/@in only where the part differs from the default.

import { isMaster } from '../ebus/address.ts';
import type { MessageDef } from '../defs/definitions.ts';
import type { FieldDef } from '../defs/fields.ts';

const DYN_LENGTH = new Set(['STR', 'NTS', 'IGN', 'HEX']);
const RESERVED = new Set(['unknown', 'model', 'enum', 'namespace', 'scalar', 'union', 'alias', 'import', 'using', 'is', 'extends', 'op', 'interface', 'true', 'false', 'void', 'never', 'null', 'value']);

/** Normalizes a name to a TypeSpec identifier (like csv2tsp's normId). */
export function identifier(s: string): string {
  const id = s
    .replaceAll('ä', 'ae').replaceAll('ö', 'oe').replaceAll('ü', 'ue')
    .replaceAll('Ä', 'AE').replaceAll('Ö', 'OE').replaceAll('Ü', 'UE').replaceAll('ß', 'ss')
    .replaceAll('²', '2').replaceAll('³', '3')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^([0-9])/, '_$1')
    .replace(/__+/g, '_')
    .replace(/^(.+)_$/, '$1');
  return id || '_';
}

export function pascalCase(s: string): string {
  const id = identifier(s);
  return id[0]! >= '0' && id[0]! <= '9' ? `_${id}` : id[0]!.toUpperCase() + id.slice(1);
}

const hex = (n: number) => `0x${n.toString(16).padStart(2, '0')}`;

function docComment(text: string | undefined, indent: string): string[] {
  if (!text) return [];
  return [`${indent}/** ${text.replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim()} */`];
}

/** TypeSpec scalar name and length decorators for a CSV type ("IGN:3" → IGN + @maxLength(3)). */
export function typeOf(typeName: string): { type: string; decorators: string[] } {
  const [base = '', len] = typeName.toUpperCase().split(':');
  if (DYN_LENGTH.has(base)) {
    if (len === '*') return { type: base, decorators: ['@minLength(0)', '@maxLength(16)'] };
    return { type: base, decorators: len && len !== '1' ? [`@maxLength(${len})`] : [] };
  }
  if (base === 'TEM_P') return { type: 'Contrib.TEM_P', decorators: [] };
  if (!len) return { type: base, decorators: [] };
  if (base.startsWith('BI')) {
    // ebus-typespec only has BI0_6 and BI0_7 for multi-bit fields
    if (base === 'BI0' && (len === '6' || len === '7')) return { type: `BI0_${len}`, decorators: [] };
    return { type: base, decorators: [`// TODO: ${typeName} (${len} bits) has no TypeSpec type, written as ${base}`] };
  }
  return { type: `${base}${len}`, decorators: [] };
}

interface Unique {
  next(name: string): string;
}

function unique(): Unique {
  const seen = new Map<string, number>();
  return {
    next(name: string) {
      const n = seen.get(name);
      seen.set(name, (n ?? 0) + 1);
      return n === undefined ? name : `${name}_${n}`;
    },
  };
}

function defaultPart(def: MessageDef): 'm' | 's' {
  const masterDst = !!def.zz?.length && (def.zz[0] === 0xfe || isMaster(def.zz[0]!));
  return masterDst || def.type === 'w' || def.type === 'uw' ? 'm' : 's';
}

interface EnumDecl {
  name: string;
  values: Map<number, string>;
}

function fieldLines(f: FieldDef, def: MessageDef, names: Unique, enums: EnumDecl[], enumNames: Unique, indent: string): string[] {
  const out: string[] = [...docComment(f.comment, indent)];
  const part = defaultPart(def);
  if (f.part !== part) out.push(`${indent}${f.part === 'm' ? '@out' : '@in'}`);
  if (f.unit) out.push(`${indent}@unit(${JSON.stringify(f.unit)})`);
  const dv = (f.divisorValues ?? '').trim();
  if (f.constant !== undefined) {
    const num = Number(f.constant);
    out.push(`${indent}@constValue(${Number.isFinite(num) && f.constant.trim() !== '' ? num : JSON.stringify(f.constant)})`);
  } else if (f.values) {
    const name = enumNames.next(`Values_${identifier(def.name)}${f.name ? `_${identifier(f.name)}` : ''}`);
    enums.push({ name, values: f.values });
    out.push(`${indent}@values(${name})`);
  } else if (dv && !dv.includes('=')) {
    const n = Number.parseInt(dv, 10);
    if (n > 1) out.push(`${indent}@divisor(${n})`);
    else if (n < 0) out.push(`${indent}@factor(${-n})`);
  }
  const { type, decorators } = typeOf(f.typeName);
  for (const d of decorators) out.push(`${indent}${d}`);
  const base = f.name ? identifier(f.name) : type.toLowerCase().replace(/^contrib\./, '').replace(/_\d+$/, '');
  const name = names.next(RESERVED.has(base) && base !== 'value' ? `_${base}` : base);
  out.push(`${indent}${name}: ${type};`);
  return out;
}

function enumLines(e: EnumDecl, indent: string): string[] {
  const members = unique();
  const lines = [`${indent}enum ${e.name} {`];
  for (const [value, label] of e.values) {
    let id = identifier(label);
    if (RESERVED.has(id)) id = `_${id}`;
    lines.push(`${indent}  ${members.next(id)}: ${value},`);
  }
  lines.push(`${indent}}`);
  return lines;
}

function messageLines(def: MessageDef, namespaceZz: number | undefined, modelNames: Unique, enums: EnumDecl[], enumNames: Unique, indent: string): string[] {
  const out: string[] = [...docComment(def.comment, indent)];
  if (def.conditions.length) {
    out.push(`${indent}// condition in the source: ${def.conditions.map((c) => `[${c.name}${c.check ? `${c.check.op}${c.check.values.map((v) => ('text' in v ? `'${v.text}'` : 'num' in v ? v.num : `${v.from}-${v.to}`)).join(';')}` : ''}]`).join('')}`);
  }
  if (def.chain) out.push(`${indent}// chained message in the source (IDs ${def.chain.map((c) => c.map(hex).join(' ')).join('; ')}), only the first part is written`);
  out.push(`${indent}@id(${[def.pb, def.sb, ...def.id].map(hex).join(', ')})`);
  if (def.type === 'w') out.push(`${indent}@write`);
  if (def.type === 'u') out.push(`${indent}@passive`);
  if (def.type === 'uw') out.push(`${indent}@passive`, `${indent}@write`);
  if (def.pollPriority) out.push(`${indent}@poll(${def.pollPriority})`);
  if (def.level) out.push(`${indent}@auth(${JSON.stringify(def.level)})`);
  if (def.qq !== undefined) out.push(`${indent}@qq(${hex(def.qq)})`);
  const zz = def.zz?.length === 1 ? def.zz[0] : undefined;
  if (zz !== undefined && zz !== namespaceZz) out.push(`${indent}@zz(${hex(zz)})`);
  const base = pascalCase(def.name);
  const name = modelNames.next(base);
  if (name !== base) out.push(`${indent}// renamed from ${def.name} (${def.type}): model names must be unique`);
  const fieldNames = unique();
  const body = def.fields.flatMap((f, i) => [...(i > 0 ? [''] : []), ...fieldLines(f, def, fieldNames, enums, enumNames, `${indent}  `)]);
  if (!body.length) out.push(`${indent}model ${name} {}`);
  else out.push(`${indent}model ${name} {`, ...body, `${indent}}`);
  return out;
}

export interface WriteOptions {
  /** Top level namespace, usually the manufacturer (e.g. "Vaillant"). */
  manufacturer?: string;
}

/** Writes a complete .tsp file for the definitions (grouped by circuit). */
export function writeTypeSpec(defs: readonly MessageDef[], opts: WriteOptions = {}): string {
  const byCircuit = new Map<string, MessageDef[]>();
  for (const d of defs) {
    const list = byCircuit.get(d.circuit) ?? [];
    list.push(d);
    byCircuit.set(d.circuit, list);
  }
  const usesTem = defs.some((d) => d.fields.some((f) => f.typeName.toUpperCase() === 'TEM_P'));
  const lines = ['import "@ebusd/ebus-typespec";', 'using Ebus;', 'using Ebus.Num;', 'using Ebus.Dtm;', 'using Ebus.Str;'];
  if (usesTem) lines.push('using Ebus.Contrib;');
  if (opts.manufacturer) lines.push(`namespace ${pascalCase(opts.manufacturer)};`);
  for (const [circuit, list] of byCircuit) {
    const zzs = new Set(list.map((d) => (d.zz?.length === 1 ? d.zz[0] : undefined)));
    const nsZz = zzs.size === 1 ? [...zzs][0] : undefined;
    lines.push('');
    if (nsZz !== undefined) lines.push(`@zz(${hex(nsZz)})`);
    lines.push(`namespace ${pascalCase(circuit)} {`);
    const modelNames = unique();
    const enumNames = unique();
    const enums: EnumDecl[] = [];
    list.forEach((d, i) => {
      if (i > 0) lines.push('');
      lines.push(...messageLines(d, nsZz, modelNames, enums, enumNames, '  '));
    });
    for (const e of enums) lines.push('', ...enumLines(e, '  '));
    lines.push('}');
  }
  return `${lines.join('\n')}\n`;
}

/** Suggested file name for a set of definitions: "ZZ.circuit.tsp". */
export function suggestFileName(defs: readonly MessageDef[]): string {
  const d = defs[0];
  if (!d) return 'messages.tsp';
  const zz = d.zz?.length === 1 ? d.zz[0]! : undefined;
  const circuit = identifier(d.circuit).toLowerCase();
  return zz !== undefined && zz !== 0xfe ? `${hex(zz).slice(2)}.${circuit}.tsp` : `${circuit}.tsp`;
}
