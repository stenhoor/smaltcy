/**
 * A statement told from its text without parsing it (ADR 0004, "A statement told from its text").
 *
 * An application's statements differ from each other in their strings and numbers, and a statement whose text is new
 * is parsed, bound and walked for its shape (shape.ts) before smaltdb can tell it has one of that shape: half of the
 * time of a short statement. A template is what a text's skeleton, the text outside its strings and numbers, is known
 * to give: the shape, and which value of the shape each string and number is. A text with a template's skeleton gives
 * the statement its parse would give, with its own values, and is not parsed.
 *
 * What makes that the same statement. A parse reads a string or a number in few ways (src/cypher: the parser and the
 * binder), and a template holds each of them as it is in the statement the template was made from:
 *
 * - **Its kind:** a string, a number, or a number written with a point or an exponent (which makes a division by it
 *   a float's, whatever its value).
 * - **Whether its value is taken out of the shape,** and as what (`paramKind`: a string, a whole number, a float that
 *   isn't whole). One that stays written (a count of hops, a LIMIT, a value inside a list the query builds, the name
 *   of a column that has no alias) is part of the template with its text, and a statement has that text there or is
 *   parsed.
 * - **A `-` before it folded into it** (`-5` is one value): the value taken out is then the number's opposite.
 * - **Which others it is equal to.** The binder reads an ORDER BY's expression as a returned item where the two are
 *   written alike, so two statements bind alike only where the same of their values are equal. (`-0` and `0` are
 *   alike to it and `-5` and `5` are not: where equal numbers are taken out with both signs, a statement's are 0
 *   where the template's were.)
 *
 * Which of these a string or a number of a statement is, is not read off the parser's code: it is found by parsing.
 * The statement is parsed again with other values in their places (equal ones staying equal), and a template is made
 * only where that parse has the same shape with those values taken out where the template says. So a template cannot
 * say more than the parser does, and a skeleton it is not sure of gets none.
 *
 * A template costs a parse or more to make, so the first statement of a shape makes none: a statement makes its
 * skeleton's template when a statement of its shape was parsed before.
 */
import { compile } from '../cypher/index.js';
import { LIT_FLOAT, LIT_STRING, scanLiterals, type LiteralScan } from '../cypher/parser.js';
import type { QueryPlan } from '../plan/ops.js';
import { paramKind } from './compile.js';
import { MAX_HOLES, statementShape, type Shape } from './shape.js';

/** The most strings and numbers a statement with a template has: past this it is parsed. */
const MAX_LITERALS = 16;
/** The most templates kept, and the most for one skeleton (they differ in what stays written, or in which values are equal). The oldest go first. */
const MAX_TEMPLATES = 256;
const MAX_OF_SKELETON = 4;

/** What the statements of a template share: the plan of the one it was made from, and its shape. */
export interface TemplateStatement {
  readonly plan: QueryPlan;
  readonly hash: number;
  readonly tokens: readonly unknown[];
  readonly params: readonly string[];
  readonly pinned: readonly string[];
  /** The statement's parameters as smaltdb takes their names (language.ts), made once. */
  paramNames?: ReadonlyMap<string, number>;
}

interface Template {
  /** The text outside the statement's strings and numbers: before the first, between each two, after the last. */
  readonly parts: readonly string[];
  /** Each one's kind (`LIT_STRING`, `LIT_NUMBER`, `LIT_FLOAT`). */
  readonly kinds: readonly number[];
  /** The statement its texts give; undefined where the skeleton gives none (it was tried, and is not tried again). */
  readonly statement?: TemplateStatement;
  /** For each: the first one it is equal to (itself where none before it is). Equal ones are one value. */
  readonly firstEqual: readonly number[];
  /** For each that stays written: its text. */
  readonly raw: readonly (string | undefined)[];
  /** For each that is a number equal ones of which are taken out with both signs: whether it is 0. */
  readonly zero: readonly (boolean | undefined)[];
  /** The shape's values as the template's statement has them: those no string or number gives are every statement's. */
  readonly values: readonly (string | number)[];
  /** For each value of the shape: the string or number that gives it (-1: none does), with -1 in `sign` where a `-` before it is folded into it. */
  readonly from: readonly number[];
  readonly sign: readonly number[];
  /** The kind each value of the shape is taken out as. */
  readonly classes: readonly string[];
}

