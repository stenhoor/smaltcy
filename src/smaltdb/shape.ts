/**
 * Queries kept by their shape (ADR 0004, "Statements kept by shape").
 *
 * An application's queries differ from each other in their values: `MATCH (p:Person {name: 'Ada'})`, then the same with
 * `'Alan'`. Compiled as written, each is a plan of its own, which smaltdb plans from nothing. Here a query's strings and
 * numbers are taken out of it before it is compiled: what is left is its shape, compiled once with a parameter where
 * each of them was, and the statement smaltdb prepared for it is kept by that shape and run with each query's values.
 *
 * What a shape holds, so that a query runs a statement compiled for it and no other:
 *
 * - **The plan**, without the strings and numbers smaltdb compares as the values they are (`paramKind`: a string, a
 *   whole number JavaScript holds exactly, a float that isn't whole or NaN), and **the kind of each** of those, which the
 *   compiler types the plan by. Any other literal (NULL, a boolean) stays in the shape, and so does every value inside
 *   a list or a map the query builds (`[1, 2]`, `{a: 1}`): smaltdb makes such a list once when all of it is written
 *   out (an `IN` over one is then a lookup), and types its elements by what is written. A pattern's property map
 *   (`{name: 'Ada'}`) is conditions, not a value: its values are taken out.
 * - **The kind of each parameter** the query was given, for the same reason.
 * - **SKIP and LIMIT with their values.** The compiler checks them when it compiles (a whole number, not negative).
 * - **The graph's tables**: its labels and types and the tables they are, which a plan names.
 *
 * A query that reads the past (`AT VERSION`, `AT TIME`) isn't kept: its version is found before it is compiled. Where
 * the compiler needs a value written out (the direction and type of `degree()`), it refuses the query with its values
 * taken out: that shape is remembered as one to compile as written, as every query was before.
 */
import type { PlanStatementInput } from 'smaltdb/engine';
import type { QueryPlan } from '../plan/ops.js';
import { compileQuery, paramKind, Unsupported, type CompiledQuery } from './compile.js';
import type { GraphTables } from './schema.js';

/** What a shape needs of a smaltdb database: `Database.preparePlan`, or failing that `Database.queryPlan`. */
export interface ShapeDatabase {
  queryPlan(stmt: PlanStatementInput, params?: readonly unknown[]): { readonly rows: readonly (readonly unknown[])[] };
  preparePlan?(stmt: PlanStatementInput): { result(params?: readonly never[]): { readonly rows: readonly (readonly unknown[])[] } };
}

/** A query run by its shape: its rows and column names. */
export interface ShapeResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
}

/** The most values taken out of one query: past this it is compiled as written (smaltdb limits a statement's parameters). */
const MAX_HOLES = 64;
/** The most shapes kept for one database; the oldest goes first. */
const MAX_SHAPES = 256;
/** A parameter's name where a value was taken out: no name Cypher can write, then the value's number. */
const HOLE = '\u0000';

interface Kept {
  readonly columns: readonly string[];
  /** The statement's parameters in order: the number of a value taken out, or a parameter's name. */
  readonly order: readonly (number | string)[];
  readonly run: (values: readonly unknown[]) => { readonly rows: readonly (readonly unknown[])[] };
}

/** A shape kept for a database: what it is found by, and its statement (`null`: one to compile as written). */
interface Entry {
  readonly hash: number;
  readonly tokens: readonly unknown[];
  readonly kept: Kept | null;
}

/** A database's shapes: by their hash, and in the order they were kept (the oldest first). */
interface Shapes {
  readonly byHash: Map<number, Entry[]>;
  readonly inOrder: Entry[];
}

const shapes = new WeakMap<object, Shapes>();
/** What a plan depends on in a graph's tables, as text. */
const signatures = new WeakMap<GraphTables, string>();

function signature(t: GraphTables): string {
  let s = signatures.get(t);
  if (s === undefined) {
    const names = (m: ReadonlyMap<string, string>) => [...m].map(([name, table]) => `${name.length}:${name}=${table}`).join(',');
    s = `${t.graph}|${t.nodes}|${t.labels}|${names(t.labelTables)}|${names(t.types)}|${t.relationshipIds ? 1 : 0}|${t.history ?? ''}`;
    signatures.set(t, s);
  }
  return s;
}

