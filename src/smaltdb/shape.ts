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

/** Each database's shapes; `null` for one the compiler refused with its values taken out. */
const shapes = new WeakMap<object, Map<string, Kept | null>>();
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

// One walk does both jobs, so they can't disagree on which values are taken out or in which order: `key` is the shape
// as text and `values` what was taken out; with `build`, the walk also returns the plan with a parameter in each
// one's place.
let key = '';
let values: unknown[] = [];
let given: Readonly<Record<string, unknown>> = {};
let build = false;
/** Set by the walk when the plan holds a value the compiler needs written out (`degree()`'s direction and type). */
let asWritten = false;
/** How many lists and maps the query builds the walk is inside: their values stay written. */
let building = 0;
/** Set for the map the walk reaches next when it is a pattern's property map. */
let conditions = false;

/** A value written in the query: taken out if smaltdb compares it as the value it is, else part of the shape. */
function literal(x: { readonly k: 'lit'; readonly v: unknown }): unknown {
  const v = x.v;
  const kind = building === 0 && (typeof v === 'string' || typeof v === 'number') ? paramKind(v) : '';
  if (kind === 'text' || kind === 'int' || kind === 'real') {
    key += kind === 'text' ? '?t' : kind === 'int' ? '?i' : '?r';
    values.push(v);
    return build ? { k: 'param', name: HOLE + (values.length - 1) } : x;
  }
  key += '!';
  plain(v);
  return x;
}

/** A parameter: its name and the kind of its value, and with `pinned` the value. */
function parameter(x: { readonly k: 'param'; readonly name: string }, pinned: boolean): void {
  const v = given[x.name];
  key += `$${x.name.length}:${x.name}:${x.name in given ? paramKind(v) : 'missing'}`;
  if (pinned) {
    key += '=';
    plain(v);
  }
}

/** A value that stays in the shape as it is. */
function plain(v: unknown): void {
  if (typeof v === 'string') key += `${v.length}:${v}`;
  else if (typeof v === 'number') key += Object.is(v, -0) ? '#-0' : `#${v}`;
  else if (v === null || v === undefined) key += 'N';
  else if (typeof v === 'boolean') key += v ? 'T' : 'F';
  else if (Array.isArray(v)) {
    key += '[';
    for (const item of v) {
      plain(item);
      key += ',';
    }
    key += ']';
  } else if (typeof v === 'object') {
    key += '{';
    for (const k in v) {
      key += `${k}=`;
      plain((v as Record<string, unknown>)[k]);
      key += ';';
    }
    key += '}';
  } else key += `<${typeof v}>`;
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
    key += '[';
    let out: unknown[] | undefined;
    for (let i = 0; i < x.length; i++) {
      const w = walk(x[i]);
      key += ',';
      if (build && w !== x[i]) (out ??= x.slice())[i] = w;
    }
    key += ']';
    return out ?? x;
  }
  const o = x as Record<string, unknown>;
  if (o.k === 'lit') return literal(o as { readonly k: 'lit'; readonly v: unknown });
  if (o.k === 'param') {
    parameter(o as { readonly k: 'param'; readonly name: string }, false);
    return x;
  }
  const limit = o.op === 'limit';
  if (o.k === 'call' && o.fn === 'degree' && Array.isArray(o.args) && o.args.length > 1) asWritten = true;
  // A list, or a map that isn't a pattern's property map: a value the query builds.
  const built = o.k === 'list' || (o.k === 'map' && !conditions);
  conditions = false;
  if (built) building++;
  key += '{';
  let out: Record<string, unknown> | undefined;
  for (const k in o) {
    const v = o[k];
    if (v === undefined) continue;
    key += `${k}=`;
    if (limit && (k === 'count' || k === 'skip')) written(v);
    else {
      // The property map of a pattern's node or relationship (`Pattern` in plan/ops.ts: both have a `slot`).
      conditions = k === 'props' && typeof o.slot === 'number';
      const w = walk(v);
      conditions = false;
      if (build && w !== v) (out ??= { ...o })[k] = w;
    }
    key += ';';
  }
  key += '}';
  if (built) building--;
  return out ?? x;
}

/** A query's shape as text, and the values taken out of it. */
function shapeOf(gp: QueryPlan, tables: GraphTables, params: Readonly<Record<string, unknown>>): { key: string; values: unknown[] } {
  key = `${signature(tables)}|`;
  values = [];
  given = params;
  build = false;
  building = 0;
  conditions = false;
  walk(gp);
  return { key, values };
}

/** A query with a parameter where each value was taken out: `shapeOf`'s values, under the names `HOLE` and their number. */
function withHoles(gp: QueryPlan, params: Readonly<Record<string, unknown>>): QueryPlan {
  key = '';
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
  const shape = shapeOf(gp, tables, params);
  if (shape.values.length > MAX_HOLES) return undefined;
  let mine = shapes.get(db);
  if (!mine) shapes.set(db, (mine = new Map()));
  let kept = mine.get(shape.key);
  if (kept === undefined) {
    kept = keep(db, gp, tables, params, shape.values);
    mine.set(shape.key, kept);
    if (mine.size > MAX_SHAPES) mine.delete(mine.keys().next().value!);
  }
  if (kept === null) return undefined;
  const order = kept.order;
  const bound: unknown[] = new Array(order.length);
  for (let i = 0; i < order.length; i++) {
    const p = order[i]!;
    if (typeof p === 'number') bound[i] = shape.values[p];
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