/** A statement found from its text: what it shares with its template's others, and its own values. */
export interface Told {
  readonly statement: TemplateStatement;
  readonly values: (string | number)[];
}

/** How many statements were told from their text, and how many templates were made and refused: for tests and benchmarks. */
export const templateCounts = { told: 0, made: 0, refused: 0 };

const scan: LiteralScan = { count: 0, hash: 0, start: [], end: [], kind: [], value: [] };

function sameTokens(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The shape a text parses to, or undefined: where it doesn't parse, or is no statement a template is for. */
function shapeOf(text: string): Shape | undefined {
  try {
    const { plan, explain } = compile(text);
    return explain || plan.kind !== 'query' || plan.asOf ? undefined : statementShape(plan);
  } catch {
    return undefined;
  }
}

/** The templates of one language registered with smaltdb. */
export class Templates {
  private readonly bySkeleton = new Map<number, Template[]>();
  /** Every template kept, oldest first. */
  private readonly kept: { readonly hash: number; readonly template: Template }[] = [];
  /** The shapes parsed lately, by their hash (0: none): a shape parsed twice gets its skeleton's template. */
  private readonly parsedOnce = new Int32Array(256);
  /** The text scanned last, and whether its strings and numbers could be read: `parsed` reads the same scan. */
  private scanned: string | undefined;
  private readable = false;

  /**
   * The statement a text is, where a template of its skeleton says so; undefined where it is to be parsed. The values
   * are the statement's own, in its shape's order.
   */
  tell(text: string): Told | undefined {
    this.scanned = text;
    this.readable = scanLiterals(text, scan, MAX_LITERALS) && scan.count > 0;
    if (!this.readable) return undefined;
    const list = this.bySkeleton.get(scan.hash);
    if (list === undefined) return undefined;
    const k = scan.count;
    next: for (let t = 0; t < list.length; t++) {
      const tpl: Template = list[t]!;
      const made = tpl.statement;
      if (made === undefined || tpl.kinds.length !== k || !this.sameSkeleton(tpl, text)) continue;
      // Its strings and numbers are the template's in every way a parse reads them.
      for (let i = 0; i < k; i++) {
        const v = scan.value[i]!;
        let first = i;
        for (let j = 0; j < i; j++) {
          if (scan.kind[j] === scan.kind[i] && scan.value[j] === v) {
            first = j;
            break;
          }
        }
        if (first !== tpl.firstEqual[i]) continue next;
        const raw = tpl.raw[i];
        if (raw !== undefined && (scan.end[i]! - scan.start[i]! !== raw.length || !text.startsWith(raw, scan.start[i]!))) continue next;
        const zero = tpl.zero[i];
        if (zero !== undefined && (v === 0) !== zero) continue next;
      }
      const values = tpl.values.slice();
      for (let h = 0; h < values.length; h++) {
        const i = tpl.from[h]!;
        if (i < 0) continue;
        const v = scan.value[i]!;
        const x = tpl.sign[h]! < 0 ? -(v as number) : v;
        if (paramKind(x) !== tpl.classes[h]) continue next;
        values[h] = x;
      }
      templateCounts.told++;
      return { statement: made, values };
    }
    return undefined;
  }

  /** Whether the text scanned last has a template's text outside its strings and numbers, and their kinds. */
  private sameSkeleton(tpl: Template, text: string): boolean {
    const k = tpl.kinds.length;
    let at = 0;
    for (let i = 0; i < k; i++) {
      const part = tpl.parts[i]!;
      if (scan.kind[i] !== tpl.kinds[i] || scan.start[i]! - at !== part.length || !text.startsWith(part, at)) return false;
      at = scan.end[i]!;
    }
    const last = tpl.parts[k]!;
    return text.length - at === last.length && text.startsWith(last, at);
  }

  /**
   * After a text `tell` had no statement for was parsed: its plan and its shape. Where a statement of the shape was
   * parsed before, the text's skeleton gets a template (or is remembered as one that gives none).
   */
  parsed(text: string, plan: QueryPlan, shape: Shape): void {
    if (this.scanned !== text || !this.readable) return;
    if (shape.values.length === 0 || shape.values.length > MAX_HOLES || shape.asWritten) return;
    const slot = shape.hash & 255;
    const mark = shape.hash | 1;
    if (this.parsedOnce[slot] !== mark) {
      this.parsedOnce[slot] = mark;
      return;
    }
    const k = scan.count;
    const hash = scan.hash;
    const list = this.bySkeleton.get(hash);
    if (list !== undefined) {
      let same = 0;
      let oldest: Template | undefined;
      for (const tpl of list) {
        if (tpl.kinds.length !== k || !this.sameSkeleton(tpl, text)) continue;
        // A skeleton that gives no statement is not tried again.
        if (tpl.statement === undefined) return;
        oldest ??= tpl;
        same++;
      }
      // The skeleton has its templates, and this statement differs from each in what stays written: the oldest goes.
      if (same >= MAX_OF_SKELETON) this.forget(oldest!, hash);
    }
    const kinds = scan.kind.slice(0, k);
    const parts: string[] = [];
    const raw: string[] = [];
    let at = 0;
    for (let i = 0; i < k; i++) {
      parts.push(text.slice(at, scan.start[i]!));
      raw.push(text.slice(scan.start[i]!, scan.end[i]!));
      at = scan.end[i]!;
    }
    parts.push(text.slice(at));
    // Making it parses other texts: nothing of the scan is read after this.
    const template = make(parts, kinds, raw, scan.value.slice(0, k), plan, shape);
    if (template.statement === undefined) templateCounts.refused++;
    else templateCounts.made++;
    const into = this.bySkeleton.get(hash);
    if (into === undefined) this.bySkeleton.set(hash, [template]);
    else into.push(template);
    this.kept.push({ hash, template });
    if (this.kept.length > MAX_TEMPLATES) {
      const first = this.kept[0]!;
      this.forget(first.template, first.hash);
    }
  }

  private forget(template: Template, hash: number): void {
    const list = this.bySkeleton.get(hash);
    if (list !== undefined) {
      const at = list.indexOf(template);
      if (at >= 0) list.splice(at, 1);
      if (list.length === 0) this.bySkeleton.delete(hash);
    }
    const at = this.kept.findIndex((x) => x.template === template);
    if (at >= 0) this.kept.splice(at, 1);
  }
}

/**
 * A skeleton's template, made from a statement of it: its text in parts, its strings and numbers, and what it parsed
 * to. Without a `statement` where the skeleton gives none.
 */
function make(parts: readonly string[], kinds: readonly number[], raw: readonly string[], values: readonly (string | number)[], plan: QueryPlan, shape: Shape): Template {
  const k = kinds.length;
  const none: Template = { parts, kinds, firstEqual: [], raw: [], zero: [], values: [], from: [], sign: [], classes: [] };
  const firstEqual: number[] = [];
  for (let i = 0; i < k; i++) {
    let first = i;
    for (let j = 0; j < i; j++) {
      if (kinds[j] === kinds[i] && values[j] === values[i]) {
        first = j;
        break;
      }
    }
    firstEqual.push(first);
  }
  // Another value for each string and number, of its kind, that none of the statement's is: a whole number stays
  // whole and a float stays a float, each written as the statement writes it, and equal ones get one value. A number
  // smaltdb does not compare as the value it is (a whole number past those JavaScript holds exactly) stays written,
  // and gets none.
  const other: (string | number | undefined)[] = [];
  const otherText: (string | undefined)[] = [];
  let n = 104729;
  for (let i = 0; i < k; i++) {
    const first = firstEqual[i]!;
    if (first !== i) {
      other.push(other[first]);
      otherText.push(otherText[first]);
      continue;
    }
    const v = values[i]!;
    if (kinds[i] === LIT_STRING) {
      let p: string;
      do p = `smaltcy value ${n++}`;
      while (values.includes(p));
      other.push(p);
      otherText.push(`'${p}'`);
      continue;
    }
    const kind = paramKind(v);
    if (kind !== 'int' && kind !== 'real') {
      other.push(undefined);
      otherText.push(undefined);
      continue;
    }
    let p: number;
    do {
      p = n;
      n += 2;
    } while (values.includes(p) || values.includes(p + 0.5));
    other.push(kind === 'int' ? p : p + 0.5);
    otherText.push(kind === 'real' ? `${p}.5` : kinds[i] === LIT_FLOAT ? `${p}.0` : `${p}`);
  }
  const textWith = (others: (i: number) => boolean): string => {
    let out = '';
    for (let i = 0; i < k; i++) out += parts[i]! + (otherText[i] !== undefined && others(i) ? otherText[i]! : raw[i]!);
    return out + parts[k]!;
  };
  /** A text's shape, where it is the statement's with as many values taken out. */
  const sameShape = (text: string): Shape | undefined => {
    const s = shapeOf(text);
    return s !== undefined && s.hash === shape.hash && s.values.length === shape.values.length && s.asWritten === shape.asWritten && sameTokens(s.tokens, shape.tokens) ? s : undefined;
  };
  // With every one of them another value: the same shape where none of them is part of it.
  let taken: boolean[] = otherText.map((t) => t !== undefined);
  let parsed = sameShape(textWith((i) => taken[i]!));
  if (parsed === undefined) {
    // Some stay written. Each value alone (with those equal to it) tells which: the shape is another with another
    // value there.
    const alone = taken.map((can, i) => can && firstEqual[i] === i && sameShape(textWith((j) => firstEqual[j] === i)) !== undefined);
    taken = taken.map((_, i) => alone[firstEqual[i]!]!);
    if (!taken.includes(true)) return none;
    parsed = sameShape(textWith((i) => taken[i]!));
    if (parsed === undefined) return none;
  }
  // Which string or number each value of the shape is: the one whose other value it has now, or that value's
  // opposite. A value that is as it was is given by what stays written.
  const from: number[] = [];
  const sign: number[] = [];
  const signs = new Map<number, Set<number>>();
  for (let h = 0; h < shape.values.length; h++) {
    const got = parsed.values[h]!;
    let i = 0;
    for (; i < k; i++) {
      if (!taken[i] || firstEqual[i] !== i) continue;
      const p = other[i]!;
      if (got === p || (typeof p === 'number' && got === -p)) break;
    }
    if (i === k) {
      if (!Object.is(got, shape.values[h])) return none;
      from.push(-1);
      sign.push(1);
      continue;
    }
    const s = got === other[i] ? 1 : -1;
    // The statement itself has its own value there.
    const v = values[i]!;
    if (!Object.is(shape.values[h], s < 0 ? -(v as number) : v)) return none;
    from.push(i);
    sign.push(s);
    let of = signs.get(i);
    if (of === undefined) signs.set(i, (of = new Set()));
    of.add(s);
  }
  // Each of them is a value of the shape, or the skeleton is not understood.
  for (let i = 0; i < k; i++) if (taken[i] && !signs.has(firstEqual[i]!)) return none;
  const classes = shape.values.map((v) => paramKind(v));
  if (classes.some((c, h) => from[h]! >= 0 && c !== 'text' && c !== 'int' && c !== 'real')) return none;
  return {
    parts,
    kinds,
    statement: { plan, hash: shape.hash, tokens: shape.tokens, params: shape.params, pinned: shape.pinned },
    firstEqual,
    raw: raw.map((r, i) => (taken[i] ? undefined : r)),
    zero: values.map((v, i) => (taken[i] && signs.get(firstEqual[i]!)!.size > 1 ? v === 0 : undefined)),
    values: shape.values.slice(),
    from,
    sign,
    classes,
  };
}