// A shape is a list of tokens: the plan's names, strings and numbers in the order the walk meets them, with a mark
// where a list or an object opens and closes, and a mark of its kind where a value was taken out. Two queries have one
// shape when their tokens are the same. No text is built for it (building one and hashing it took most of the time of
// finding a kept statement): a query's tokens are written into `toks` as the walk goes and hashed as they are written,
// and compared with those of the shapes kept under that hash.
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
/** A parameter: its name and the kind of its value come next (`MISSING` for one not given), then `PINNED` and its value where that is part of the shape. */
const PARAM = Symbol('parameter');
const MISSING = Symbol('missing');
const PINNED = Symbol('pinned');
/** Numbers `===` gets wrong: -0 (equal to 0) and NaN (unequal to itself). */
const MINUS_ZERO = Symbol('-0');
const NOT_A_NUMBER = Symbol('NaN');
/** A value that is none of the above (a bigint, say) comes next, compared as it is. */
const OTHER = Symbol('other');

// One walk does both jobs, so they can't disagree on which values are taken out or in which order: it writes the
// shape's tokens and `values`, what was taken out; with `build`, it also returns the plan with a parameter in each
// one's place.
/** The tokens of the query walked last: the first `n` of `toks`, which is used again for the next. */
const toks: unknown[] = [];
let n = 0;
let hash = 0;
let values: unknown[] = [];
let given: Readonly<Record<string, unknown>> = {};
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

/** A value written in the query: taken out if smaltdb compares it as the value it is, else part of the shape. */
function literal(x: { readonly k: 'lit'; readonly v: unknown }): unknown {
  const v = x.v;
  const kind = building === 0 && (typeof v === 'string' || typeof v === 'number') ? paramKind(v) : '';
  if (kind === 'text' || kind === 'int' || kind === 'real') {
    if (kind === 'text') mark(TEXT, 1);
    else if (kind === 'int') mark(INT, 2);
    else mark(REAL, 3);
    values.push(v);
    return build ? { k: 'param', name: HOLE + (values.length - 1) } : x;
  }
  mark(WRITTEN, 4);
  plain(v);
  return x;
}

