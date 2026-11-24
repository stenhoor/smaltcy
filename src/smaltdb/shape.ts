/**
 * A statement's shape (ADR 0004, "Statements kept by shape"; smaltdb's ADR 0042, section 4).
 *
 * An application's statements differ from each other in their values: `MATCH (p:Person {name: 'Ada'})`, then the same
 * with `'Alan'`. Bound as written, each is a plan of its own, which smaltdb plans from nothing. So a statement's strings
 * and numbers are taken out of it: what is left is its shape. smaltdb keeps what the first statement of a shape bound
 * to (its plan with a parameter where each value was, `holedPlan`) and runs it for the next one with that one's values.
 * Keeping them is smaltdb's; what the shape of a Cypher statement is, is said here (language.ts gives it to smaltdb).
 *
 * What a shape holds, so that a statement runs what was bound for one like it and nothing else:
 *
 * - **The plan**, without the strings and numbers smaltdb compares as the values they are (`paramKind`: a string, a
 *   whole number JavaScript holds exactly, a float that isn't whole or NaN), and **the kind of each** of those, which the
 *   compiler types the plan by. Any other literal (NULL, a boolean) stays in the shape, and so does every value inside
 *   a list or a map the query builds (`[1, 2]`, `{a: 1}`): smaltdb makes such a list once when all of it is written
 *   out (an `IN` over one is then a lookup), and types its elements by what is written. A pattern's property map
 *   (`{name: 'Ada'}`) is conditions, not a value: its values are taken out.
 * - **Its parameters' names.** What they hold is no part of it: a statement is bound for the kinds of its parameters'
 *   values, which is its variant (language.ts).
 * - **SKIP and LIMIT as written.** The compiler checks them when it compiles (a whole number, not negative): a count
 *   written out stays in the shape, and one given as a parameter is marked (`pinned`), its value part of the variant.
 *
 * The graph's tables are no part of a shape: smaltdb binds what it kept again when the schema changes.
 *
 * Where the compiler needs a value written out (the direction and type of `degree()`), the statement is bound as it is
 * written (`asWritten`), and so is one with more values than a statement takes (`MAX_HOLES`): smaltdb keeps those by
 * their text alone.
 */
import type { QueryPlan } from '../plan/ops.js';
import { paramKind } from './compile.js';

/** The most values taken out of one statement: past this it is bound as written (smaltdb limits a statement's parameters). */
export const MAX_HOLES = 64;
/** A parameter's name where a value was taken out: no name Cypher can write, then the value's number. */
export const HOLE = '\u0000';

/** A statement's shape, and what was taken out of the statement to leave it. */
export interface Shape {
  /** A number the statements of one shape share. */
  readonly hash: number;
  /** The shape itself: two statements have one shape when their tokens are the same. */
  readonly tokens: readonly unknown[];
  /** The values taken out, in the order `holedPlan` numbers the parameters put in their place. */
  readonly values: readonly (string | number)[];
  /** The statement's own parameters by name, in the order it first reads them. */
  readonly params: readonly string[];
  /** Those of them that are a SKIP's or a LIMIT's count: their values are part of what the statement compiles to. */
  readonly pinned: readonly string[];
  /** Whether the compiler needs a value of the statement written out. */
  readonly asWritten: boolean;
}

// A shape is a list of tokens: the plan's names, strings and numbers in the order the walk meets them, with a mark
// where a list or an object opens and closes, and a mark of its kind where a value was taken out. Two statements have
// one shape when their tokens are the same. No text is built for it (building one and hashing it took most of the time
// of finding a kept statement): the tokens are written into `toks` as the walk goes and hashed as they are written.
//
// A mark is a symbol, which no value of a plan is, so a mark is never taken for a name or a value.
const LIST = Symbol('list');
const NODE = Symbol('object');
const END = Symbol('end');
/** A value taken out: a string, a whole number, a float. */
const TEXT = Symbol('text');
const INT = Symbol('int');
const REAL = Symbol('real');
/** A value that stays written comes next. */
const WRITTEN = Symbol('written');
/** A parameter: its name comes next, then `PINNED` where its value is part of what the statement compiles to. */
const PARAM = Symbol('parameter');
const PINNED = Symbol('pinned');
/** Numbers `===` gets wrong: -0 (equal to 0) and NaN (unequal to itself). */
const MINUS_ZERO = Symbol('-0');
const NOT_A_NUMBER = Symbol('NaN');
/** A value that is none of the above (a bigint, say) comes next, compared as it is. */
const OTHER = Symbol('other');

// One walk does both jobs, so they can't disagree on which values are taken out or in which order: it writes the
// shape's tokens and `values`, what was taken out; with `build`, it also returns the plan with a parameter in each
// one's place.
/** The tokens of the statement walked last: the first `n` of `toks`, which is used again for the next. */
const toks: unknown[] = [];
let n = 0;
let hash = 0;
let values: (string | number)[] = [];
let params: string[] = [];
let pinned: string[] = [];
let build = false;
/** Set by the walk when the plan holds a value the compiler needs written out (`degree()`'s direction and type). */
let asWritten = false;
/** How many lists and maps the query builds the walk is inside: their values stay written. */
let building = 0;
/** Set for the map the walk reaches next when it is a pattern's property map. */
let conditions = false;

/** A mark, or a value there are few of (true, false, NULL): `code` is what the hash takes for it. */
function mark(m: symbol | boolean | null, code: number): void {
  toks[n++] = m;
  hash = (Math.imul(hash, 31) + code) | 0;
}