/** A parameter: its name and the kind of its value, and with `pinned` the value. */
function parameter(x: { readonly k: 'param'; readonly name: string }, pinned: boolean): void {
  const v = given[x.name];
  mark(PARAM, 5);
  str(x.name);
  if (x.name in given) str(paramKind(v));
  else mark(MISSING, 6);
  if (pinned) {
    mark(PINNED, 7);
    plain(v);
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

/** Walks a query for its shape: its tokens (`toks`, `n`, `hash`) and the values taken out of it (`values`). */
function shapeOf(gp: QueryPlan, tables: GraphTables, params: Readonly<Record<string, unknown>>): void {
  n = 0;
  hash = 0;
  values = [];
  given = params;
  build = false;
  building = 0;
  conditions = false;
  str(signature(tables));
  walk(gp);
}

/** The shape kept whose tokens are those of the query walked last. */
function found(all: Shapes): Entry | undefined {
  const under = all.byHash.get(hash);
  if (under === undefined) return undefined;
  next: for (let e = 0; e < under.length; e++) {
    const tokens = under[e]!.tokens;
    if (tokens.length !== n) continue;
    for (let i = 0; i < n; i++) if (tokens[i] !== toks[i]) continue next;
    return under[e];
  }
  return undefined;
}

/** Keeps a shape; past `MAX_SHAPES` the oldest goes. */
function add(all: Shapes, entry: Entry): void {
  const under = all.byHash.get(entry.hash);
  if (under) under.push(entry);
  else all.byHash.set(entry.hash, [entry]);
  all.inOrder.push(entry);
  if (all.inOrder.length <= MAX_SHAPES) return;
  const oldest = all.inOrder.shift()!;
  const its = all.byHash.get(oldest.hash)!;
  if (its.length === 1) all.byHash.delete(oldest.hash);
  else its.splice(its.indexOf(oldest), 1);
}

/** For tests: how many shapes are kept for a database, and how many hashes they are under. */
export function keptShapes(db: object): { shapes: number; hashes: number } {
  const all = shapes.get(db);
  return { shapes: all?.inOrder.length ?? 0, hashes: all?.byHash.size ?? 0 };
}

/** A query with a parameter where each value was taken out: `shapeOf`'s values, under the names `HOLE` and their number. */
function withHoles(gp: QueryPlan, params: Readonly<Record<string, unknown>>): QueryPlan {
  n = 0;
  hash = 0;
  values = [];
  given = params;
  build = true;
  asWritten = false;
  building = 0;
  conditions = false;
  const out = walk(gp) as QueryPlan;
  build = false;
  return out;
}

/**
 * A statement that writes, with a parameter where each of its values was (`runByShape`'s rule), and its parameters
 * with those values among them: what the write runner runs, so that the statements it makes for one Cypher statement
 * and for the next of its shape differ only in their parameters, and smaltdb plans each once. The statement as it is
 * where the compiler needs one of its values written out, or it holds more values than a statement takes.
 */
export function valuesOut(gp: QueryPlan, params: Readonly<Record<string, unknown>>): { plan: QueryPlan; params: Readonly<Record<string, unknown>> } {
  const plan = withHoles(gp, params);
  const taken = values;
  if (asWritten || taken.length === 0 || taken.length > MAX_HOLES) return { plan: gp, params };
  const all: Record<string, unknown> = { ...params };
  for (let i = 0; i < taken.length; i++) all[HOLE + i] = taken[i];
  return { plan, params: all };
}

/**
 * Runs a query that only reads by its shape: the statement kept for the shape, compiled and prepared the first time.
 * `undefined` for a query that isn't kept (it reads the past, has too many values, or the compiler refuses its shape):
 * the caller compiles it as written.
 */
export function runByShape(db: ShapeDatabase, gp: QueryPlan, tables: GraphTables, params: Readonly<Record<string, unknown>>): ShapeResult | undefined {
  if (gp.asOf) return undefined;
  shapeOf(gp, tables, params);
  const taken = values;
  if (taken.length > MAX_HOLES) return undefined;
  let all = shapes.get(db);
  if (!all) shapes.set(db, (all = { byHash: new Map(), inOrder: [] }));
  let entry = found(all);
  if (entry === undefined) {
    // Its tokens are copied before it is compiled: compiling it walks it again, into `toks`.
    const tokens = toks.slice(0, n);
    const under = hash;
    entry = { hash: under, tokens, kept: keep(db, gp, tables, params, taken) };
    add(all, entry);
  }
  const kept = entry.kept;
  if (kept === null) return undefined;
  const order = kept.order;
  const bound: unknown[] = new Array(order.length);
  for (let i = 0; i < order.length; i++) {
    const p = order[i]!;
    if (typeof p === 'number') bound[i] = taken[p];
    else {
      const v = params[p];
      bound[i] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
    }
  }
  return { columns: kept.columns, rows: kept.run(bound).rows };
}

/** Compiles a shape and prepares its statement; `null` when the compiler refuses the query with its values taken out. */
function keep(db: ShapeDatabase, gp: QueryPlan, tables: GraphTables, params: Readonly<Record<string, unknown>>, taken: readonly unknown[]): Kept | null {
  let q: CompiledQuery;
  if (taken.length === 0) q = compileQuery(gp, tables, { params });
  else {
    const all: Record<string, unknown> = { ...params };
    taken.forEach((v, i) => (all[HOLE + i] = v));
    try {
      q = compileQuery(withHoles(gp, params), tables, { params: all });
    } catch (e) {
      // Something the compiler needs written out: this shape is compiled as written, each time.
      if (e instanceof Unsupported) return null;
      throw e;
    }
  }
  const order = q.params.map((name) => (name.startsWith(HOLE) ? Number(name.slice(HOLE.length)) : name));
  const prepared = db.preparePlan?.(q.statement);
  return { columns: q.columns, order, run: prepared ? (bound) => prepared.result(bound as readonly never[]) : (bound) => db.queryPlan(q.statement, bound) };
}