/** A name or a string. The hash takes its length and its ends: enough to tell most apart, and the tokens are compared. */
function str(s: string): void {
  toks[n++] = s;
  const l = s.length;
  hash = (Math.imul(hash, 31) + (l > 0 ? (l << 16) ^ (s.charCodeAt(0) << 8) ^ s.charCodeAt(l - 1) : 0)) | 0;
}

/** A value written in the statement: taken out if smaltdb compares it as the value it is, else part of the shape. */
function literal(x: { readonly k: 'lit'; readonly v: unknown }): unknown {
  const v = x.v;
  const kind = building === 0 && (typeof v === 'string' || typeof v === 'number') ? paramKind(v) : '';
  if (kind === 'text' || kind === 'int' || kind === 'real') {
    if (kind === 'text') mark(TEXT, 1);
    else if (kind === 'int') mark(INT, 2);
    else mark(REAL, 3);
    values.push(v as string | number);
    return build ? { k: 'param', name: HOLE + (values.length - 1) } : x;
  }
  mark(WRITTEN, 4);
  plain(v);
  return x;
}

/** A parameter: its name, and with `pin` that its value is part of what the statement compiles to. */
function parameter(x: { readonly k: 'param'; readonly name: string }, pin: boolean): void {
  mark(PARAM, 5);
  str(x.name);
  if (!params.includes(x.name)) params.push(x.name);
  if (pin) {
    mark(PINNED, 7);
    if (!pinned.includes(x.name)) pinned.push(x.name);
  }
}

/** A value that stays in the shape as it is. */
function plain(v: unknown): void {
  if (typeof v === 'string') str(v);
  else if (typeof v === 'number') {
    toks[n++] = v !== v ? NOT_A_NUMBER : v === 0 && 1 / v < 0 ? MINUS_ZERO : v;
    hash = (Math.imul(hash, 31) + (v | 0)) | 0;
  } else if (v === null || v === undefined) mark(null, 8);
  else if (typeof v === 'boolean') mark(v, v ? 9 : 10);
  else if (Array.isArray(v)) {
    mark(LIST, 11);
    for (const item of v) plain(item);
    mark(END, 12);
  } else if (typeof v === 'object') {
    mark(NODE, 13);
    for (const k in v) {
      str(k);
      plain((v as Record<string, unknown>)[k]);
    }
    mark(END, 12);
  } else {
    mark(OTHER, 14);
    toks[n++] = v;
  }
}

/** A SKIP or a LIMIT, which the compiler checks as it is written: all of it in the shape. */
function written(x: unknown): void {
  const o = x as { readonly k?: string };
  if (o !== null && typeof o === 'object' && o.k === 'param') parameter(o as { readonly k: 'param'; readonly name: string }, true);
  else plain(x);
}

/** Any part of a plan: an operation, an expression, a pattern, a list of them, a name or a number. */
function walk(x: unknown): unknown {
  if (x === null || typeof x !== 'object') {
    plain(x);
    return x;
  }
  if (Array.isArray(x)) {
    mark(LIST, 11);
    let out: unknown[] | undefined;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      if (typeof v === 'string') str(v);
      else if (v === null || typeof v !== 'object') plain(v);
      else {
        const w = walk(v);
        if (build && w !== v) (out ??= x.slice())[i] = w;
      }
    }
    mark(END, 12);
    return out ?? x;
  }
  const o = x as Record<string, unknown>;
  const kind = o.k;
  if (kind === 'lit') return literal(o as { readonly k: 'lit'; readonly v: unknown });
  if (kind === 'param') {
    parameter(o as { readonly k: 'param'; readonly name: string }, false);
    return x;
  }
  const limit = o.op === 'limit';
  if (kind === 'call' && o.fn === 'degree' && Array.isArray(o.args) && o.args.length > 1) asWritten = true;
  // A list, or a map that isn't a pattern's property map: a value the query builds.
  const built = kind === 'list' || (kind === 'map' && !conditions);
  conditions = false;
  if (built) building++;
  mark(NODE, 13);
  let out: Record<string, unknown> | undefined;
  for (const k in o) {
    const v = o[k];
    if (v === undefined) continue;
    str(k);
    // A name or a number is its own token, wherever it is.
    if (typeof v === 'string') str(v);
    else if (v === null || typeof v !== 'object') plain(v);
    else if (limit && (k === 'count' || k === 'skip')) written(v);
    else {
      // The property map of a pattern's node or relationship (`Pattern` in plan/ops.ts: both have a `slot`).
      conditions = k === 'props' && typeof o.slot === 'number';
      const w = walk(v);
      conditions = false;
      if (build && w !== v) (out ??= { ...o })[k] = w;
    }
  }
  mark(END, 12);
  if (built) building--;
  return out ?? x;
}

/** Before a walk: nothing written yet; `plan`: the walk also returns the plan with its values taken out. */
function start(plan: boolean): void {
  n = 0;
  hash = 0;
  values = [];
  params = [];
  pinned = [];
  build = plan;
  asWritten = false;
  building = 0;
  conditions = false;
}

/** A statement's shape. */
export function statementShape(gp: QueryPlan): Shape {
  start(false);
  walk(gp);
  return { hash, tokens: toks.slice(0, n), values, params, pinned, asWritten };
}

/**
 * A statement with a parameter where each value was taken out: `statementShape`'s values, under the names `HOLE` and
 * their number. What the first statement of a shape is bound as.
 */
export function holedPlan(gp: QueryPlan): QueryPlan {
  start(true);
  const out = walk(gp) as QueryPlan;
  build = false;
  return out;
}
