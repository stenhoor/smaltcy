/**
 * smaltcy's graph plans compiled to smaltdb plans (ADR 0004; smaltdb ADR 0033, step 8), beside smaltcy's own engine.
 * The compiler keeps Cypher's meaning where smaltdb's differs (smaltdb ADR 0033, decision 13): comparisons across
 * kinds, booleans apart from integers, checking division, NULLs last in ORDER BY, Cypher's order of kinds, lists and
 * maps compared element by element, `+` of strings and numbers as JavaScript writes them, `%` of floats.
 *
 * What it can't compile yet it refuses with an `Unsupported` error that names it, never a plan that would give a
 * different answer. Where only the values a query reads show that it can't keep Cypher's meaning (lists nested deeper
 * than `NESTING`, maps in ORDER BY), the plan raises an error when it meets them (smaltdb's `raise_error`), with
 * `Unsupported`'s code and message. Cypher's own errors that only the values show (a type error, division by zero) are
 * raised the same way, with the code and message smaltcy's engine gives.
 *
 * Plans are built as plain data: smaltdb is not a runtime dependency of smaltcy yet, so this module imports its types
 * only. A node in a row is two columns, its id and its `props` map; a relationship five (its type's name, its rowid in
 * that type's edge table, its start and end, its props); a variable-length relationship's list one, its hops as
 * smaltdb's `paths` gives them; a path two (its first node and its hops); any other value is one column with a static
 * type.
 */
import type { plan, PlanColumn, PlanStatementInput } from 'smaltdb/engine';
import { SmaltcyError, type ErrorCode } from '../errors.js';
import type { Expr } from '../plan/expr.js';
import type { AggCall, Direction, GraphPlan, Op, Pattern, PatternRel, Projection, SortKey } from '../plan/ops.js';
import type { GraphTables } from './schema.js';

type PlanOp = plan.PlanOp;
type PlanExpr = plan.PlanExpr;
type PlanType = plan.PlanType;

/** What the compiler can't compile yet: `feature` names it. */
export class Unsupported extends SmaltcyError {
  constructor(readonly feature: string) {
    super('SMALTCY_UNSUPPORTED', `Not supported on smaltdb yet: ${feature}`);
    this.name = 'Unsupported';
  }
}

const unsupported = (feature: string): never => {
  throw new Unsupported(feature);
};

/** A query compiled to smaltdb: its statement, and the parameters it reads, by position. */
export interface CompiledQuery {
  readonly statement: PlanStatementInput;
  /** Result column names, as smaltcy's engine gives them. */
  readonly columns: readonly string[];
  /** Parameter names, in the order of smaltdb's positional parameters. */
  readonly params: readonly string[];
}

export interface CompileOptions {
  /**
   * The parameters the query will run with: their values type the plan's parameters (a boolean is a `bool`, a whole
   * number an `int`). A parameter not given here is refused.
   */
  readonly params?: Readonly<Record<string, unknown>>;
  /**
   * The past to read, found already (the runner resolves `AT VERSION` and `AT TIME` against the history): replaces
   * the plan's own `asOf`, which is otherwise read from its literal or parameter.
   */
  readonly asOf?: AsOf;
  /**
   * The most join regions a MATCH's pattern splits into (default 1). A relationship of several types, or read both
   * ways, is a scan of its edge table for each type and reading, each in a region of its own, as long as their number
   * stays within this; past it, it is the union of those scans, one FROM item of the region. smaltdb's planner seeks
   * into the scans with their indexes, not into the union, but it can't tell how few rows a property match gives, so
   * it joins with hashes either way, and a region per reading repeats the rest of the pattern: slower today
   * (docs/research/benchmarks.md, "smaltdb").
   */
  readonly maxBranches?: number;
}

/** The past a query reads (`AT VERSION`, `AT TIME`): a smaltdb commit id, or a time in milliseconds since 1970. */
export type AsOf = { readonly commit: number } | { readonly time: number };

/**
 * A plan's `AT VERSION` or `AT TIME`, its literal or parameter read and checked as smaltcy's engine checks it: a
 * version is a whole number (a smaltdb commit id, ADR 0004), a time milliseconds since 1970, an ISO 8601 text or a
 * `Date`. Undefined when the plan reads the present.
 */
export function asOfOf(gp: GraphPlan, params: Readonly<Record<string, unknown>>): AsOf | undefined {
  if (gp.kind !== 'query' || !gp.asOf) return undefined;
  const value = (x: Expr): unknown => {
    if (x.k === 'lit') return x.v;
    if (x.k === 'param') {
      const v = params[x.name];
      if (v === undefined) throw new SmaltcyError('SMALTCY_PARAM', `Missing parameter $${x.name}`);
      return v;
    }
    throw new SmaltcyError('SMALTCY_PLAN', 'asOf takes a literal or a parameter');
  };
  if ('version' in gp.asOf) {
    const v = value(gp.asOf.version);
    if (typeof v !== 'number' || !Number.isInteger(v)) throw new SmaltcyError('SMALTCY_TYPE', `AT VERSION takes a whole number, not ${JSON.stringify(v)}`);
    return { commit: v };
  }
  const t = value(gp.asOf.time);
  const ms = typeof t === 'number' ? t : typeof t === 'string' ? Date.parse(t) : t instanceof Date ? t.getTime() : NaN;
  if (!Number.isFinite(ms)) throw new SmaltcyError('SMALTCY_TYPE', `AT TIME takes milliseconds since 1970 or an ISO 8601 date and time, not ${JSON.stringify(t)}`);
  return { time: ms };
}

/** smaltcy's error for a graph that keeps no history, asked for its past. */
export const noHistory = (): never => {
  throw new SmaltcyError('SMALTCY_UNSUPPORTED', 'The graph keeps no history, so it has no past versions to read');
};

/** smaltdb's table of commits (`id`, `time`, `author`, `message`): a database with a graph that keeps history has one. */
export const COMMITS_TABLE = 'smalt_commits';

/**
 * A compiled plan reading the past: every scan of the graph's tables (in subqueries too) reads them as of `asOf`.
 * smaltdb's `paths` reads its edge tables as they are now, so variable-length relationships and shortest paths are
 * refused (a shortest path's search, an `iterate`, too: it is compared with `paths` only in the present).
 */
function readAsOf<T>(x: T, t: GraphTables, asOf: AsOf): T {
  const graph = new Set([t.nodes, t.labels, ...t.labelTables.values(), ...t.types.values()].map((n) => n.toLowerCase()));
  const at = 'commit' in asOf ? { commit: lit(asOf.commit) } : { time: lit(asOf.time) };
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    if (o.op === 'paths' || o.op === 'iterate') unsupported('variable-length relationships and shortest paths with AT VERSION or AT TIME (smaltdb reads them in the present)');
    const out = Object.fromEntries(Object.entries(o).map(([k, e]) => [k, walk(e)]));
    if (o.op === 'scan' && graph.has(String(o.table).toLowerCase())) out.asOf = at;
    return out;
  };
  return walk(x) as T;
}

/** The slots that appear once in a plan (where they are bound, as a pattern's anonymous node is): nothing reads them. */
function slotsOnce(gp: GraphPlan): Set<number> {
  const count = new Map<number, number>();
  const add = (s: unknown) => typeof s === 'number' && count.set(s, (count.get(s) ?? 0) + 1);
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (x === null || typeof x !== 'object') return;
    const o = x as Record<string, unknown>;
    add(o.slot);
    if (Array.isArray(o.slots)) o.slots.forEach(add);
    if (o.k === 'slot') add(o.i);
    Object.values(o).forEach(walk);
  };
  walk(gp);
  return new Set([...count].filter(([, n]) => n === 1).map(([s]) => s));
}

/** Compiles a graph plan (a query that reads) to a smaltdb query statement. */
export function compileQuery(gp: GraphPlan, tables: GraphTables, options: CompileOptions = {}): CompiledQuery {
  if (gp.kind !== 'query') return unsupported('index plans');
  const asOf = gp.asOf ? (options.asOf ?? asOfOf(gp, options.params ?? {})) : undefined;
  if (asOf && !tables.history) noHistory();
  const c = new Compiler(tables, options.params ?? {}, asOf, slotsOnce(gp), options.maxBranches);
  const { plan: root, frame } = c.op(gp.root);
  const exprs: PlanExpr[] = [];
  const columns: PlanColumn[] = [];
  for (const col of gp.columns) {
    const b = frame.slots.get(col.slot) ?? unsupported(`a result column (${col.name}) that isn't bound`);
    const v = c.valueOf(b);
    if (v.k === 'value') {
      exprs.push(v.e);
      columns.push({ name: col.name, type: v.t });
    } else {
      // A node, relationship or path as smaltcy's engine gives it in a result: a map of its data.
      const r = c.resultValue(v);
      exprs.push(r.e);
      columns.push({ name: col.name, type: r.t });
    }
  }
  const plan: PlanOp = { op: 'project', input: root, exprs };
  return {
    statement: { kind: 'query', plan: asOf ? readAsOf(plan, tables, asOf) : plan, columns },
    columns: gp.columns.map((col) => col.name),
    params: c.paramNames,
  };
}

/** The values of a compiled query's parameters, in smaltdb's order. */
export function paramValues(q: CompiledQuery, params: Readonly<Record<string, unknown>>): unknown[] {
  return q.params.map((name) => {
    if (!(name in params)) throw new SmaltcyError('SMALTCY_PARAM', `Missing parameter $${name}`);
    const v = params[name];
    return typeof v === 'boolean' ? (v ? 1 : 0) : v;
  });
}

// Rows: what each slot is, as columns.

interface ValueBinding {
  readonly k: 'value';
  readonly col: number;
  readonly type: PlanType;
}
interface NodeBinding {
  readonly k: 'node';
  readonly id: number;
  readonly props: number;
}
/**
 * A relationship: its type's name, its rowid in that type's edge table (the pair is the relationship's identity), its
 * start and end nodes as stored, and its props.
 */
interface RelBinding {
  readonly k: 'rel';
  readonly type: number;
  readonly rowid: number;
  readonly start: number;
  readonly end: number;
  readonly props: number;
}
/** A list of relationships (a variable-length relationship's): its hops, as `HOPS`. */
interface RelsBinding {
  readonly k: 'rels';
  readonly hops: number;
}
/** A path: its first node's id and its hops (`HOPS`). */
interface PathBinding {
  readonly k: 'path';
  readonly start: number;
  readonly hops: number;
}
/** A list of nodes (`collect(n)`, `nodes(p)`): their ids. */
interface NodesBinding {
  readonly k: 'nodes';
  readonly ids: number;
}
export type Binding = ValueBinding | NodeBinding | RelBinding | RelsBinding | PathBinding | NodesBinding;

/** A binding with its columns moved by `f`. */
function moveBinding(b: Binding, f: (col: number) => number): Binding {
  switch (b.k) {
    case 'value': return { ...b, col: f(b.col) };
    case 'node': return { k: 'node', id: f(b.id), props: f(b.props) };
    case 'rel': return { k: 'rel', type: f(b.type), rowid: f(b.rowid), start: f(b.start), end: f(b.end), props: f(b.props) };
    case 'rels': return { k: 'rels', hops: f(b.hops) };
    case 'path': return { k: 'path', start: f(b.start), hops: f(b.hops) };
    case 'nodes': return { k: 'nodes', ids: f(b.ids) };
  }
}

/** The columns of a plan's rows, and the slots they hold. */
export interface Frame {
  readonly types: readonly PlanType[];
  readonly slots: ReadonlyMap<number, Binding>;
}

export interface Rel {
  readonly plan: PlanOp;
  readonly frame: Frame;
}

/** An expression's value: a typed value, a node (its id and props) or a relationship (as `RelBinding`'s columns). */
type NodeVal = { readonly k: 'node'; readonly id: PlanExpr; readonly props: PlanExpr };
type RelVal = { readonly k: 'rel'; readonly type: PlanExpr; readonly rowid: PlanExpr; readonly start: PlanExpr; readonly end: PlanExpr; readonly props: PlanExpr };
type RelsVal = { readonly k: 'rels'; readonly hops: PlanExpr };
type PathVal = { readonly k: 'path'; readonly start: PlanExpr; readonly hops: PlanExpr };
type NodesVal = { readonly k: 'nodes'; readonly ids: PlanExpr };
export type Val = { readonly k: 'value'; readonly e: PlanExpr; readonly t: PlanType } | NodeVal | RelVal | RelsVal | PathVal | NodesVal;

/** A map of these entries, as a result gives a node, relationship or path. */
const resultMapOf = (entries: readonly (readonly [string, PlanExpr])[]): PlanExpr => call('map_of', entries.flatMap(([k, e]) => [lit(k), e]), PROPS);

/** An expression that is NULL exactly when the value is. */
function nullTest(v: Val): PlanExpr {
  switch (v.k) {
    case 'value': return v.e;
    case 'node': return v.id;
    case 'rel': return v.rowid;
    case 'rels': case 'path': return v.hops;
    case 'nodes': return v.ids;
  }
}

/** What a graph value is called in a message. */
const entity = (v: Exclude<Val, { k: 'value' }>) =>
  ({ node: 'a node', rel: 'a relationship', rels: 'a list of relationships', path: 'a path', nodes: 'a list of nodes' })[v.k];

/**
 * A path's hops, as smaltdb's `paths` gives them (`PATH_TYPE`): per hop, its type's position in the graph's types
 * (`GraphTables.types`' order), its rowid, and the nodes it went from and to, in the pattern's direction.
 */
export const HOP: PlanType = 'struct<edge int, rowid int, from int, to int>';
export const HOPS: PlanType = `list<${HOP}>`;
/** A relationship as a list element: `RelBinding`'s columns. */
const REL: PlanType = `struct<type text, rowid int, start int, end int, props map<text, any>>`;
/** A node as a list element. */
const NODE: PlanType = 'struct<id int, props map<text, any>>';
export const IDS: PlanType = 'list<int>';
/** A path found from a node (`Compiler.pathsFrom`): where it ends, its length, its hops. */
const FOUND: PlanType = `struct<last int, len int, hops ${HOPS}>`;

/** What a list comprehension's element is: a value, or a node or relationship read from a `NODE` or `REL` struct. */
type ElementKind = 'value' | 'node' | 'rel';

export const PROPS: PlanType = 'map<text, any>';

/** Every slot an expression mentions (a list comprehension's own too: more than it reads, never less). */
function slotsIn(x: unknown, out: number[] = []): number[] {
  if (Array.isArray(x)) for (const y of x) slotsIn(y, out);
  else if (x !== null && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    if (o.k === 'slot' && typeof o.i === 'number') out.push(o.i);
    for (const v of Object.values(o)) slotsIn(v, out);
  }
  return out;
}

/** The columns of an edge source (`Compiler.edges`): the relationship's columns, then its ends as the pattern reads them. */
const EDGE_TYPES: readonly PlanType[] = ['text', 'int', 'int', 'int', PROPS, 'int', 'int'];
const E_TYPE = 0;
const E_ROWID = 1;
const E_START = 2;
const E_END = 3;
const E_PROPS = 4;
/** The end at the pattern's `from` node. */
const E_FROM = 5;
/** The end at the pattern's `to` node. */
const E_TO = 6;

/**
 * One way a pattern matches, as a smaltdb join region: its FROM items (bare scans, and the input first), its
 * conditions over their columns, the row's columns as expressions over them, and the order its rows keep (`keys`, when
 * the order is asked for).
 */
interface Branch {
  readonly leaves: PlanOp[];
  width: number;
  readonly conds: PlanExpr[];
  readonly out: PlanExpr[];
  readonly keys: PlanExpr[];
}

const cloneBranch = (b: Branch): Branch => ({ leaves: [...b.leaves], width: b.width, conds: [...b.conds], out: [...b.out], keys: [...b.keys] });

/** Adds a FROM item to a branch: the position of its first column. */
function addLeaf(b: Branch, op: PlanOp, width: number): number {
  b.leaves.push(op);
  const at = b.width;
  b.width += width;
  return at;
}

/** An expression of the row (its columns `col` at depth 0) as one over a branch's FROM items, whose columns `out` gives. */
function inline(e: PlanExpr, out: readonly PlanExpr[]): PlanExpr {
  const walk = (x: unknown, level: number): unknown => {
    if (Array.isArray(x)) return x.map((y) => walk(y, level));
    if (x === null || typeof x !== 'object') return x;
    const o = x as Record<string, unknown>;
    // The row's columns: at depth 0 here, one deeper in each subquery.
    if (o.k === 'col' && o.depth === level && (level > 0 || o.input === 0)) {
      let r = out[o.index as number]!;
      for (let i = 0; i < level; i++) r = deepen(r);
      return r;
    }
    const nested = o.k === 'subquery' || o.k === 'inSubquery';
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, walk(v, nested && k === 'plan' ? level + 1 : level)]));
  };
  return walk(e, 0) as PlanExpr;
}

/** A condition's conjuncts. */
const conjuncts = (e: PlanExpr): PlanExpr[] => (e.k === 'and' ? e.args.flatMap(conjuncts) : [e]);

/** Functions that never raise an error: a condition of only these can be evaluated on any row, in any order. */
const SAFE_FNS = new Set(['cmp_eq', 'cmp_ne', 'cmp_lt', 'cmp_le', 'cmp_gt', 'cmp_ge', 'map_get', 'any_type', 'in_list', 'starts_with', 'ends_with', 'struct_field', 'coalesce']);

/**
 * Whether evaluating a condition may raise an error (Cypher's type errors, arithmetic, a value the compiler refuses
 * when met): such conditions filter a region's rows rather than join it, so they see only the rows that match, as in
 * smaltcy's engine.
 */
function canRaise(x: unknown): boolean {
  if (Array.isArray(x)) return x.some(canRaise);
  if (x === null || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (o.k === 'cast' || (o.k === 'call' && !SAFE_FNS.has(o.fn as string))) return true;
  return Object.values(o).some(canRaise);
}

// Expression builders: plain data, as smaltdb's `plan` builders make them.

export const colRef = (index: number, type: PlanType, depth = 0): PlanExpr => ({ k: 'col', input: 0, index, depth, type, collation: 'binary' });
/** A column of a join's right input. */
const rightRef = (index: number, type: PlanType): PlanExpr => ({ k: 'col', input: 1, index, depth: 0, type, collation: 'binary' });
/** A column of the enclosing row, one subquery in. */
const outerRef = (e: PlanExpr, what: string): PlanExpr => (e.k === 'col' ? { ...e, depth: e.depth + 1 } : unsupported(`${what} of a computed value`));

/** An expression of the enclosing row, read one subquery in: its columns one level out. */
function deepen(e: PlanExpr): PlanExpr {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x === null || typeof x !== 'object') return x;
    const o = x as Record<string, unknown>;
    if (o.k === 'col') return { ...o, depth: (o.depth as number) + 1 };
    if (o.k === 'subquery' || o.k === 'inSubquery') return unsupported('a nested plan read from a subquery');
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, walk(v)]));
  };
  return walk(e) as PlanExpr;
}
export function lit(value: unknown, type?: PlanType): PlanExpr {
  if (typeof value === 'boolean') return { k: 'lit', value: value ? 1 : 0, type: 'bool' };
  const t = type ?? (value === null ? 'null' : typeof value === 'number' ? (Number.isSafeInteger(value) ? 'int' : 'real') : typeof value === 'string' ? 'text' : unsupported(`a literal ${JSON.stringify(value)}`));
  return { k: 'lit', value: value as never, type: t };
}
/** A literal and its type. */
function literal(v: unknown): Val {
  const e = lit(v);
  return { k: 'value', e, t: (e as { type: PlanType }).type };
}
export const call = (fn: string, args: readonly PlanExpr[], type: PlanType): PlanExpr => ({ k: 'call', fn, args, type });
export const and = (...args: PlanExpr[]): PlanExpr => (args.length === 1 ? args[0]! : { k: 'and', args });
export const or = (...args: PlanExpr[]): PlanExpr => (args.length === 1 ? args[0]! : { k: 'or', args });
const not = (arg: PlanExpr): PlanExpr => ({ k: 'not', arg });
export const isNull = (arg: PlanExpr): PlanExpr => ({ k: 'isNull', arg, not: false });
const isNotNull = (arg: PlanExpr): PlanExpr => ({ k: 'isNull', arg, not: true });
export const caseWhen = (whens: readonly (readonly [PlanExpr, PlanExpr])[], otherwise: PlanExpr, type: PlanType): PlanExpr =>
  whens.length ? { k: 'case', whens: whens.map(([when, then]) => ({ when, then })), else: otherwise, type } : otherwise;
export const eq = (a: PlanExpr, b: PlanExpr) => call('cmp_eq', [a, b], 'bool');
export const NULL = lit(null);
const TRUE = lit(true);
const FALSE = lit(false);
const INFINITY: PlanExpr = { k: 'lit', value: Infinity, type: 'real' };

/**
 * An error raised when a row reaches it (smaltdb's `raise_error`, which a CASE branch not taken doesn't evaluate): a
 * smaltcy error code and its message, text or an expression giving text.
 */
const raise = (code: ErrorCode, message: string | PlanExpr, type: PlanType = 'any'): PlanExpr =>
  call('raise_error', [typeof message === 'string' ? lit(message) : message, lit(code)], type);
/** What a plan does with values whose Cypher meaning it can't keep yet: `Unsupported`'s code and message, when a row meets them. */
const refuseWhenMet = (feature: string, type: PlanType = 'any'): PlanExpr => raise('SMALTCY_UNSUPPORTED', new Unsupported(feature).message, type);
/** Text joined from literal parts and text expressions: an error's message. */
const message = (...parts: (string | PlanExpr)[]): PlanExpr =>
  parts.map((p) => (typeof p === 'string' ? lit(p) : p)).reduce((a, b) => call('text_concat', [a, b], 'text'));

// Cypher's kinds of values, and their order in ORDER BY (smaltcy's `orderCompare`): maps, nodes, relationships, lists,
// paths, strings, booleans, numbers, NaN, then NULL.
const K_MAP = 0;
const K_LIST = 3;
const K_STRING = 5;
const K_BOOL = 6;
const K_NUMBER = 7;
const K_NAN = 8;
const K_NULL = 9;
/** Other smaltdb types (blobs, dates): no Cypher kind. */
const K_OTHER = 10;

/** The kind of every value of a static type, or undefined when only the value tells (`any`). */
function staticKind(t: PlanType): number | undefined {
  if (t === 'int' || t === 'real' || t === 'num') return K_NUMBER;
  if (t === 'text') return K_STRING;
  if (t === 'bool') return K_BOOL;
  if (t === 'null') return K_NULL;
  if (t === 'any') return undefined;
  if (t.startsWith('list<')) return K_LIST;
  if (t.startsWith('map<')) return K_MAP;
  return K_OTHER;
}

const isNumberType = (t: PlanType) => t === 'int' || t === 'real' || t === 'num';

/** Whether a number's value may be NaN (a real, or a value of unknown type). */
const mayBeNaN = (t: PlanType) => t !== 'int';

/**
 * A string literal, or a number literal smaltdb holds as the number it is (an integer JavaScript holds exactly, or a
 * float that isn't whole or NaN): where a plain comparison with a value of any kind keeps Cypher's meaning.
 */
function scalarLiteral(v: Val): v is { k: 'value'; e: PlanExpr; t: PlanType } {
  if (v.k !== 'value' || v.e.k !== 'lit') return false;
  const { type, value } = v.e;
  return (
    (type === 'text' && typeof value === 'string') ||
    (type === 'int' && Number.isSafeInteger(value)) ||
    (type === 'real' && typeof value === 'number' && !Number.isInteger(value) && !Number.isNaN(value))
  );
}

/** The kind of a value at run time, as one of the K_ codes (NULL: K_NULL; NaN: K_NUMBER). */
function kindExpr(v: { e: PlanExpr; t: PlanType }): PlanExpr {
  const k = staticKind(v.t);
  if (k !== undefined) return caseWhen([[isNull(v.e), lit(K_NULL)]], lit(k), 'int');
  const type = call('any_type', [v.e], 'text');
  const starts = (prefix: string) => call('starts_with', [type, lit(prefix)], 'bool');
  return caseWhen(
    [
      [isNull(v.e), lit(K_NULL)],
      [call('in_list', [type, lit('int'), lit('real')], 'bool'), lit(K_NUMBER)],
      [eq(type, lit('text')), lit(K_STRING)],
      [eq(type, lit('bool')), lit(K_BOOL)],
      [starts('list<'), lit(K_LIST)],
      [starts('map<'), lit(K_MAP)],
    ],
    lit(K_OTHER),
    'int',
  );
}

/** Whether a value of any kind that isn't NULL is a number: `kindExpr`'s test for numbers, reading the value once. */
const isNumber = (v: { e: PlanExpr }): PlanExpr => call('in_list', [call('any_type', [v.e], 'text'), lit('int'), lit('real')], 'bool');

/**
 * The name of a value's type as smaltcy's errors give it (`typeName`): NULL, BOOLEAN, INTEGER (a number with a whole
 * value), FLOAT, STRING, LIST or MAP; smaltdb's own type for other values.
 */
function typeNameExpr(v: { e: PlanExpr; t: PlanType }): PlanExpr {
  const k = staticKind(v.t);
  const named = new Map([[K_STRING, 'STRING'], [K_BOOL, 'BOOLEAN'], [K_LIST, 'LIST'], [K_MAP, 'MAP'], [K_NULL, 'NULL']]);
  const name = k === undefined ? undefined : named.get(k);
  if (name !== undefined) return caseWhen([[isNull(v.e), lit('NULL')]], lit(name), 'text');
  // A number's (or any value's) type as smaltdb reads it: a real with a whole value reads as an int, as smaltcy's
  // JavaScript numbers are integers then.
  const type = call('any_type', [v.e], 'text');
  const starts = (prefix: string) => call('starts_with', [type, lit(prefix)], 'bool');
  return caseWhen(
    [
      [isNull(v.e), lit('NULL')],
      [eq(type, lit('int')), lit('INTEGER')],
      [eq(type, lit('real')), lit('FLOAT')],
      [eq(type, lit('text')), lit('STRING')],
      [eq(type, lit('bool')), lit('BOOLEAN')],
      [starts('list<'), lit('LIST')],
      [starts('map<'), lit('MAP')],
    ],
    type,
    'text',
  );
}

/** A value of kind boolean as a static `bool` (a boolean under `any` is a typed value, which never equals a plain 1). */
const asBoolValue = (v: { e: PlanExpr; t: PlanType }): PlanExpr => (v.t === 'any' ? call('any_bool', [v.e], 'bool') : v.e);

/** Whether a number is NaN: smaltdb orders NaN after every number, Infinity included. */
const isNaNExpr = (e: PlanExpr) => call('cmp_gt', [e, INFINITY], 'bool');

/** A static type both values fit, for CASE, coalesce, lists and union columns: undefined when only `any` would do and a boolean or nested value would lose its type there. */
function commonType(types: readonly PlanType[]): PlanType | undefined {
  const ts = [...new Set(types.filter((t) => t !== 'null'))];
  if (ts.length === 0) return 'null';
  if (ts.length === 1) return ts[0];
  if (ts.every(isNumberType)) return 'num';
  // Under `any`, ints, reals and text keep what they are; a static bool or a list would become an integer or a blob.
  if (ts.every((t) => isNumberType(t) || t === 'text' || t === 'any')) return 'any';
  return undefined;
}

// Lists and maps compared and ordered element by element with Cypher's meaning, `+` and `%` as smaltcy's engine
// computes them (ADR 0004). smaltdb compares a list or a map by its bytes, so the compiler goes through their elements
// with `each`, one level of nesting at a time.

/**
 * How deep lists and maps nest where the compiler reads their elements (`=`, `<`, ORDER BY, min and max): a list of
 * lists of lists of lists. Each level is its own part of the plan; a value nested deeper raises `Unsupported` when a
 * row reaches it, never a different answer.
 */
export const NESTING = 4;

/** A value and its static type. */
type Typed = { readonly e: PlanExpr; readonly t: PlanType };

const tooDeep = (type: PlanType): PlanExpr => refuseWhenMet(`lists and maps nested more than ${NESTING} deep`, type);
const otherKind = (type: PlanType): PlanExpr => refuseWhenMet('comparing or ordering values of other types', type);

/** NULL typed `any`: beside it, `list_of` keeps its other arguments' types (smaltdb ADR 0039). */
const NULL_ANY: PlanExpr = { k: 'lit', value: null, type: 'any' };
const NAN: PlanExpr = { k: 'lit', value: NaN, type: 'real' };
const NEG_INFINITY: PlanExpr = { k: 'lit', value: -Infinity, type: 'real' };

/** The element type of a list type. */
const elemType = (t: PlanType): PlanType => (t.startsWith('list<') ? (t.slice(5, -1) as PlanType) : 'any');
/** Whether a value of static type `t` may be of kind `k`. */
const may = (v: Typed, k: number) => {
  const s = staticKind(v.t);
  return s === undefined || s === k;
};
/** A value in an `any` place: a boolean, a list or a map keeps its kind there (a typed value), as Cypher's do. */
function asAny(v: Typed): PlanExpr {
  if (v.t !== 'bool' && !v.t.startsWith('list<') && !v.t.startsWith('map<') && !v.t.startsWith('struct<')) return v.e;
  return call('list_get', [call('list_of', [v.e, NULL_ANY], 'list<any>'), lit(0)], 'any');
}

/** A list, as a static list type or one read from `any`. */
const asList = (v: Typed): Typed => (staticKind(v.t) === K_LIST ? v : { e: call('any_list', [v.e], 'list<any>'), t: 'list<any>' });
/** A map, as a static map type or one read from `any`. */
const asMap = (v: Typed): Typed => (staticKind(v.t) === K_MAP ? v : { e: call('any_map', [v.e], PROPS), t: PROPS });
const mapValueType = (t: PlanType): PlanType => t.slice(10, -1) as PlanType;
/** A list's element at a position. */
const at = (list: Typed, pos: PlanExpr): Typed => ({ e: call('list_get', [list.e, pos], elemType(list.t)), t: elemType(list.t) });
const len = (list: Typed): PlanExpr => call('list_len', [list.e], 'int');

/** -1, 0 or 1 as `a` is less than, equal to or greater than `b` (neither NULL). */
const sign3 = (a: PlanExpr, b: PlanExpr): PlanExpr => caseWhen([[call('cmp_lt', [a, b], 'bool'), lit(-1)], [call('cmp_gt', [a, b], 'bool'), lit(1)]], lit(0), 'int');
/** A boolean as 0 or 1. */
const boolInt = (v: Typed): PlanExpr => caseWhen([[asBoolValue(v), lit(1)]], lit(0), 'int');

// The builders below make `each` expressions whose element, position and aggregates their bodies read as variables;
// `bindVars` turns those into smaltdb's `element` and `eachAgg`, with the depths the nesting gives them.

let lastVar = 0;
const variable = (id: number, part: 'value' | 'position' | 'agg', type: PlanType, index = 0): PlanExpr => ({ k: 'var', id, part, type, index }) as unknown as PlanExpr;

/** `each` over a list: `body` reads its element and position. */
function eachOf(list: Typed, mode: 'map' | 'filter', type: PlanType, body: (el: Typed, pos: PlanExpr) => PlanExpr): PlanExpr {
  const id = ++lastVar;
  const t = elemType(list.t);
  return { k: 'each', mode, list: list.e, body: body({ e: variable(id, 'value', t), t }, variable(id, 'position', 'int')), type, bind: id } as unknown as PlanExpr;
}

/** `each` with aggregates over a list's elements: `body` reads their results. */
function eachAggOf(list: Typed, aggs: (el: Typed) => plan.AggCall[], body: (agg: (i: number) => PlanExpr) => PlanExpr, type: PlanType): PlanExpr {
  const id = ++lastVar;
  const t = elemType(list.t);
  return { k: 'each', mode: 'agg', list: list.e, aggs: aggs({ e: variable(id, 'value', t), t }), body: body((i) => variable(id, 'agg', 'int', i)), type, bind: id } as unknown as PlanExpr;
}

/** An expression read where it is cheap to read again: a column, literal, parameter or element. */
const cheap = (e: PlanExpr) => ['col', 'lit', 'param', 'var', 'element'].includes(e.k);

/** `body` of a value computed once (an `each` over a list of it), or the value itself when it is cheap to read again. */
function letIn(v: Typed, type: PlanType, body: (x: Typed) => PlanExpr): PlanExpr {
  if (cheap(v.e)) return body(v);
  const lt: PlanType = `list<${v.t === 'null' ? 'any' : v.t}>`;
  return call('list_get', [eachOf({ e: call('list_of', [v.e], lt), t: lt }, 'map', `list<${type}>`, (x) => body(x)), lit(0)], type);
}

/**
 * The builders' variables as smaltdb's `element` and `eachAgg`: a variable's depth is the number of `each` between it
 * and the one that binds it. An `element` or `eachAgg` made elsewhere (a list comprehension's) counts only the `each`s
 * made elsewhere, so the builders' are added to its depth.
 */
function bindVars(e: PlanExpr): PlanExpr {
  const walk = (x: unknown, stack: readonly (number | null)[]): unknown => {
    if (Array.isArray(x)) return x.map((y) => walk(y, stack));
    if (x === null || typeof x !== 'object') return x;
    const o = x as Record<string, unknown>;
    if (o.k === 'var') {
      const i = stack.lastIndexOf(o.id as number);
      if (i < 0) throw new SmaltcyError('SMALTCY_PLAN', 'a variable outside its each');
      const depth = stack.length - 1 - i;
      return o.part === 'agg' ? { k: 'eachAgg', index: o.index, depth, type: o.type } : { k: 'element', part: o.part, depth, type: o.type };
    }
    if (o.k === 'element' || o.k === 'eachAgg') {
      let skip = o.depth as number;
      let j = stack.length - 1;
      for (; j >= 0; j--) {
        if (stack[j] !== null) continue;
        if (skip === 0) break;
        skip--;
      }
      return { ...o, depth: j >= 0 ? stack.length - 1 - j : stack.length + skip };
    }
    if (o.k === 'each') {
      const { bind, ...rest } = o;
      const inner = [...stack, typeof bind === 'number' ? bind : null];
      return { ...rest, list: walk(o.list, stack), body: walk(o.body, inner), ...(o.aggs ? { aggs: walk(o.aggs, inner) } : {}) };
    }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, walk(v, stack)]));
  };
  return walk(e, []) as PlanExpr;
}

const countWhere = (filter: PlanExpr): plan.AggCall => ({ fn: 'count', args: [], star: true, distinct: false, filter, collation: 'binary', type: 'int' });

/** Cypher's AND over a list of booleans: false if one is false, else NULL if one is NULL, else true. */
function allTrue(results: PlanExpr): PlanExpr {
  return eachAggOf(
    { e: results, t: 'list<bool>' },
    (r) => [countWhere(eq(r.e, FALSE)), countWhere(isNull(r.e))],
    (n) => caseWhen([[call('cmp_gt', [n(0), lit(0)], 'bool'), FALSE], [call('cmp_gt', [n(1), lit(0)], 'bool'), NULL]], TRUE, 'bool'),
    'bool',
  );
}

/**
 * `body` of a value's kind (`kindExpr`: K_NULL for NULL), computed once: a literal where the static type tells it
 * (the value may still be NULL).
 */
function withKind(v: Typed, type: PlanType, body: (k: PlanExpr) => PlanExpr): PlanExpr {
  const s = staticKind(v.t);
  if (s === K_NULL) return body(lit(K_NULL));
  if (s !== undefined) return body(caseWhen([[isNull(v.e), lit(K_NULL)]], lit(s), 'int'));
  return letIn({ e: kindExpr(v), t: 'int' }, type, (k) => body(k.e));
}

/**
 * Cypher's `=` (smaltcy's `equals`): NULL with a NULL, false across kinds, numbers by value (NaN equals nothing), lists
 * element by element and maps by their keys, then their values (false at a difference, else NULL at a NULL). Lists and
 * maps nest `d` more levels.
 */
function valueEquals(x: Typed, y: Typed, d: number): PlanExpr {
  if (staticKind(x.t) === K_NULL || staticKind(y.t) === K_NULL) return NULL;
  const both = (k: number) => may(x, k) && may(y, k);
  return withKind(x, 'bool', (kx) =>
    withKind(y, 'bool', (ky) => {
      const whens: [PlanExpr, PlanExpr][] = [[or(eq(kx, lit(K_NULL)), eq(ky, lit(K_NULL))), NULL], [not(eq(kx, ky)), FALSE]];
      if (both(K_NUMBER)) whens.push([eq(kx, lit(K_NUMBER)), mayBeNaN(x.t) || mayBeNaN(y.t) ? and(eq(x.e, y.e), not(isNaNExpr(x.e))) : eq(x.e, y.e)]);
      if (both(K_STRING)) whens.push([eq(kx, lit(K_STRING)), eq(x.e, y.e)]);
      if (both(K_BOOL)) whens.push([eq(kx, lit(K_BOOL)), eq(asBoolValue(x), asBoolValue(y))]);
      if (both(K_LIST) || both(K_MAP)) whens.push([call('in_list', [kx, lit(K_LIST), lit(K_MAP)], 'bool'), d === 0 ? tooDeep('bool') : nestedEquals(x, y, kx, d - 1)]);
      return caseWhen(whens, NULL, 'bool');
    }),
  );
}

/**
 * `=` of two lists or two maps (neither NULL, of the same kind, `kx`): a map's values are compared in key order once
 * the keys are the same.
 */
function nestedEquals(x: Typed, y: Typed, kx: PlanExpr, d: number): PlanExpr {
  const lists = may(x, K_LIST) && may(y, K_LIST);
  const maps = may(x, K_MAP) && may(y, K_MAP);
  const isMap = !lists ? TRUE : !maps ? FALSE : eq(kx, lit(K_MAP));
  const values = (v: Typed): Typed => {
    const m = asMap(v);
    const t: PlanType = `list<${mapValueType(m.t)}>`;
    return { e: call('map_values', [m.e], t), t };
  };
  const seq = (v: Typed): Typed => (!maps ? asList(v) : !lists ? values(v) : { e: caseWhen([[isMap, values(v).e]], asList(v).e, 'list<any>'), t: 'list<any>' });
  const keys = (v: Typed) => call('map_keys', [asMap(v).e], 'list<text>');
  const sameKeys = !maps ? TRUE : !lists ? eq(keys(x), keys(y)) : caseWhen([[isMap, eq(keys(x), keys(y))]], TRUE, 'bool');
  return letIn(seq(x), 'bool', (a) =>
    letIn(seq(y), 'bool', (b) =>
      caseWhen(
        [[not(sameKeys), FALSE], [not(eq(len(a), len(b))), FALSE]],
        allTrue(eachOf(a, 'map', 'list<bool>', (el, pos) => letIn(at(b, pos), 'bool', (other) => valueEquals(el, other, d)))),
        'bool',
      ),
    ),
  );
}

/**
 * Cypher's `<` and the others as -1, 0 or 1 (smaltcy's `compare`): NULL with a NULL, across kinds, for NaN and for
 * maps; lists element by element, the first difference deciding (NULL where two elements don't compare), else the
 * shorter first. Lists nest `d` more levels.
 */
function valueCompare(x: Typed, y: Typed, d: number): PlanExpr {
  if (staticKind(x.t) === K_NULL || staticKind(y.t) === K_NULL) return NULL;
  const both = (k: number) => may(x, k) && may(y, k);
  return withKind(x, 'int', (kx) =>
    withKind(y, 'int', (ky) => {
      const whens: [PlanExpr, PlanExpr][] = [[or(eq(kx, lit(K_NULL)), not(eq(kx, ky))), NULL]];
      if (both(K_NUMBER)) whens.push([eq(kx, lit(K_NUMBER)), mayBeNaN(x.t) || mayBeNaN(y.t) ? caseWhen([[or(isNaNExpr(x.e), isNaNExpr(y.e)), NULL]], sign3(x.e, y.e), 'int') : sign3(x.e, y.e)]);
      if (both(K_STRING)) whens.push([eq(kx, lit(K_STRING)), sign3(x.e, y.e)]);
      if (both(K_BOOL)) whens.push([eq(kx, lit(K_BOOL)), sign3(asBoolValue(x), asBoolValue(y))]);
      if (both(K_LIST)) whens.push([eq(kx, lit(K_LIST)), d === 0 ? tooDeep('int') : listCompare(asList(x), asList(y), d - 1)]);
      return caseWhen(whens, NULL, 'int');
    }),
  );
}

/** `valueCompare` of two lists (neither NULL). */
function listCompare(a: Typed, b: Typed, d: number): PlanExpr {
  return letIn(a, 'int', (x) =>
    letIn(b, 'int', (y) => {
      const n = caseWhen([[call('cmp_lt', [len(x), len(y)], 'bool'), len(x)]], len(y), 'int');
      // Each element's comparison, NULL as 2; the first that isn't 0 decides.
      const each = eachOf({ e: call('list_slice', [x.e, lit(0), n], x.t), t: x.t }, 'map', 'list<int>', (el, pos) => call('coalesce', [letIn(at(y, pos), 'int', (other) => valueCompare(el, other, d)), lit(2)], 'int'));
      const first = call('list_get', [eachOf({ e: each, t: 'list<int>' }, 'filter', 'list<int>', (c) => not(eq(c.e, lit(0)))), lit(0)], 'int');
      return letIn({ e: first, t: 'int' }, 'int', (f) => caseWhen([[isNull(f.e), sign3(len(x), len(y))], [eq(f.e, lit(2)), NULL]], f.e, 'int'));
    }),
  );
}

/**
 * ORDER BY's keys for a value that may be a list (smaltcy's `orderCompare`): its kind's place in Cypher's order (NULL
 * for NULL), then a number, string or boolean as it is, then a list as `listKey`. Maps (ordered by smaltcy's
 * `groupKey` text) raise when met.
 */
function orderKeys(v: Typed): PlanExpr[] {
  const keys = (k: PlanExpr): PlanExpr[] => {
    const whens: [PlanExpr, PlanExpr][] = [[eq(k, lit(K_NULL)), NULL]];
    if (may(v, K_NUMBER)) whens.push([and(eq(k, lit(K_NUMBER)), isNaNExpr(v.e)), lit(K_NAN)]);
    if (may(v, K_MAP)) whens.push([eq(k, lit(K_MAP)), orderingMaps('int')]);
    if (staticKind(v.t) === undefined) whens.push([eq(k, lit(K_OTHER)), otherKind('int')]);
    const out = [caseWhen(whens, k, 'int')];
    if (staticKind(v.t) === undefined) out.push(caseWhen([[call('in_list', [k, lit(K_NUMBER), lit(K_STRING)], 'bool'), v.e], [eq(k, lit(K_BOOL)), boolInt(v)]], NULL, 'any'));
    if (may(v, K_LIST)) out.push(caseWhen([[eq(k, lit(K_LIST)), listKey(asList(v), NESTING - 1)]], NULL, orderListType(NESTING - 1)));
    return out;
  };
  // Each key is its own expression: the kind is computed in each.
  const n = keys(lit(0)).length;
  return Array.from({ length: n }, (_, i) => bindVars(withKind(v, i === 0 ? 'int' : i === n - 1 && may(v, K_LIST) ? orderListType(NESTING - 1) : 'any', (k) => keys(k)[i]!)));
}

const orderingMaps = (type: PlanType): PlanExpr => refuseWhenMet('ordering maps', type);

/** The struct a list's element is in `listKey`, whose nested lists nest `d` more levels. */
const orderStruct = (d: number): PlanType => (d > 0 ? `struct<c int, n any, s text, l ${orderListType(d - 1)}>` : 'struct<c int, n any, s text>');
const orderListType = (d: number): PlanType => `list<${orderStruct(d)}>`;

/**
 * A list as smaltdb orders it in Cypher's order: per element, its kind's place (`c`: lists, strings, booleans,
 * numbers, NaN, NULL), then its value: a number or boolean (`n`), a string (`s`), a nested list's own key (`l`).
 * smaltdb compares lists element by element, the shorter first, and structs field by field, as Cypher orders lists.
 */
function listKey(list: Typed, d: number): PlanExpr {
  return eachOf(list, 'map', orderListType(d), (x) =>
    withKind(x, orderStruct(d), (k) => {
      const cls: [PlanExpr, PlanExpr][] = [];
      if (may(x, K_NUMBER)) cls.push([and(eq(k, lit(K_NUMBER)), isNaNExpr(x.e)), lit(K_NAN)]);
      if (may(x, K_MAP)) cls.push([eq(k, lit(K_MAP)), orderingMaps('int')]);
      if (staticKind(x.t) === undefined) cls.push([eq(k, lit(K_OTHER)), otherKind('int')]);
      if (d === 0 && may(x, K_LIST)) cls.push([eq(k, lit(K_LIST)), tooDeep('int')]);
      const n: [PlanExpr, PlanExpr][] = [];
      if (may(x, K_NUMBER)) n.push([eq(k, lit(K_NUMBER)), x.e]);
      if (may(x, K_BOOL)) n.push([eq(k, lit(K_BOOL)), boolInt(x)]);
      const fields = [caseWhen(cls, k, 'int'), caseWhen(n, NULL, 'any'), may(x, K_STRING) ? caseWhen([[eq(k, lit(K_STRING)), x.e]], NULL, 'text') : NULL];
      if (d > 0) fields.push(may(x, K_LIST) ? caseWhen([[eq(k, lit(K_LIST)), listKey(asList(x), d - 1)]], NULL, orderListType(d - 1)) : NULL);
      return call('struct_of', fields, orderStruct(d));
    }),
  );
}

const ZEROS = lit('0'.repeat(330));
const zeros = (n: PlanExpr): PlanExpr => call('substr', [ZEROS, lit(1), n], 'text');
const concat = (...parts: (string | PlanExpr)[]): PlanExpr => message(...parts);
const textOf = (e: PlanExpr): PlanExpr => call('cast_text', [e], 'text');

/**
 * A number as JavaScript's `String(n)` writes it (smaltcy's `+` of a string and a number): the shortest digits that
 * read back as the number, in plain notation below 10^21 and in exponent notation from there; `NaN`, `Infinity`.
 */
function numberText(x: Typed): PlanExpr {
  const json = (v: Typed): PlanExpr => {
    // smaltdb's JSON of a list writes a number as `String(n)`, a whole number beyond 2^53 with all its digits.
    const t: PlanType = `list<${v.t === 'num' || v.t === 'null' ? 'any' : v.t}>`;
    return letIn({ e: textOf(call('list_of', [v.e], t)), t: 'text' }, 'text', (j) => call('substr', [j.e, lit(2), call('sub', [call('length', [j.e], 'int'), lit(2)], 'int')], 'text'));
  };
  return caseWhen(
    [
      [isNull(x.e), NULL],
      [isNaNExpr(x.e), lit('NaN')],
      [eq(x.e, INFINITY), lit('Infinity')],
      [eq(x.e, NEG_INFINITY), lit('-Infinity')],
      [call('cmp_lt', [call('abs', [x.e], x.t), lit(2 ** 53, 'real')], 'bool'), json(x)],
    ],
    letIn({ e: call('cast_real', [x.e], 'real'), t: 'real' }, 'text', (y) => {
      const sign = caseWhen([[call('cmp_lt', [y.e, lit(0)], 'bool'), lit('-')]], lit(''), 'text');
      return concat(sign, letIn({ e: call('abs', [y.e], 'real'), t: 'real' }, 'text', (z) => letIn({ e: json(z), t: 'text' }, 'text', (digits) => shortestText(z.e, digits.e))));
    }),
    'text',
  );
}

/**
 * `String(z)` of a whole number `z` from 2^53 (all its digits given): ECMAScript's Number::toString picks the fewest
 * digits `s` such that s × 10^k reads back as `z`, the nearest of those, the even one on a tie. The candidates with `p`
 * digits are `digits`' first `p` and one more; 17 always read back.
 */
function shortestText(z: PlanExpr, digits: PlanExpr): PlanExpr {
  // The candidates are text: smaltdb gives an integer beyond 2^53 that a double holds exactly as a double.
  const L = call('length', [digits], 'int');
  const T = (p: PlanExpr) => call('substr', [digits, lit(1), p], 'text');
  const U = (p: PlanExpr) => textOf(call('add', [call('cast_integer', [T(p)], 'int'), lit(1)], 'int'));
  const k = (p: PlanExpr) => call('sub', [L, p], 'int');
  const reads = (C: PlanExpr, p: PlanExpr) => eq(call('cast_real_strict', [concat(C, 'e', textOf(k(p)))], 'real'), z);
  const ps: Typed = { e: call('list_of', Array.from({ length: 17 }, (_, i) => lit(i + 1)), 'list<int>'), t: 'list<int>' };
  const fewest = call('list_get', [eachOf(ps, 'filter', 'list<int>', (p) => and(call('cmp_le', [p.e, L], 'bool'), or(reads(T(p.e), p.e), reads(U(p.e), p.e)))), lit(0)], 'int');
  return letIn({ e: fewest, t: 'int' }, 'text', ({ e: p }) => {
    const rest = call('substr', [digits, call('add', [p, lit(1)], 'int')], 'text');
    const half = concat('5', zeros(call('sub', [k(p), lit(1)], 'int')));
    const even = call('in_list', [call('substr', [T(p), p, lit(1)], 'text'), lit('0'), lit('2'), lit('4'), lit('6'), lit('8')], 'bool');
    const tie = caseWhen([[eq(k(p), lit(0)), T(p)], [call('cmp_lt', [rest, half], 'bool'), T(p)], [call('cmp_gt', [rest, half], 'bool'), U(p)], [even, T(p)]], U(p), 'text');
    const C = caseWhen([[and(reads(T(p), p), reads(U(p), p)), tie], [reads(T(p), p), T(p)]], U(p), 'text');
    return letIn({ e: C, t: 'text' }, 'text', (c) => written(c.e, k(p)));
  });
}

/** C × 10^k as `String()` writes it, C's digits given. */
function written(ct: PlanExpr, k: PlanExpr): PlanExpr {
  const cs = call('rtrim', [ct, lit('0')], 'text');
  const m = call('length', [cs], 'int');
  const E = call('add', [call('length', [ct], 'int'), call('sub', [k, lit(1)], 'int')], 'int');
  const plain = concat(cs, zeros(call('sub', [call('add', [E, lit(1)], 'int'), m], 'int')));
  const exp = concat(call('substr', [cs, lit(1), lit(1)], 'text'), caseWhen([[call('cmp_gt', [m, lit(1)], 'bool'), concat('.', call('substr', [cs, lit(2)], 'text'))]], lit(''), 'text'), 'e+', textOf(E));
  return caseWhen([[call('cmp_lt', [E, lit(21)], 'bool'), plain]], exp, 'text');
}

/** A number or a boolean as smaltcy's `+` writes it beside a string (`String()`). */
function valueText(v: Typed): PlanExpr {
  const boolText = caseWhen([[isNull(v.e), NULL], [asBoolValue(v), lit('true')]], lit('false'), 'text');
  const k = staticKind(v.t);
  if (k === K_BOOL) return boolText;
  if (k === K_NUMBER) return numberText(v);
  return caseWhen([[eq(kindExpr(v), lit(K_BOOL)), boolText]], numberText(v), 'text');
}

/** A list of its elements in `any` places, where booleans and nested values keep their kind. */
function anyList(list: Typed): Typed {
  const el = elemType(list.t);
  if (el === 'any' || el === 'int' || el === 'real' || el === 'num' || el === 'text') return { e: list.e, t: 'list<any>' };
  return { e: eachOf(list, 'map', 'list<any>', (x) => asAny(x)), t: 'list<any>' };
}

/** Two lists one after the other. */
function concatLists(a: Typed, b: Typed): Typed {
  if (elemType(a.t) === elemType(b.t)) return { e: call('list_concat', [a.e, b.e], a.t), t: a.t };
  return { e: call('list_concat', [anyList(a).e, anyList(b).e], 'list<any>'), t: 'list<any>' };
}

/** A list of one value. */
const listOfOne = (v: Typed): Typed => {
  const t: PlanType = `list<${v.t === 'null' ? 'any' : v.t}>`;
  return { e: call('list_of', [v.e], t), t };
};

/** Branches giving lists, under one list type: theirs, or `list<any>`. */
function oneListType(whens: readonly (readonly [PlanExpr, Typed])[], otherwise: Typed): Typed {
  const types = new Set([...whens.map(([, v]) => v.t), otherwise.t].filter((t) => t !== 'null'));
  const t: PlanType = types.size === 1 ? [...types][0]! : 'list<any>';
  const fit = (v: Typed) => (v.t === t || v.t === 'null' ? v.e : anyList(v).e);
  return { e: caseWhen(whens.map(([c, v]) => [c, fit(v)] as const), fit(otherwise), t), t };
}

/**
 * smaltcy's `+` where a static type says one side is a list: two lists one after the other, a list and a value the
 * value appended, a value and a list it prepended; NULL where a side is NULL and isn't a list, as smaltcy's `add`.
 */
function addLists(a: Typed, b: Typed): Typed {
  const NULLS: Typed = { e: NULL, t: 'null' };
  const ka = staticKind(a.t);
  const kb = staticKind(b.t);
  if (ka === K_LIST && kb === K_LIST) {
    return oneListType(
      [
        [and(isNull(a.e), isNull(b.e)), NULLS],
        [isNull(a.e), concatLists(listOfOne({ e: NULL, t: 'null' }), b)],
        [isNull(b.e), concatLists(a, listOfOne({ e: NULL, t: 'null' }))],
      ],
      concatLists(a, b),
    );
  }
  if (ka === K_LIST) return oneListType([[isNull(a.e), NULLS]], concatLists(a, listOfOne(b)));
  return oneListType([[isNull(b.e), NULLS]], concatLists(listOfOne(a), b));
}

/** smaltcy's `%` of numbers that may be floats: JavaScript's, the sign of the dividend's; by zero NaN, or for two whole numbers its error. */
function floatModulo(x: PlanExpr, y: PlanExpr, t: PlanType): PlanExpr {
  const whole = (v: PlanExpr) => eq(call('any_type', [v], 'text'), lit('int'));
  // mod_floor of two numbers of the same sign is JavaScript's %: the divisor takes the dividend's sign (-0's too).
  const negative = or(call('cmp_lt', [x, lit(0)], 'bool'), call('cmp_lt', [call('div_float', [lit(1), x], 'real'), lit(0)], 'bool'));
  const divisor = call('abs', [call('cast_real', [y], 'real')], 'real');
  return caseWhen(
    [
      [or(isNull(x), isNull(y)), NULL],
      [eq(y, lit(0)), caseWhen([[and(whole(x), whole(y)), raise('SMALTCY_TYPE', 'Division by zero', 'real')]], NAN, 'real')],
    ],
    call('mod_floor', [call('cast_real', [x], 'real'), caseWhen([[negative, call('neg', [divisor], 'real')]], divisor, 'real')], 'real'),
    t === 'int' ? 'real' : t,
  );
}

/** Compiles graph plans and expressions over a graph's tables (`compileQuery`; the write runner in write.ts). */
export class Compiler {
  readonly paramNames: string[] = [];
  /** The `iterate` operations made so far (their ids). */
  private iterates = 0;
  /** Operations whose rows are given (write.ts: rows it holds, as a `values` plan), compiled as those. */
  readonly given = new Map<Op, Rel>();
  /** The list elements in scope (`[x IN list …]`, `any(x IN list …)`), innermost last: what their slots read. */
  private readonly elements: { readonly slot: number; readonly type: PlanType; readonly kind: ElementKind }[] = [];
  /** The rows nested plans are run from (EXISTS, pattern comprehensions), innermost last: what `argument` reads. */
  private readonly outer: Frame[] = [];

  constructor(
    private readonly t: GraphTables,
    private readonly params: Readonly<Record<string, unknown>>,
    /** The past the plan reads (`AT VERSION`, `AT TIME`): what `version()` gives. */
    private readonly asOf?: AsOf,
    /**
     * Slots nothing reads: those of the whole plan that appear once (`slotsOnce`). An anonymous node a relationship
     * reaches, with no labels or properties, is then only that relationship's end, which smaltdb's graph keeps a node of
     * the graph: no scan of the node table.
     */
    private readonly unread: ReadonlySet<number> = new Set(),
    /** `CompileOptions.maxBranches`. */
    private readonly maxBranches = 1,
  ) {}

  // Operations.

  /**
   * An operation's rows. `ordered`: whether their order shows (in the results, a `collect()`, a LIMIT, the ties of an
   * ORDER BY); where it doesn't, the plan asks smaltdb for no order, so its planner is free to join and group in any.
   */
  op(op: Op, ordered = true): Rel {
    const given = this.given.get(op);
    if (given) return given;
    const first = ordered ? { ordered: 'first' as const } : {};
    switch (op.op) {
      case 'argument': {
        if (!op.slots.length) return { plan: { op: 'values', rows: [[]], types: [] }, frame: { types: [], slots: new Map() } };
        // A nested plan's leaf: one row, the enclosing row's columns read one subquery out, so its slots are where
        // they were.
        const outer = this.outer.at(-1) ?? unsupported('a nested plan outside an expression');
        if (op.slots.some((s) => !outer.slots.has(s))) unsupported('a nested plan reading variables its row does not hold');
        return { plan: { op: 'values', rows: [outer.types.map((t, i) => colRef(i, t, 1))], types: [...outer.types] }, frame: outer };
      }
      case 'eager':
        return this.op(op.input, ordered);
      case 'match':
        return this.match(op, ordered);
      case 'filter': {
        const r = this.op(op.input, ordered);
        return { plan: { op: 'filter', input: r.plan, pred: this.predicate(op.pred, r.frame, 'WHERE') }, frame: r.frame };
      }
      case 'project':
        return this.project(this.op(op.input, ordered), op.items, op.discard);
      case 'aggregate':
        // Groups come in the order of their first row (no keys: one group); only `count` gives the same whatever the
        // order of its rows (sums of floats round by their order, `min` and `max` of equal numbers of two kinds keep
        // the first, `collect` lists them).
        return this.aggregate(this.op(op.input, (ordered && op.keys.length > 0) || op.aggs.some((a) => a.fn !== 'count')), op.keys, op.aggs, ordered);
      case 'distinct': {
        const r = this.op(op.input, ordered);
        const on = op.slots.flatMap((s) => this.keyColumns(r.frame, s));
        return { plan: { op: 'distinct', input: r.plan, collations: r.frame.types.map(() => 'binary'), on, keep: 'first', ...first }, frame: r.frame };
      }
      case 'sort': {
        // Stable: rows that tie keep their order.
        const r = this.op(op.input, true);
        return { plan: { op: 'sort', input: r.plan, keys: op.keys.flatMap((k) => this.sortKeys(k, r.frame)) }, frame: r.frame };
      }
      case 'limit': {
        const r = this.op(op.input, true);
        const count = op.count ? this.count(op.count, 'LIMIT') : lit(-1);
        return { plan: { op: 'limit', input: r.plan, count, ...(op.skip ? { offset: this.count(op.skip, 'SKIP') } : {}) }, frame: r.frame };
      }
      case 'unwind':
        return this.unwind(this.op(op.input, ordered), op.list, op.slot);
      case 'union':
        return this.union(op, ordered);
      case 'create': case 'merge': case 'set': case 'remove': case 'delete':
        // Writes run row by row (write.ts), not as one query.
        return unsupported(`writes (${op.op.toUpperCase()}) in a query`);
    }
  }

  /** Every match of a pattern, for each input row; `where` is part of the match. */
  private match(op: Extract<Op, { op: 'match' }>, ordered: boolean): Rel {
    const input = this.op(op.input, ordered);
    if (op.optional) return this.optionalMatch(input, op.pattern, op.where, ordered);
    return this.pattern(input, op.pattern, op.where, ordered);
  }

  /**
   * OPTIONAL MATCH: the input's rows numbered (a window's `row_number`), matched, and left-joined back by their number,
   * so a row without a match (or with none passing `where`) passes once with the pattern's new slots NULL. The input's
   * plan appears twice: smaltdb runs it twice, and both runs must number the same rows the same way, as smaltdb's
   * planner plans the same plan over the same data the same way (an assumption the tests bear out).
   */
  private optionalMatch(input: Rel, p: Pattern, where: Expr | undefined, ordered: boolean): Rel {
    const w = input.frame.types.length;
    const numbered: Rel = { plan: this.numbered(input), frame: { types: [...input.frame.types, 'int'], slots: input.frame.slots } };
    const m = this.pattern(numbered, p, where, ordered);
    const joined: PlanOp = { op: 'join', kind: 'left', inputs: [numbered.plan, m.plan], on: eq(colRef(w, 'int'), rightRef(w, 'int')), ...(ordered ? { ordered: true } : {}) };
    // The input's columns, then the match's new ones (after its copy of the input and the number).
    const types = [...input.frame.types, ...m.frame.types.slice(w + 1)];
    const exprs = [...input.frame.types.map((t, i) => colRef(i, t)), ...m.frame.types.slice(w + 1).map((t, i) => colRef(2 * (w + 1) + i, t))];
    const slots = new Map(input.frame.slots);
    for (const [s, b] of m.frame.slots) if (!slots.has(s)) slots.set(s, moveBinding(b, (c) => c - 1));
    return { plan: { op: 'project', input: joined, exprs }, frame: { types, slots } };
  }

  /**
   * Every match of a pattern, for each input row, as one smaltdb join region (a flat join of bare table scans, which
   * its planner orders and seeks into with the tables' indexes): the input, then for each new node a scan of the node
   * table (and of the label index for each of its labels), for each relationship a scan of its type's edge table, all
   * joined by conditions on their columns; the row's columns are one projection over them. A relationship that can be
   * one of several types, or read both ways, splits the region into one per type and reading (a union, `branches`),
   * up to `maxBranches`; past that its edge source is the union of the edge tables, one FROM item. A
   * variable-length relationship is smaltdb's `paths` in trail mode (no relationship twice) over the region so far,
   * and a shortest path a breadth-first search once both its ends are bound; each starts a region of its own.
   * Relationships are distinct within the pattern (Cypher's uniqueness): two relationships whose types can be the same
   * must differ in type or rowid, and a variable-length relationship's hops must not hold the others. The pattern's
   * property maps and the conjuncts of `where` that can't raise an error are conditions of the region; the others
   * filter its rows. With `ordered`, rows come in the order of the input, then of each scan (smaltdb's `ordered`
   * joins' order), by a sort of the region's rows.
   */
  private pattern(input: Rel, p: Pattern, where: Expr | undefined, ordered: boolean): Rel {
    const types = [...input.frame.types];
    const slots = new Map(input.frame.slots);
    const frame = (): Frame => ({ types, slots });
    let branches: Branch[] = [this.startBranch(input, ordered)];
    // Conditions over the row's columns (the frame), placed once the slots they read are bound.
    let pending: { slots: readonly number[]; cond: () => PlanExpr }[] = [];
    // Conditions that can raise an error: they filter the region's rows.
    const after: PlanExpr[] = [];
    const done = p.nodes.map(() => false);
    const nodeAt = (i: number): NodeBinding | undefined => {
      const b = slots.get(p.nodes[i]!.slot);
      if (b && b.k !== 'node') unsupported(`a node pattern on a variable that holds ${b.k === 'value' ? 'a value' : entity(this.valueOf(b) as Exclude<Val, { k: 'value' }>)}`);
      return b as NodeBinding | undefined;
    };
    const outOf = (b: Branch, col: number): PlanExpr => b.out[col]!;
    /** Adds a column to the row: its expression in each branch. */
    const addColumn = (t: PlanType, e: (b: Branch) => PlanExpr): number => {
      for (const b of branches) b.out.push(e(b));
      return types.push(t) - 1;
    };
    /** A condition over the row's columns: in each branch's region when it can't raise an error, else after it. */
    const place = (cond: PlanExpr) => {
      for (const c of conjuncts(cond)) {
        if (canRaise(c)) after.push(c);
        else for (const b of branches) b.conds.push(inline(c, b.out));
      }
    };
    const placeBound = () => {
      const now = pending.filter((c) => c.slots.every((s) => slots.has(s)));
      pending = pending.filter((c) => !now.includes(c));
      for (const c of now) place(c.cond());
    };
    /** The region's rows as a plan of the row's columns, its conditions placed; a new region starts from them. */
    const finish = (): PlanOp => {
      placeBound();
      let plan = this.joinRegions(branches, types, ordered);
      if (after.length) plan = { op: 'filter', input: plan, pred: and(...after.splice(0)) };
      return plan;
    };
    const restart = (plan: PlanOp) => {
      branches = [this.startBranch({ plan, frame: frame() }, ordered)];
    };
    const check = (props: Expr | undefined, target: () => PlanExpr) => {
      if (props) pending.push({ slots: slotsIn(props), cond: () => this.propsMatch(target(), props, frame()) });
    };
    /** Binds node `i` to a new scan of the node table, whose id is `on`'s expression in each branch, if any. */
    const bindNew = (i: number, on: (b: Branch) => PlanExpr | undefined) => {
      const n = p.nodes[i]!;
      const id = types.length;
      for (const b of branches) {
        const at = addLeaf(b, { op: 'scan', table: this.t.nodes, columns: [0, 1] }, 2);
        const idCol = colRef(at, 'int');
        const e = on(b);
        if (e) b.conds.push(eq(idCol, e));
        else if (ordered) b.keys.push(idCol);
        b.out.push(idCol, colRef(at + 1, PROPS));
        this.labelEntries(b, idCol, n.labels);
      }
      types.push('int', PROPS);
      slots.set(n.slot, { k: 'node', id, props: id + 1 });
      done[i] = true;
      check(n.props, () => colRef(id + 1, PROPS));
    };
    const scanNode = (i: number) => bindNew(i, () => undefined);
    /** Whether node `i` is only a relationship's end: anonymous (nothing reads it), with no labels or properties. */
    const endOnly = (i: number) => {
      const n = p.nodes[i]!;
      return this.unread.has(n.slot) && !n.labels.length && !n.props;
    };
    /** Binds node `i` to a relationship's end, `id` in each branch, without a scan of the node table (its properties are never read). */
    const bindEnd = (i: number, id: (b: Branch) => PlanExpr) => {
      const at = types.length;
      for (const b of branches) b.out.push(id(b), { k: 'lit', value: null, type: PROPS });
      types.push('int', PROPS);
      slots.set(p.nodes[i]!.slot, { k: 'node', id: at, props: at + 1 });
      done[i] = true;
    };
    /** Binds node `i` to where a relationship ends: its id only when nothing reads it, else a scan of the node table. */
    const bindAt = (i: number, id: (b: Branch) => PlanExpr) => (endOnly(i) ? bindEnd(i, id) : bindNew(i, id));

    const fixed: { r: PatternRel; b: RelBinding }[] = [];
    const lists: { r: PatternRel; hops: number }[] = [];
    /**
     * One hop: a scan of an edge table for each type and reading (a branch each), joined on the end that is bound, then
     * the node table at the far end unless it is bound.
     */
    const hop = (r: PatternRel) => {
      // Each type, read as the pattern reads it (`both`: forward, then backward; a self-loop once), in smaltcy's order.
      const readings = r.dir === 'both' ? [false, true] : [r.dir === 'in'];
      const choices = readings.flatMap((reverse) => this.typeNames(r.types).map((type) => ({ type, reverse })));
      // A scan of an edge table per branch; else the union of the edge tables, a FROM item whose rows smaltdb's planner
      // doesn't know (it assumes 1,000), so its ends are joined with the node table, whose rows it knows.
      const scans = choices.length > 0 && branches.length * choices.length <= this.maxBranches;
      if (!nodeAt(r.from) && !nodeAt(r.to) && !(scans && endOnly(r.from))) scanNode(r.from);
      // Neither end bound: the relationship's scan comes first, and its `from` end is the node.
      const free = !nodeAt(r.from) && !nodeAt(r.to);
      const fromBound = free || nodeAt(r.from) !== undefined;
      const near = fromBound ? r.from : r.to;
      const far = fromBound ? r.to : r.from;
      const nearId = free ? -1 : nodeAt(near)!.id;
      const farNode = nodeAt(far);
      // The ends at the pattern's `from` and `to` nodes, in each branch.
      const ends = new Map<Branch, { from: PlanExpr; to: PlanExpr }>();
      if (scans) {
        branches = branches.flatMap((b) =>
          choices.map((c, k) => {
            const nb = cloneBranch(b);
            const at = addLeaf(nb, { op: 'scan', table: this.t.types.get(c.type)!, columns: [-1, 0, 1, 2] }, 4);
            const start = colRef(at + 1, 'int');
            const end = colRef(at + 2, 'int');
            if (r.dir === 'both' && c.reverse) nb.conds.push(not(eq(start, end)));
            nb.out.push(lit(c.type, 'text'), colRef(at, 'int'), start, end, colRef(at + 3, PROPS));
            const e = c.reverse ? { from: end, to: start } : { from: start, to: end };
            // In order of the `from` node when the relationship's scan comes first, as a scan of the node table would.
            if (ordered) nb.keys.push(...(free ? [e.from] : []), ...(choices.length > 1 ? [lit(k)] : []), colRef(at, 'int'));
            ends.set(nb, e);
            return nb;
          }),
        );
      } else {
        // The union of the edge tables (none: no rows), one FROM item.
        const source = this.edges(r.types, r.dir);
        for (const b of branches) {
          const at = addLeaf(b, source, EDGE_TYPES.length + 1);
          for (let i = 0; i <= E_PROPS; i++) b.out.push(colRef(at + i, EDGE_TYPES[i]!));
          if (ordered) b.keys.push(...(free ? [colRef(at + E_FROM, 'int')] : []), colRef(at + EDGE_TYPES.length, 'int'), colRef(at + E_ROWID, 'int'));
          ends.set(b, { from: colRef(at + E_FROM, 'int'), to: colRef(at + E_TO, 'int') });
        }
      }
      const w = types.length;
      types.push(...EDGE_TYPES.slice(0, E_PROPS + 1));
      const rb: RelBinding = { k: 'rel', type: w + E_TYPE, rowid: w + E_ROWID, start: w + E_START, end: w + E_END, props: w + E_PROPS };
      slots.set(r.slot, rb);
      fixed.push({ r, b: rb });
      for (const b of branches) {
        const e = ends.get(b)!;
        if (!free) b.conds.push(eq(outOf(b, nearId), fromBound ? e.from : e.to));
        if (farNode) b.conds.push(eq(outOf(b, farNode.id), fromBound ? e.to : e.from));
      }
      if (free) bindEnd(near, (b) => ends.get(b)!.from);
      if (!farNode) (scans ? bindAt : bindNew)(far, (b) => (fromBound ? ends.get(b)!.to : ends.get(b)!.from));
      check(r.props, () => colRef(rb.props, PROPS));
    };
    /**
     * A variable-length relationship or a shortest path, over the region so far: `paths` from the bound end (or, for
     * one shortest path, a search from the `from` end), the far end joined (or checked) in a new region, and the hops
     * read in the pattern's direction.
     */
    const walk = (r: PatternRel) => {
      const shortest = r.shortest;
      const min = r.min ?? 1;
      if (shortest) {
        if (!nodeAt(r.from) || !nodeAt(r.to)) unsupported('shortest paths whose ends are not bound');
        // smaltcy's engine finds shortest paths without other relationships' uniqueness and with the properties as it
        // goes; smaltdb's selectors choose among paths of at least minHops. Kept to what both mean alike.
        if (r.props) unsupported('shortest paths with relationship properties');
        if (min > 1) unsupported('shortest paths with a minimum length above 1');
      } else if (!nodeAt(r.from) && !nodeAt(r.to)) scanNode(r.from);
      const fromBound = nodeAt(r.from) !== undefined;
      const near = fromBound ? r.from : r.to;
      const far = fromBound ? r.to : r.from;
      const names = this.typeNames(r.types);
      const dir = fromBound ? r.dir : r.dir === 'out' ? 'in' : r.dir === 'in' ? 'out' : 'both';
      const start = nodeAt(near)!.id;
      let plan = finish();
      // smaltcy's shortest path from a node to itself is the empty path, from minHops 0 only.
      if (shortest && min === 1) plan = { op: 'filter', input: plan, pred: not(eq(colRef(nodeAt(r.from)!.id, 'int'), colRef(nodeAt(r.to)!.id, 'int'))) };
      const w = types.length;
      if (shortest === 'one' && names.length) {
        // One shortest path: a search that stops at the far end, its hops already in the pattern's direction.
        const path = this.shortestPath(colRef(start, 'int'), colRef(nodeAt(far)!.id, 'int'), names, dir, min, r.max);
        plan = { op: 'filter', input: { op: 'project', input: plan, exprs: [...types.map((t, i) => colRef(i, t)), path] }, pred: isNotNull(colRef(w, HOPS)) };
        types.push(HOPS);
        restart(plan);
        slots.set(r.slot, { k: 'rels', hops: w });
        lists.push({ r, hops: w });
        return;
      }
      if (!names.length) {
        // No edge table: only the empty path, from minHops 0.
        plan = { op: 'project', input: min === 0 ? plan : { op: 'filter', input: plan, pred: FALSE }, exprs: [...types.map((t, i) => colRef(i, t)), colRef(start, 'int'), lit(0), call('list_of', [], HOPS)] };
        types.push('int', 'int', HOPS);
      } else {
        // Each row's paths, from a subquery (smaltdb's `paths` from that row's node), one row each.
        const found = this.pathsFrom(colRef(start, 'int'), names, dir, min, r.max, shortest, ordered);
        plan = { op: 'explode', input: { op: 'project', input: plan, exprs: [...types.map((t, i) => colRef(i, t)), found] }, column: w, type: `list<${FOUND}>`, keepNulls: false };
        const field = (i: number, t: PlanType) => call('struct_field', [colRef(w, FOUND), lit(i)], t);
        plan = { op: 'project', input: plan, exprs: [...types.map((t, i) => colRef(i, t)), field(0, 'int'), field(1, 'int'), field(2, HOPS)] };
        types.push('int', 'int', HOPS);
      }
      restart(plan);
      const last = w;
      const farNode = nodeAt(far);
      if (farNode) for (const b of branches) b.conds.push(eq(outOf(b, farNode.id), outOf(b, last)));
      // A node only this relationship reaches; else the node table, whose rows the planner knows, joins it to the others.
      else if (p.rels.every((x) => x === r || (x.from !== far && x.to !== far))) bindAt(far, (b) => outOf(b, last));
      else bindNew(far, (b) => outOf(b, last));
      const hops = addColumn(HOPS, (b) => this.hopsInPatternOrder(outOf(b, w + 2), names, !fromBound));
      slots.set(r.slot, { k: 'rels', hops });
      lists.push({ r, hops });
      if (r.props) {
        if (slotsIn(r.props).length) unsupported('a variable-length relationship whose properties read variables');
        // Every hop's relationship has the properties: no hop without them.
        const match = this.propsMatch(colRef(5, PROPS), r.props, { types: [], slots: new Map() });
        pending.push({ slots: [], cond: () => not({ k: 'subquery', mode: 'exists', type: 'bool', collation: 'binary', plan: { op: 'filter', input: this.relRows(colRef(hops, HOPS)), pred: caseWhen([[match, FALSE]], TRUE, 'bool') } }) });
      }
    };

    for (const r of p.rels) {
      if (slots.has(r.slot)) unsupported('a relationship pattern on a variable that is already bound');
      if (r.shortest) continue;
      if (r.min !== undefined) walk(r);
      else hop(r);
    }
    // Nodes no relationship reached, and the labels and properties of nodes bound before.
    p.nodes.forEach((n, i) => {
      if (done[i]) return;
      const b = nodeAt(i);
      if (!b) return scanNode(i);
      for (const br of branches) this.labelEntries(br, outOf(br, b.id), n.labels);
      check(n.props, () => colRef(b.props, PROPS));
    });
    const shortest = p.rels.filter((r) => r.shortest);
    if (shortest.length && p.rels.length > 1) unsupported('shortest paths beside other relationships in one MATCH');
    for (const r of shortest) walk(r);

    // Uniqueness: relationships whose types can't be the same are distinct already.
    const typeSet = (r: PatternRel) => new Set(this.typeNames(r.types));
    const overlap = (a: PatternRel, b: PatternRel) => {
      const t = typeSet(b);
      return [...typeSet(a)].some((x) => t.has(x));
    };
    fixed.forEach(({ r, b }, i) => {
      for (const { r: r2, b: b2 } of fixed.slice(i + 1)) {
        if (!overlap(r, r2)) continue;
        for (const br of branches) {
          const [t1, t2] = [outOf(br, b.type), outOf(br, b2.type)];
          const sameRow = eq(outOf(br, b.rowid), outOf(br, b2.rowid));
          if (t1.k !== 'lit' || t2.k !== 'lit') br.conds.push(not(and(eq(t1, t2), sameRow)));
          else if (t1.value === t2.value) br.conds.push(not(sameRow));
        }
      }
      for (const l of lists) {
        if (!overlap(r, l.r)) continue;
        const hopOf = (i: number) => call('struct_field', [colRef(0, HOP), lit(i)], 'int');
        pending.push({
          slots: [],
          cond: () => {
            const same = and(eq(hopOf(0), deepen(this.typeIndexOf(colRef(b.type, 'text')))), eq(hopOf(1), deepen(colRef(b.rowid, 'int'))));
            return not({ k: 'subquery', mode: 'exists', type: 'bool', collation: 'binary', plan: { op: 'filter', input: this.hopRows(colRef(l.hops, HOPS)), pred: same } });
          },
        });
      }
    });
    lists.forEach((l, i) => {
      for (const l2 of lists.slice(i + 1)) if (overlap(l.r, l2.r)) unsupported('two variable-length relationships in one MATCH');
    });

    // Named paths: the first node, and the hops of the relationships in order.
    for (const path of p.paths ?? []) {
      const segments = path.rels.map((ri): PlanExpr => {
        const r = p.rels[ri]!;
        const b = slots.get(r.slot)!;
        if (b.k === 'rels') return colRef(b.hops, HOPS);
        const rb = b as RelBinding;
        const hopStruct = call('struct_of', [this.typeIndexOf(colRef(rb.type, 'text')), colRef(rb.rowid, 'int'), colRef(nodeAt(r.from)!.id, 'int'), colRef(nodeAt(r.to)!.id, 'int')], HOP);
        return call('list_of', [hopStruct], HOPS);
      });
      const hops = segments.length ? segments.reduce((a, b) => call('list_concat', [a, b], HOPS)) : call('list_of', [], HOPS);
      const start = nodeAt(path.nodes[0]!)!.id;
      slots.set(path.slot, { k: 'path', start, hops: addColumn(HOPS, (b) => inline(hops, b.out)) });
    }
    if (where) pending.push({ slots: [], cond: () => this.predicate(where, frame(), 'WHERE') });
    return { plan: finish(), frame: frame() };
  }

  /** A region's first branch: the input as its first FROM item (numbered when the order is kept), unless it is one empty row. */
  private startBranch(input: Rel, ordered: boolean): Branch {
    const p = input.plan;
    const w = input.frame.types.length;
    if (!w && p.op === 'values' && p.rows.length === 1) return { leaves: [], width: 0, conds: [], out: [], keys: [] };
    // One row has its order already.
    const number = ordered && !(p.op === 'values' && p.rows.length <= 1);
    return {
      leaves: [number ? this.numbered(input) : p],
      width: number ? w + 1 : w,
      conds: [],
      out: input.frame.types.map((t, i) => colRef(i, t)),
      keys: number ? [colRef(w, 'int')] : [],
    };
  }

  /**
   * The rows of a region's branches as a plan of the row's columns (`types`): each branch's FROM items joined, its
   * conditions over them and its columns projected (a flat SELECT, smaltdb's join region), the branches' rows in one
   * union; with `ordered`, sorted by their keys.
   */
  private joinRegions(branches: readonly Branch[], types: readonly PlanType[], ordered: boolean): PlanOp {
    const plans = branches.map((b): PlanOp => {
      const first = b.leaves[0];
      // Only the input, as it is: its plan.
      if (b.leaves.length === 1 && !b.conds.length && !b.keys.length && b.out.length === b.width && b.out.every((e, i) => e.k === 'col' && e.index === i && e.depth === 0)) return first!;
      let plan: PlanOp = first ? b.leaves.slice(1).reduce((l, r): PlanOp => ({ op: 'join', kind: 'cross', inputs: [l, r] }), first) : { op: 'values', rows: [[]], types: [] };
      if (b.conds.length) plan = { op: 'filter', input: plan, pred: and(...b.conds) };
      return { op: 'project', input: plan, exprs: ordered ? [...b.out, ...b.keys] : b.out };
    });
    const keys = ordered ? branches[0]!.keys.length : 0;
    const collations = [...types, ...Array.from({ length: keys }, () => 'int')].map(() => 'binary' as const);
    let plan = plans.reduce((a, b): PlanOp => ({ op: 'setop', kind: 'unionAll', inputs: [a, b], collations }));
    if (keys) {
      const w = types.length;
      plan = { op: 'sort', input: plan, keys: Array.from({ length: keys }, (_, i) => ({ expr: colRef(w + i, 'int'), desc: false, nullsFirst: false, collation: 'binary' as const })) };
      plan = { op: 'project', input: plan, exprs: types.map((t, i) => colRef(i, t)) };
    }
    return plan;
  }

  /** A node's labels in a branch: an entry in the label index for each (one at most: the index is unique on label and node). */
  private labelEntries(b: Branch, id: PlanExpr, labels: readonly string[]): void {
    for (const l of labels) {
      const at = addLeaf(b, { op: 'scan', table: this.t.labels, columns: [0, 1] }, 2);
      b.conds.push(eq(colRef(at, 'int'), id), eq(colRef(at + 1, 'text'), lit(l)));
    }
  }

  /**
   * The paths from a node (`from`, an expression of the row) along these edge tables, as a scalar subquery: a list of
   * `FOUND` structs (where each path ends, its length, its hops), in `paths`' order (shortest first). smaltdb's `paths`
   * runs over the one row of the subquery, so the plan of the rows it starts from is run once, not once for the search
   * and once to join its paths back. `both` reads a self-loop both ways, two paths the same: each kept once.
   */
  private pathsFrom(from: PlanExpr, names: readonly string[], dir: Direction, min: number, max: number | undefined, shortest: PatternRel['shortest'], ordered: boolean): PlanExpr {
    let paths: PlanOp = {
      op: 'paths',
      input: { op: 'values', rows: [[deepen(from)]], types: ['int'] },
      start: 0,
      edges: names.map((t) => ({ table: this.t.types.get(t)!, start: 0, end: 1 })),
      direction: dir,
      minHops: min,
      ...(max !== undefined ? { maxHops: max } : {}),
      mode: shortest === 'all' ? 'acyclic' : shortest ? 'walk' : 'trail',
      selector: shortest === 'all' ? 'allShortest' : shortest ? 'anyShortest' : 'all',
    };
    // Columns: the start, where the path ends, its length, its hops.
    if (dir === 'both' && !shortest) paths = { op: 'distinct', input: paths, collations: [0, 1, 2, 3].map(() => 'binary'), on: [3], keep: 'first', ...(ordered ? { ordered: 'first' as const } : {}) };
    const each: PlanOp = { op: 'project', input: paths, exprs: [call('struct_of', [colRef(1, 'int'), colRef(2, 'int'), colRef(3, HOPS)], FOUND)] };
    const list: PlanType = `list<${FOUND}>`;
    const agg: PlanOp = { op: 'aggregate', input: each, keys: [], aggs: [{ fn: 'implode', args: [colRef(0, FOUND)], star: false, distinct: false, collation: 'binary', type: list }], carry: [] };
    return { k: 'subquery', mode: 'scalar', plan: agg, type: list, collation: 'binary' };
  }

  /**
   * One shortest path from `from` to `to` (expressions of the row), in the pattern's direction, or NULL: a scalar
   * subquery of a breadth-first search from `from` (smaltdb's `iterate`, the first row reaching each node kept, so its
   * hops are a shortest path there), whose first row at `to` stops it (smaltdb runs an iterate's steps as its rows are
   * read). Its hops give each relationship's type as its position in the graph's types.
   */
  private shortestPath(from: PlanExpr, to: PlanExpr, names: readonly string[], dir: Direction, min: number, max: number | undefined): PlanExpr {
    const id = ++this.iterates;
    const all = [...this.t.types.keys()];
    const at = (input: 0 | 1, index: number, type: PlanType): PlanExpr => ({ k: 'col', input, index, depth: 0, type, collation: 'binary' });
    // Columns: the node reached, its hops from `from`, the path.
    const iterTypes: PlanType[] = ['int', 'int', HOPS];
    const working: PlanOp = { op: 'working', id, types: iterTypes };
    const steps = names.flatMap((name, i): PlanOp[] => {
      const ways: [number, number][] = dir === 'out' ? [[0, 1]] : dir === 'in' ? [[1, 0]] : [[0, 1], [1, 0]];
      return ways.map(([f, t]): PlanOp => {
        const edge: PlanOp = { op: 'scan', table: this.t.types.get(name)!, columns: [f, t, -1] };
        const joined: PlanOp = { op: 'join', kind: 'inner', inputs: [working, edge], on: eq(at(1, 0, 'int'), at(0, 0, 'int')) };
        const hop = call('struct_of', [lit(all.indexOf(name)), at(0, 5, 'int'), at(0, 3, 'int'), at(0, 4, 'int')], HOP);
        return { op: 'project', input: joined, exprs: [at(0, 4, 'int'), call('add', [at(0, 1, 'int'), lit(1)], 'int'), call('list_concat', [at(0, 2, HOPS), call('list_of', [hop], HOPS)], HOPS)] };
      });
    });
    const search: PlanOp = {
      op: 'iterate',
      id,
      name: 'shortest',
      init: { op: 'values', rows: [[deepen(from), lit(0), call('list_of', [], HOPS)]], types: iterTypes },
      steps,
      distinct: true,
      collations: iterTypes.map(() => 'binary'),
      key: [0],
      ...(max !== undefined ? { maxDepth: max } : {}),
    };
    const found: PlanOp = { op: 'filter', input: search, pred: and(eq(colRef(0, 'int'), deepen(to)), call('cmp_ge', [colRef(1, 'int'), lit(min)], 'bool')) };
    const first: PlanOp = { op: 'limit', input: { op: 'project', input: found, exprs: [colRef(2, HOPS)] }, count: lit(1) };
    return { k: 'subquery', mode: 'scalar', plan: first, type: HOPS, collation: 'binary' };
  }

  /** A plan's rows numbered in order (a window's `row_number`), in a last column. */
  private numbered(r: Rel): PlanOp {
    return {
      op: 'window',
      input: r.plan,
      partition: [],
      order: [],
      frame: { unit: 'ROWS', start: { kind: 'unboundedPreceding' }, end: { kind: 'currentRow' }, exclude: 'NO OTHERS' },
      calls: [{ fn: 'row_number', args: [], star: false, type: 'int', collation: 'binary' }],
    };
  }

  /** The graph's types a pattern's types name (none: every type), in the graph's order, once each. */
  private typeNames(types: readonly string[]): string[] {
    return types.length ? [...this.t.types.keys()].filter((t) => types.includes(t)) : [...this.t.types.keys()];
  }

  /** A type's position in the graph's types, from its name. */
  private typeIndexOf(type: PlanExpr): PlanExpr {
    return caseWhen([...this.t.types.keys()].map((t, i) => [eq(type, lit(t)), lit(i)] as const), NULL, 'int');
  }

  /**
   * `paths`' hops with each edge table's position (in `names`) turned into its type's position in the graph, read from
   * the pattern's `from` end (`reverse`: they were found from the `to` end).
   */
  private hopsInPatternOrder(path: PlanExpr, names: readonly string[], reverse: boolean): PlanExpr {
    const el: PlanExpr = { k: 'element', part: 'value', depth: 0, type: HOP };
    const f = (i: number) => call('struct_field', [el, lit(i)], 'int');
    const all = [...this.t.types.keys()];
    const edge = names.every((n, i) => all[i] === n) ? f(0) : caseWhen(names.map((n, i) => [eq(f(0), lit(i)), lit(all.indexOf(n))] as const), NULL, 'int');
    const body = call('struct_of', [edge, f(1), reverse ? f(3) : f(2), reverse ? f(2) : f(3)], HOP);
    return { k: 'each', mode: 'map', list: reverse ? call('list_reverse', [path], HOPS) : path, body, type: HOPS };
  }

  /** In a subquery: the hops of a list of the enclosing row (`HOPS`), one row each (column 0), in order. */
  private hopRows(hops: PlanExpr): PlanOp {
    return { op: 'explode', input: { op: 'values', rows: [[deepen(hops)]], types: [HOPS] }, column: 0, type: HOPS, keepNulls: false };
  }

  /**
   * In a subquery: the relationships of a list of hops of the enclosing row, in order: columns hop, type, rowid, start,
   * end, props.
   */
  private relRows(hops: PlanExpr): PlanOp {
    const collations = [0, 1, 2, 3, 4, 5].map(() => 'binary' as const);
    const parts = [...this.t.types].map(([type, table], i): PlanOp => ({
      op: 'project',
      input: { op: 'scan', table, columns: [-1, 0, 1, 2] },
      exprs: [lit(i), lit(type, 'text'), colRef(0, 'int'), colRef(1, 'int'), colRef(2, 'int'), colRef(3, PROPS)],
    }));
    const types: PlanType[] = ['int', 'text', 'int', 'int', 'int', PROPS];
    const edges: PlanOp = parts.length ? parts.reduce((a, b) => ({ op: 'setop', kind: 'unionAll', inputs: [a, b], collations })) : { op: 'values', rows: [], types };
    const f = (i: number) => call('struct_field', [colRef(0, HOP), lit(i)], 'int');
    const joined: PlanOp = { op: 'join', kind: 'inner', inputs: [this.hopRows(hops), edges], on: and(eq(f(0), rightRef(0, 'int')), eq(f(1), rightRef(2, 'int'))), ordered: true };
    return { op: 'project', input: joined, exprs: [colRef(0, HOP), colRef(2, 'text'), colRef(3, 'int'), colRef(4, 'int'), colRef(5, 'int'), colRef(6, PROPS)] };
  }

  /**
   * The relationships of these types (none: every type), each as a row of `EDGE_TYPES` read in the pattern's
   * direction, then its part's position (the order `ordered` keeps): `out` from start to end, `in` from end to start,
   * `both` either way, a self-loop once (as smaltcy's stores expand it). A union of the types' edge tables; a type the
   * graph doesn't have has no relationships.
   */
  private edges(types: readonly string[], dir: Direction): PlanOp {
    const names = this.typeNames(types);
    const branch = (type: string, reverse: boolean, position: number): PlanOp => {
      const scan: PlanOp = { op: 'scan', table: this.t.types.get(type)!, columns: [-1, 0, 1, 2] };
      const start = colRef(1, 'int');
      const end = colRef(2, 'int');
      const exprs = [lit(type, 'text'), colRef(0, 'int'), start, end, colRef(3, PROPS), reverse ? end : start, reverse ? start : end, lit(position)];
      // `both`: the reverse reading of a self-loop is the same match.
      return { op: 'project', input: dir === 'both' && reverse ? { op: 'filter', input: scan, pred: not(eq(start, end)) } : scan, exprs };
    };
    const readings = dir === 'both' ? [false, true] : [dir === 'in'];
    const parts = readings.flatMap((reverse) => names.map((t) => ({ t, reverse }))).map(({ t, reverse }, i) => branch(t, reverse, i));
    const columns: PlanType[] = [...EDGE_TYPES, 'int'];
    if (!parts.length) return { op: 'values', rows: [], types: columns };
    const collations = columns.map(() => 'binary' as const);
    return parts.reduce((a, b) => ({ op: 'setop', kind: 'unionAll', inputs: [a, b], collations }));
  }

  /** A pattern's property map: each key equals its value (Cypher's `=`, true). */
  private propsMatch(props: PlanExpr, map: Expr, frame: Frame): PlanExpr {
    if (map.k !== 'map') return unsupported('a pattern property map given as a parameter');
    const conds = map.entries.map(([key, x]) => this.equals({ k: 'value', e: call('map_get', [props, lit(key)], 'any'), t: 'any' }, this.expr(x, frame)));
    return conds.length ? and(...conds) : TRUE;
  }

  private project(r: Rel, items: readonly Projection[], discard: boolean): Rel {
    // Every item reads the input row.
    const vals = items.map((it) => ({ slot: it.slot, v: this.expr(it.expr, r.frame) }));
    const exprs: PlanExpr[] = discard ? [] : r.frame.types.map((t, i) => colRef(i, t));
    const types: PlanType[] = discard ? [] : [...r.frame.types];
    const slots = discard ? new Map<number, Binding>() : new Map(r.frame.slots);
    for (const { slot, v } of vals) {
      if (v.k === 'node') {
        slots.set(slot, { k: 'node', id: exprs.length, props: exprs.length + 1 });
        exprs.push(v.id, v.props);
        types.push('int', PROPS);
      } else if (v.k === 'rel') {
        const at = exprs.length;
        slots.set(slot, { k: 'rel', type: at, rowid: at + 1, start: at + 2, end: at + 3, props: at + 4 });
        exprs.push(v.type, v.rowid, v.start, v.end, v.props);
        types.push(...EDGE_TYPES.slice(0, 5));
      } else if (v.k === 'rels') {
        slots.set(slot, { k: 'rels', hops: exprs.length });
        exprs.push(v.hops);
        types.push(HOPS);
      } else if (v.k === 'path') {
        slots.set(slot, { k: 'path', start: exprs.length, hops: exprs.length + 1 });
        exprs.push(v.start, v.hops);
        types.push('int', HOPS);
      } else if (v.k === 'nodes') {
        slots.set(slot, { k: 'nodes', ids: exprs.length });
        exprs.push(v.ids);
        types.push(IDS);
      } else {
        slots.set(slot, { k: 'value', col: exprs.length, type: v.t });
        exprs.push(v.e);
        types.push(v.t);
      }
    }
    return { plan: { op: 'project', input: r.plan, exprs }, frame: { types, slots } };
  }

  private aggregate(r: Rel, keys: readonly Projection[], aggs: readonly AggCall[], ordered: boolean): Rel {
    const keyExprs: { expr: PlanExpr; collation: 'binary' }[] = [];
    const carry: PlanExpr[] = [];
    const types: PlanType[] = [];
    const slots = new Map<number, Binding>();
    const carried: { slot: number; props: PlanExpr }[] = [];
    for (const k of keys) {
      const v = this.expr(k.expr, r.frame);
      if (v.k !== 'value' && v.k !== 'node') return unsupported(`grouping by ${entity(v)}`);
      if (v.k === 'node') {
        // Grouped by id; its props are the same in every row of the group.
        slots.set(k.slot, { k: 'value', col: keyExprs.length, type: 'int' });
        carried.push({ slot: k.slot, props: v.props });
        keyExprs.push({ expr: v.id, collation: 'binary' });
        types.push('int');
      } else {
        this.groupable(v.t, 'grouping by');
        slots.set(k.slot, { k: 'value', col: keyExprs.length, type: v.t });
        keyExprs.push({ expr: v.e, collation: 'binary' });
        types.push(v.t);
      }
    }
    const post: { slot: number; e: (col: number) => PlanExpr; t: PlanType; nodes?: boolean }[] = [];
    const calls: plan.AggCall[] = [];
    for (const a of aggs) {
      const { call: c, post: fix, type, nodes } = this.aggCall(a, r.frame);
      const col = keyExprs.length + calls.length;
      calls.push(c);
      types.push(c.type);
      if (fix) post.push({ slot: a.slot, e: fix, t: type, ...(nodes ? { nodes } : {}) });
      else slots.set(a.slot, { k: 'value', col, type });
      if (fix) slots.set(a.slot, { k: 'value', col, type: c.type });
    }
    for (const c of carried) {
      const col = keyExprs.length + calls.length + carry.length;
      const id = (slots.get(c.slot) as ValueBinding).col;
      slots.set(c.slot, { k: 'node', id, props: col });
      carry.push(c.props);
      types.push(PROPS);
    }
    let out: Rel = { plan: { op: 'aggregate', input: r.plan, keys: keyExprs, aggs: calls, carry, ...(ordered && keyExprs.length ? { ordered: 'first' as const } : {}) }, frame: { types, slots } };
    if (post.length) {
      // Results that need a step after the aggregate (collect's NULLs dropped, sum's 0 for no rows).
      const exprs = out.frame.types.map((t, i) => colRef(i, t));
      const ts = [...out.frame.types];
      const s = new Map(out.frame.slots);
      for (const p of post) {
        const b = s.get(p.slot) as ValueBinding;
        exprs[b.col] = p.e(b.col);
        ts[b.col] = p.t;
        s.set(p.slot, p.nodes ? { k: 'nodes', ids: b.col } : { k: 'value', col: b.col, type: p.t });
      }
      out = { plan: { op: 'project', input: out.plan, exprs }, frame: { types: ts, slots: s } };
    }
    return out;
  }

  /** An aggregate call, and the step after the aggregate its result needs (reading its column). */
  private aggCall(a: AggCall, frame: Frame): { call: plan.AggCall; post?: (col: number) => PlanExpr; type: PlanType; nodes?: boolean } {
    const agg = (fn: string, args: readonly PlanExpr[], type: PlanType, star = false): plan.AggCall => ({ fn, args, star, distinct: a.distinct, collation: 'binary', type });
    if (a.fn === 'count' && a.args.length === 0) return { call: agg('count', [], 'int', true), type: 'int' };
    if (a.args.length !== 1) return unsupported(`${a.fn}() with ${a.args.length} arguments`);
    const v = this.expr(a.args[0]!, frame);
    if (a.fn === 'count' && v.k !== 'value' && v.k !== 'node' && a.distinct) return unsupported(`count(DISTINCT …) of ${entity(v)}`);
    if (a.fn === 'count') return { call: agg('count', [nullTest(v)], 'int'), type: 'int' };
    if (a.fn === 'collect' && v.k === 'node' && !a.distinct) {
      // A list of nodes: their ids, NULLs left out.
      return { call: agg('implode', [v.id], IDS), post: (col) => call('coalesce', [call('list_drop_nulls', [colRef(col, IDS)], IDS), call('list_of', [], IDS)], IDS), type: IDS, nodes: true };
    }
    if (v.k !== 'value') return unsupported(`${a.fn}() of ${v.k === 'node' ? 'nodes' : entity(v)}`);
    if (a.distinct) this.groupable(v.t, `${a.fn}(DISTINCT …)`);
    switch (a.fn) {
      case 'sum': {
        // Cypher's sum of no numbers is 0; smaltdb's is NULL.
        const x = this.numbers(v, 'sum()');
        const t = isNumberType(v.t) ? v.t : 'any';
        return { call: agg('sum', [x], t), post: (col) => call('coalesce', [colRef(col, t), lit(0)], t), type: t };
      }
      case 'avg':
        return { call: agg('avg', [this.numbers(v, 'avg()')], 'real'), type: 'real' };
      case 'min': case 'max': {
        const k = staticKind(v.t);
        if (k === K_NUMBER || k === K_STRING || k === K_BOOL) return { call: agg(a.fn, [v.e], v.t), type: v.t };
        if (k === K_OTHER) return unsupported(`${a.fn}() of a ${v.t}`);
        // Cypher's order (ORDER BY's keys): its kind's place first (NULL for NULL, so NULLs are skipped), then the value.
        const [kind, ...values] = orderKeys(v);
        const value = values.length === 1 ? values[0]! : call('list_of', values, 'list<any>');
        const t: PlanType = k === undefined ? 'any' : v.t;
        return { call: agg(a.fn === 'min' ? 'first' : 'last', [v.e, kind!, value], t), type: t };
      }
      case 'collect': {
        // Cypher's collect leaves NULLs out; smaltdb's implode keeps them. No rows: an empty list.
        const k = staticKind(v.t);
        if (k === K_LIST || k === K_MAP || k === K_OTHER) return unsupported(`collect() of a ${v.t}`);
        const t: PlanType = `list<${v.t === 'null' ? 'any' : v.t}>`;
        return {
          call: agg('implode', [v.e], t),
          post: (col) => call('coalesce', [call('list_drop_nulls', [colRef(col, t)], t), call('list_of', [], t)], t),
          type: t,
        };
      }
      default:
        return unsupported(`the aggregate ${a.fn}()`);
    }
  }

  /** A value that must be a number (or NULL), for sum and avg: anything else is Cypher's type error. */
  private numbers(v: { e: PlanExpr; t: PlanType }, what: string): PlanExpr {
    const k = staticKind(v.t);
    if (k === K_NUMBER || k === K_NULL) return v.e;
    if (k !== undefined) return unsupported(`${what} of a ${v.t}`);
    return caseWhen([[isNull(v.e), NULL], [isNumber(v), v.e]], raise('SMALTCY_TYPE', message(`${what} can't take a `, typeNameExpr(v))), 'any');
  }

  /**
   * Values grouped or deduplicated: smaltdb compares lists and maps by their bytes, where Cypher compares their
   * elements (`[1] = [1.0]`), so they are refused when the type says they are lists or maps.
   */
  private groupable(t: PlanType, what: string): void {
    const k = staticKind(t);
    if (k === K_LIST || k === K_MAP || k === K_OTHER) unsupported(`${what} a ${t}`);
  }

  /** The columns a slot is compared by in DISTINCT: a node's id, a relationship's type and rowid. */
  private keyColumns(frame: Frame, slot: number): number[] {
    const b = frame.slots.get(slot) ?? unsupported('DISTINCT over an unbound slot');
    if (b.k === 'node') return [b.id];
    if (b.k === 'rel') return [b.type, b.rowid];
    // A list of hops is a list of relationships' identities: equal lists, equal values.
    if (b.k === 'rels') return [b.hops];
    if (b.k === 'path') return [b.start, b.hops];
    if (b.k === 'nodes') return [b.ids];
    this.groupable(b.type, 'DISTINCT over');
    return [b.col];
  }

  /** ORDER BY in Cypher's order: kinds in order (maps, lists, strings, booleans, numbers, NaN, then NULL), then values. */
  private sortKeys(k: SortKey, frame: Frame): plan.SortKey[] {
    const v = this.expr(k.expr, frame);
    // Cypher's NULLs come last ascending and first descending: the order reversed.
    const key = (expr: PlanExpr): plan.SortKey => ({ expr, desc: k.desc, nullsFirst: k.desc, collation: 'binary' });
    if (v.k === 'node') return [key(v.id)];
    if (v.k !== 'value') return unsupported(`ORDER BY ${entity(v)}`);
    const kind = staticKind(v.t);
    if (kind === K_NUMBER) return mayBeNaN(v.t) ? [key(caseWhen([[isNull(v.e), NULL], [isNaNExpr(v.e), lit(1)]], lit(0), 'int')), key(v.e)] : [key(v.e)];
    if (kind === K_STRING || kind === K_BOOL || kind === K_NULL) return [key(v.e)];
    if (kind === K_OTHER) return unsupported(`ORDER BY a ${v.t}`);
    return orderKeys(v).map(key);
  }

  /** SKIP and LIMIT: a non-negative whole number, a literal or a parameter. */
  private count(x: Expr, what: string): PlanExpr {
    const value = x.k === 'lit' ? x.v : x.k === 'param' ? this.params[x.name] : unsupported(`${what} that isn't a literal or a parameter`);
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new SmaltcyError('SMALTCY_TYPE', `${what} must be a non-negative integer`);
    return (this.expr(x, { types: [], slots: new Map() }) as { e: PlanExpr }).e;
  }

  private unwind(r: Rel, list: Expr, slot: number): Rel {
    const v = this.expr(list, r.frame);
    if (v.k !== 'value') return unsupported(`UNWIND of ${entity(v)}`);
    const exprs = r.frame.types.map((t, i) => colRef(i, t));
    const col = exprs.length;
    const slots = new Map(r.frame.slots);
    const k = staticKind(v.t);
    if (k !== K_LIST) {
      if (k !== undefined) {
        // UNWIND of a value that isn't a list: one row with it, none for NULL.
        slots.set(slot, { k: 'value', col, type: v.t });
        const plan: PlanOp = { op: 'filter', input: { op: 'project', input: r.plan, exprs: [...exprs, v.e] }, pred: isNotNull(colRef(col, v.t)) };
        return { plan, frame: { types: [...r.frame.types, v.t], slots } };
      }
      return unsupported('UNWIND of a value whose type is known only when it runs');
    }
    const elem = v.t.slice(5, -1) as PlanType;
    slots.set(slot, { k: 'value', col, type: elem });
    const plan: PlanOp = { op: 'explode', input: { op: 'project', input: r.plan, exprs: [...exprs, v.e] }, column: col, type: v.t, keepNulls: false };
    return { plan, frame: { types: [...r.frame.types, elem], slots } };
  }

  private union(op: Extract<Op, { op: 'union' }>, ordered: boolean): Rel {
    const branches = op.inputs.map((i) => this.op(i, ordered));
    const types: PlanType[] = [];
    op.slots.forEach((s, i) => {
      const bs = branches.map((b) => b.frame.slots.get(s) ?? unsupported('a UNION branch without a column'));
      if (bs.some((b) => b.k !== 'value')) unsupported('UNION of nodes or relationships');
      const t = commonType(bs.map((b) => (b as ValueBinding).type));
      if (t === undefined || (bs.some((b) => (b as ValueBinding).type !== t) && t !== 'any' && t !== 'num')) unsupported('UNION of columns of different types');
      types[i] = t!;
    });
    const projected = branches.map((b): PlanOp => ({ op: 'project', input: b.plan, exprs: op.slots.map((s) => colRef((b.frame.slots.get(s) as ValueBinding).col, (b.frame.slots.get(s) as ValueBinding).type)) }));
    let plan = projected[0]!;
    const collations = types.map(() => 'binary' as const);
    for (const p of projected.slice(1)) plan = { op: 'setop', kind: 'unionAll', inputs: [plan, p], collations };
    if (!op.all) {
      for (const t of types) this.groupable(t, 'UNION of');
      plan = { op: 'distinct', input: plan, collations, ...(ordered ? { ordered: 'first' as const } : {}) };
    }
    const slots = new Map<number, Binding>(op.slots.map((s, i) => [s, { k: 'value', col: i, type: types[i]! }]));
    return { plan, frame: { types, slots } };
  }

  // Expressions.

  /** A predicate (WHERE, CASE WHEN): a boolean, or NULL; any other value is Cypher's type error. */
  private predicate(x: Expr, frame: Frame, what: string): PlanExpr {
    return this.truth(this.expr(x, frame), what);
  }

  private truth(v: Val, what: string): PlanExpr {
    if (v.k !== 'value') return unsupported(`${what} given ${entity(v)}`);
    const k = staticKind(v.t);
    if (k === K_BOOL || k === K_NULL) return v.e;
    if (k !== undefined) return unsupported(`${what} given a ${v.t}`);
    // smaltcy's engine names WHERE and CASE conditions; AND, OR, XOR, NOT and the predicates of list comprehensions and
    // quantifiers are 'A predicate' there.
    const named = what === 'WHERE' || what === 'A CASE condition' ? what : 'A predicate';
    return caseWhen([[isNull(v.e), NULL], [eq(kindExpr(v), lit(K_BOOL)), call('any_bool', [v.e], 'bool')]], raise('SMALTCY_TYPE', message(`${named} must be a boolean, not `, typeNameExpr(v)), 'bool'), 'bool');
  }

  expr(x: Expr, frame: Frame): Val {
    const value = (e: PlanExpr, t: PlanType): Val => ({ k: 'value', e, t });
    switch (x.k) {
      case 'lit':
        if (Array.isArray(x.v)) return this.list(x.v.map((v) => this.expr({ k: 'lit', v }, frame)));
        if (x.v !== null && typeof x.v === 'object') return unsupported('map literals as values');
        return literal(x.v);
      case 'param': {
        if (!(x.name in this.params)) return unsupported(`the parameter $${x.name}, which wasn't given when compiling`);
        let i = this.paramNames.indexOf(x.name);
        if (i < 0) i = this.paramNames.push(x.name) - 1;
        const v = this.params[x.name];
        const t: PlanType =
          v === null ? 'null' : typeof v === 'boolean' ? 'bool' : typeof v === 'number' ? (Number.isSafeInteger(v) ? 'int' : 'real') : typeof v === 'string' ? 'text' : unsupported(`a parameter that is a ${Array.isArray(v) ? 'list' : typeof v}`);
        return value({ k: 'param', index: i, type: t }, t);
      }
      case 'slot': {
        let el = this.elements.length - 1;
        while (el >= 0 && this.elements[el]!.slot !== x.i) el--;
        if (el >= 0) {
          const { type, kind } = this.elements[el]!;
          const e: PlanExpr = { k: 'element', part: 'value', depth: this.elements.length - 1 - el, type };
          const field = (i: number, t: PlanType) => call('struct_field', [e, lit(i)], t);
          if (kind === 'node') return { k: 'node', id: field(0, 'int'), props: field(1, PROPS) };
          if (kind === 'rel') return { k: 'rel', type: field(0, 'text'), rowid: field(1, 'int'), start: field(2, 'int'), end: field(3, 'int'), props: field(4, PROPS) };
          return value(e, type);
        }
        const b = frame.slots.get(x.i) ?? unsupported(`a slot that isn't bound (${x.i})`);
        return this.valueOf(b);
      }
      case 'prop': {
        const of = this.expr(x.of, frame);
        if (of.k === 'node' || of.k === 'rel') return value(call('map_get', [of.props, lit(x.key)], 'any'), 'any');
        if (of.k !== 'value') return unsupported(`reading a property of ${entity(of)}`);
        const k = staticKind(of.t);
        if (k === K_MAP) return value(call('map_get', [of.e, lit(x.key)], of.t.slice(10, -1) as PlanType), of.t.slice(10, -1) as PlanType);
        if (k === K_NULL) return value(NULL, 'null');
        return unsupported(`reading a property of a ${of.t}`);
      }
      case 'call':
        return this.call(x.fn, x.args, frame);
      case 'list':
        return this.list(x.items.map((i) => this.expr(i, frame)));
      case 'map': {
        const vals = x.entries.map(([k, v]) => [k, this.expr(v, frame)] as const);
        if (vals.some(([, v]) => v.k !== 'value')) unsupported('nodes and relationships in maps');
        const t = commonType(vals.map(([, v]) => (v as { t: PlanType }).t)) ?? 'any';
        const mt: PlanType = `map<text, ${t === 'null' ? 'any' : t}>`;
        return value(call('map_of', vals.flatMap(([k, v]) => [lit(k), (v as { e: PlanExpr }).e]), mt), mt);
      }
      case 'and': case 'or': {
        const args = x.args.map((a) => this.predicate(a, frame, x.k.toUpperCase()));
        return value(x.k === 'and' ? and(...args) : or(...args), 'bool');
      }
      case 'xor': {
        // (a OR b) AND NOT (a AND b), folded left: NULL when either is NULL.
        const args = x.args.map((a) => this.predicate(a, frame, 'XOR'));
        return value(args.reduce((a, b) => and(or(a, b), not(and(a, b)))), 'bool');
      }
      case 'not':
        return value(not(this.predicate(x.arg, frame, 'NOT')), 'bool');
      case 'isNull': {
        const v = this.expr(x.arg, frame);
        const e = nullTest(v);
        return value(x.negated ? isNotNull(e) : isNull(e), 'bool');
      }
      case 'hasLabels': {
        const v = this.expr(x.of, frame);
        if (v.k !== 'node') return unsupported('label tests of values that are not nodes');
        return value(this.hasLabels(v.id, x.labels), 'bool');
      }
      case 'case':
        return this.caseExpr(x, frame);
      case 'index': {
        const of = this.expr(x.of, frame);
        const i = this.expr(x.index, frame);
        if (i.k !== 'value') return unsupported(`${entity(i)} as an index`);
        if (of.k !== 'value') {
          if (of.k !== 'node' && of.k !== 'rel') return unsupported(`indexing ${entity(of)}`);
          if (i.t !== 'text') return unsupported(`${entity(of)} indexed by a value that may not be a string`);
          return value(call('map_get', [of.props, i.e], 'any'), 'any');
        }
        if (staticKind(of.t) === K_LIST && i.t === 'int') {
          const t = of.t.slice(5, -1) as PlanType;
          return value(call('list_get', [of.e, i.e], t), t);
        }
        return unsupported(`indexing a ${of.t} with a ${i.t}`);
      }
      case 'slice': return unsupported('list slices');
      case 'listComp': {
        const { list, elem, kind } = this.listOf(x.list, frame, 'a list comprehension');
        // Nodes and relationships are list elements as structs, which are not what a result gives for them.
        if (kind !== 'value' && !x.map) return unsupported('a list comprehension giving nodes or relationships');
        let out: Val = { k: 'value', e: list, t: `list<${elem}>` };
        if (x.where) {
          const pred = this.inElement(x.slot, elem, () => this.predicate(x.where!, frame, "a list comprehension's WHERE"), kind);
          out = { k: 'value', e: { k: 'each', mode: 'filter', list: out.e, body: pred, type: out.t }, t: out.t };
        }
        if (x.map) {
          const body = this.inElement(x.slot, elem, () => this.expr(x.map!, frame), kind);
          if (body.k !== 'value') return unsupported('a list comprehension giving nodes or relationships');
          if (staticKind(body.t) === K_OTHER) return unsupported(`a list comprehension giving a ${body.t}`);
          const t: PlanType = `list<${body.t === 'null' ? 'any' : body.t}>`;
          out = { k: 'value', e: { k: 'each', mode: 'map', list: out.e, body: body.e, type: t }, t };
        }
        return out;
      }
      case 'quantifier':
        return value(this.quantifier(x, frame), 'bool');
      case 'exists':
        // EXISTS { … } and a pattern as a predicate: whether the nested plan has a row (true or false, never NULL).
        return value(this.nested(x.plan, frame, false, (r) => ({ k: 'subquery', mode: 'exists', type: 'bool', collation: 'binary', plan: r.plan })), 'bool');
      case 'collectSub':
        return this.patternComprehension(x, frame);
    }
  }

  /**
   * A nested plan (EXISTS, a pattern comprehension) as a correlated subquery of the row `frame` describes: its
   * `argument` leaf is that row's columns, read one subquery out (`outer`).
   */
  private nested<T>(op: Op, frame: Frame, ordered: boolean, f: (r: Rel) => T): T {
    // smaltdb's nested plans don't read an `each`'s elements.
    if (this.elements.length) unsupported('EXISTS and pattern comprehensions inside list comprehensions and quantifiers');
    this.outer.push(frame);
    try {
      return f(this.op(op, ordered));
    } finally {
      this.outer.pop();
    }
  }

  /**
   * `[(a)-->(b) WHERE … | map]`: `map` of each row of the nested plan, in its order, NULLs kept (an `implode` over a
   * correlated subquery); `[]` when it has none. Nodes are a list of their ids, as `collect()` gives them.
   */
  private patternComprehension(x: Extract<Expr, { k: 'collectSub' }>, frame: Frame): Val {
    // The list keeps the order the pattern matches in.
    return this.nested(x.plan, frame, true, (r): Val => {
      const m = this.expr(x.map, r.frame);
      let item: PlanExpr;
      let t: PlanType;
      if (m.k === 'node') {
        item = m.id;
        t = IDS;
      } else if (m.k !== 'value') {
        return unsupported(`a pattern comprehension giving ${entity(m)}`);
      } else {
        if (staticKind(m.t) === K_OTHER) unsupported(`a pattern comprehension giving a ${m.t}`);
        item = m.e;
        t = `list<${m.t === 'null' ? 'any' : m.t}>`;
      }
      const agg: PlanOp = { op: 'aggregate', input: r.plan, keys: [], aggs: [{ fn: 'implode', args: [item], star: false, distinct: false, collation: 'binary', type: t }], carry: [] };
      const list = call('coalesce', [{ k: 'subquery', mode: 'scalar', plan: agg, type: t, collation: 'binary' }, call('list_of', [], t)], t);
      return m.k === 'node' ? { k: 'nodes', ids: list } : { k: 'value', e: list, t };
    });
  }

  /** A list to iterate over, and its elements' type: a list, or NULL. */
  private listOf(x: Expr, frame: Frame, what: string): { list: PlanExpr; elem: PlanType; kind: ElementKind } {
    const v = this.expr(x, frame);
    if (v.k === 'rels') return { list: this.relList(v.hops), elem: REL, kind: 'rel' };
    if (v.k === 'nodes') return { list: this.nodeList(v.ids), elem: NODE, kind: 'node' };
    if (v.k !== 'value') return unsupported(`${what} over ${entity(v)}`);
    return { ...this.valueList(v, what), kind: 'value' };
  }

  private valueList(v: { e: PlanExpr; t: PlanType }, what: string): { list: PlanExpr; elem: PlanType } {
    const k = staticKind(v.t);
    if (k === K_LIST) return { list: v.e, elem: v.t.slice(5, -1) as PlanType };
    if (k === K_NULL) return { list: { k: 'lit', value: null, type: 'list<any>' }, elem: 'any' };
    if (k !== undefined) return unsupported(`${what} over a ${v.t}`);
    // Known only when it runs: a list under any, NULL, or Cypher's type error.
    return { list: caseWhen([[isNull(v.e), NULL], [eq(kindExpr(v), lit(K_LIST)), call('any_list', [v.e], 'list<any>')]], raise('SMALTCY_TYPE', message("Can't iterate over a ", typeNameExpr(v)), 'list<any>'), 'list<any>'), elem: 'any' };
  }

  /** Compiles `f` with `slot` reading the element of the innermost `each`. */
  private inElement<T>(slot: number, type: PlanType, f: () => T, kind: ElementKind = 'value'): T {
    this.elements.push({ slot, type, kind });
    try {
      return f();
    } finally {
      this.elements.pop();
    }
  }

  /**
   * `any`, `all`, `none` and `single` with Cypher's NULLs: the elements whose predicate is true, NULL and false are
   * counted (smaltdb's `each` with aggregates), then compared.
   */
  private quantifier(x: Extract<Expr, { k: 'quantifier' }>, frame: Frame): PlanExpr {
    const { list, elem, kind } = this.listOf(x.list, frame, `${x.q}()`);
    const pred = this.inElement(x.slot, elem, () => this.predicate(x.where, frame, `${x.q}()`), kind);
    const count = (filter: PlanExpr) => ({ fn: 'count', args: [], star: true, distinct: false, filter, collation: 'binary' as const, type: 'int' as const });
    const n = (i: number): PlanExpr => ({ k: 'eachAgg', index: i, depth: 0, type: 'int' });
    const some = (i: number) => call('cmp_gt', [n(i), lit(0)], 'bool');
    const yes = 0;
    const nulls = 1;
    const no = 2;
    let body: PlanExpr;
    switch (x.q) {
      case 'any': body = caseWhen([[some(yes), TRUE], [some(nulls), NULL]], FALSE, 'bool'); break;
      case 'all': body = caseWhen([[some(no), FALSE], [some(nulls), NULL]], TRUE, 'bool'); break;
      case 'none': body = caseWhen([[some(yes), FALSE], [some(nulls), NULL]], TRUE, 'bool'); break;
      case 'single': body = caseWhen([[call('cmp_gt', [n(yes), lit(1)], 'bool'), FALSE], [some(nulls), NULL]], eq(n(yes), lit(1)), 'bool'); break;
    }
    return { k: 'each', mode: 'agg', list, aggs: [count(eq(pred, TRUE)), count(isNull(pred)), count(eq(pred, FALSE))], body, type: 'bool' };
  }

  private list(items: readonly Val[]): Val {
    if (items.some((v) => v.k !== 'value')) unsupported('lists of nodes or relationships');
    const vs = items as readonly { e: PlanExpr; t: PlanType }[];
    if (vs.some((v) => staticKind(v.t) === K_OTHER)) unsupported('lists of other values');
    const types = [...new Set(vs.map((v) => v.t).filter((t) => t !== 'null'))];
    // One type: a list of it. Several: list<any>, where booleans and nested values keep their type (smaltdb ADR 0039).
    const elem: PlanType = types.length === 1 ? types[0]! : 'any';
    const t: PlanType = `list<${elem}>`;
    return { k: 'value', e: call('list_of', vs.map((v) => v.e), t), t };
  }

  /** `n:A:B`: the node has every label (an entry in the label index for each). NULL for no node. */
  private hasLabels(id: PlanExpr, labels: readonly string[]): PlanExpr {
    if (id.k !== 'col') return unsupported('a label test of a computed node');
    const outer: PlanExpr = { ...id, depth: id.depth + 1 };
    const tests = labels.map((l): PlanExpr => ({
      k: 'subquery',
      mode: 'exists',
      type: 'bool',
      collation: 'binary',
      plan: {
        op: 'filter',
        input: { op: 'scan', table: this.t.labels, columns: [0, 1] },
        pred: and(eq(colRef(0, 'int'), outer), eq(colRef(1, 'text'), lit(l))),
      },
    }));
    return caseWhen([[isNull(id), NULL]], and(...tests), 'bool');
  }

  /** What a slot's columns hold. */
  valueOf(b: Binding): Val {
    switch (b.k) {
      case 'value': return { k: 'value', e: colRef(b.col, b.type), t: b.type };
      case 'node': return { k: 'node', id: colRef(b.id, 'int'), props: colRef(b.props, PROPS) };
      case 'rel': return { k: 'rel', type: colRef(b.type, 'text'), rowid: colRef(b.rowid, 'int'), start: colRef(b.start, 'int'), end: colRef(b.end, 'int'), props: colRef(b.props, PROPS) };
      case 'rels': return { k: 'rels', hops: colRef(b.hops, HOPS) };
      case 'path': return { k: 'path', start: colRef(b.start, 'int'), hops: colRef(b.hops, HOPS) };
      case 'nodes': return { k: 'nodes', ids: colRef(b.ids, IDS) };
    }
  }

  /**
   * A node, relationship, path or list of them in a result, as smaltcy's engine gives it (`Node`, `Relationship` and
   * `Path` in values.ts): a map of its kind, id, labels or type and ends, and properties; NULL for none.
   */
  resultValue(v: Exclude<Val, { k: 'value' }>): { e: PlanExpr; t: PlanType } {
    const MAPS: PlanType = `list<${PROPS}>`;
    switch (v.k) {
      case 'node': return { e: this.nodeMap(v.id, v.props), t: PROPS };
      case 'rel': return { e: this.relMap(v), t: PROPS };
      case 'nodes': return { e: this.listOfRows(v.ids, this.nodeRows(v.ids), (r) => this.nodeMap(colRef(r, 'int'), colRef(r + 1, PROPS)), MAPS), t: MAPS };
      case 'rels': return { e: this.listOfRows(v.hops, this.relRows(v.hops), (r) => this.relMap(this.relAt(r)), MAPS), t: MAPS };
      case 'path': {
        const ids = this.pathNodeIds(v);
        const nodes = this.listOfRows(ids, this.nodeRows(ids), (r) => this.nodeMap(colRef(r, 'int'), colRef(r + 1, PROPS)), MAPS);
        const rels = this.listOfRows(v.hops, this.relRows(v.hops), (r) => this.relMap(this.relAt(r)), MAPS);
        return { e: caseWhen([[isNull(v.hops), NULL]], resultMapOf([['kind', lit('path')], ['nodes', nodes], ['relationships', rels]]), PROPS), t: PROPS };
      }
    }
  }

  private nodeMap(id: PlanExpr, props: PlanExpr): PlanExpr {
    return caseWhen([[isNull(id), NULL]], resultMapOf([['kind', lit('node')], ['id', id], ['labels', this.labelsOf(id)], ['properties', props]]), PROPS);
  }

  private relMap(v: RelVal): PlanExpr {
    if (!this.t.relationshipIds) return unsupported('relationships in results (the graph was loaded without relationship ids)');
    return caseWhen([[isNull(v.rowid), NULL]], resultMapOf([['kind', lit('relationship')], ['id', v.rowid], ['type', v.type], ['start', v.start], ['end', v.end], ['properties', v.props]]), PROPS);
  }

  /** The relationship in a row of `relRows`, from column `r` (its type). */
  private relAt(r: number): RelVal {
    return { k: 'rel', type: colRef(r, 'text'), rowid: colRef(r + 1, 'int'), start: colRef(r + 2, 'int'), end: colRef(r + 3, 'int'), props: colRef(r + 4, PROPS) };
  }

  /**
   * A list made in a subquery from the rows of `rows` (`relRows` or `nodeRows`, whose columns after the first are read
   * from column 1): `item` of each, in order. NULL when `list` (an expression of this row) is NULL; else `[]` for none.
   */
  private listOfRows(list: PlanExpr, rows: PlanOp, item: (col: number) => PlanExpr, t: PlanType): PlanExpr {
    const agg: PlanOp = { op: 'aggregate', input: rows, keys: [], aggs: [{ fn: 'implode', args: [item(1)], star: false, distinct: false, collation: 'binary', type: t }], carry: [] };
    const sub: PlanExpr = { k: 'subquery', mode: 'scalar', plan: agg, type: t, collation: 'binary' };
    return caseWhen([[isNull(list), NULL]], call('coalesce', [sub, call('list_of', [], t)], t), t);
  }

  /** A list of relationships (hops) as list elements: `REL` structs. */
  private relList(hops: PlanExpr): PlanExpr {
    return this.listOfRows(hops, this.relRows(hops), (r) => call('struct_of', [0, 1, 2, 3, 4].map((i) => colRef(r + i, EDGE_TYPES[i]!)), REL), `list<${REL}>`);
  }

  /** A list of nodes (ids) as list elements: `NODE` structs. */
  private nodeList(ids: PlanExpr): PlanExpr {
    return this.listOfRows(ids, this.nodeRows(ids), (r) => call('struct_of', [colRef(r, 'int'), colRef(r + 1, PROPS)], NODE), `list<${NODE}>`);
  }

  /** In a subquery: the nodes of a list of ids of the enclosing row, in order: columns id (twice), props. */
  private nodeRows(ids: PlanExpr): PlanOp {
    const each: PlanOp = { op: 'explode', input: { op: 'values', rows: [[deepen(ids)]], types: [IDS] }, column: 0, type: IDS, keepNulls: false };
    return { op: 'join', kind: 'inner', inputs: [each, { op: 'scan', table: this.t.nodes, columns: [0, 1] }], on: eq(colRef(0, 'int'), rightRef(0, 'int')), ordered: true };
  }

  /** A path's nodes: its first, then where each hop went. */
  private pathNodeIds(v: PathVal): PlanExpr {
    const to = call('struct_field', [{ k: 'element', part: 'value', depth: 0, type: HOP }, lit(3)], 'int');
    return caseWhen([[isNull(v.hops), NULL]], call('list_concat', [call('list_of', [v.start], IDS), { k: 'each', mode: 'map', list: v.hops, body: to, type: IDS }], IDS), IDS);
  }

  /** The node with this id (a relationship's end): its props read from the node table. */
  private nodeById(id: PlanExpr): Val {
    const props: PlanOp = { op: 'project', input: { op: 'filter', input: { op: 'scan', table: this.t.nodes, columns: [0, 1] }, pred: eq(colRef(0, 'int'), outerRef(id, 'a node')) }, exprs: [colRef(1, PROPS)] };
    return { k: 'node', id, props: { k: 'subquery', mode: 'scalar', plan: props, type: PROPS, collation: 'binary' } };
  }

  /**
   * `degree(n [, direction [, type]])`: the node's relationships counted in each edge table (a self-loop once with
   * `both`, as smaltcy's stores count it). The direction and type must be string literals.
   */
  private degree(args: readonly Expr[], frame: Frame): PlanExpr {
    const n = this.expr(args[0]!, frame);
    if (n.k !== 'node') return unsupported('degree() of a value that is not a node');
    const str = (x: Expr | undefined) => (x === undefined ? undefined : x.k === 'lit' && typeof x.v === 'string' ? x.v : unsupported("degree() with a direction or type that isn't a string literal"));
    const dir = (str(args[1]) ?? 'both').toLowerCase();
    if (dir !== 'out' && dir !== 'in' && dir !== 'both') return unsupported(`degree() in the direction ${JSON.stringify(dir)}`);
    const type = str(args[2]);
    const names = type === undefined ? [...this.t.types.keys()] : this.t.types.has(type) ? [type] : [];
    const id = outerRef(n.id, 'degree()');
    const start = colRef(0, 'int');
    const end = colRef(1, 'int');
    const pred = dir === 'out' ? eq(start, id) : dir === 'in' ? eq(end, id) : or(eq(start, id), and(eq(end, id), not(eq(start, end))));
    const counts = names.map((t): PlanExpr => ({
      k: 'subquery',
      mode: 'scalar',
      type: 'int',
      collation: 'binary',
      plan: {
        op: 'aggregate',
        input: { op: 'filter', input: { op: 'scan', table: this.t.types.get(t)!, columns: [0, 1] }, pred },
        keys: [],
        aggs: [{ fn: 'count', args: [], star: true, distinct: false, collation: 'binary', type: 'int' }],
        carry: [],
      },
    }));
    const sum = counts.length ? counts.reduce((a, b) => call('add_checked', [a, b], 'int')) : lit(0);
    return caseWhen([[isNull(n.id), NULL]], sum, 'int');
  }

  /** `labels(n)`: the node's labels in the order it has them (the label index's rowid order). */
  private labelsOf(id: PlanExpr): PlanExpr {
    if (id.k !== 'col') return unsupported('labels() of a computed node');
    const outer: PlanExpr = { ...id, depth: id.depth + 1 };
    const entries: PlanOp = {
      op: 'sort',
      input: { op: 'filter', input: { op: 'scan', table: this.t.labels, columns: [-1, 0, 1] }, pred: eq(colRef(1, 'int'), outer) },
      keys: [{ expr: colRef(0, 'int'), desc: false, nullsFirst: true, collation: 'binary' }],
    };
    const t: PlanType = 'list<text>';
    const list: PlanOp = { op: 'aggregate', input: entries, keys: [], aggs: [{ fn: 'implode', args: [colRef(2, 'text')], star: false, distinct: false, collation: 'binary', type: t }], carry: [] };
    const sub: PlanExpr = { k: 'subquery', mode: 'scalar', plan: list, type: t, collation: 'binary' };
    return caseWhen([[isNull(id), NULL]], call('coalesce', [sub, call('list_of', [], t)], t), t);
  }

  private caseExpr(x: Extract<Expr, { k: 'case' }>, frame: Frame): Val {
    const operand = x.operand ? this.expr(x.operand, frame) : undefined;
    const whens = x.whens.map(([w, th]) => {
      const cond = operand ? this.equals(operand, this.expr(w, frame)) : this.predicate(w, frame, 'A CASE condition');
      return [cond, this.expr(th, frame)] as const;
    });
    const otherwise = x.else ? this.expr(x.else, frame) : ({ k: 'value', e: NULL, t: 'null' } as const);
    const results = [...whens.map(([, v]) => v), otherwise];
    if (results.some((v) => v.k !== 'value')) unsupported('CASE giving nodes or relationships');
    const t = commonType(results.map((v) => (v as { t: PlanType }).t)) ?? unsupported('CASE whose results are booleans or lists and values of other types');
    return { k: 'value', e: caseWhen(whens.map(([c, v]) => [c, (v as { e: PlanExpr }).e]), (otherwise as { e: PlanExpr }).e, t), t };
  }

  // Cypher's comparisons.

  /** `a = b`: NULL when either is NULL, false across kinds, numbers by value (NaN equals nothing), lists and maps by their elements. */
  private equals(a: Val, b: Val): PlanExpr {
    if (a.k !== 'value' || b.k !== 'value') {
      if (a.k === 'node' && b.k === 'node') return eq(a.id, b.id);
      if (a.k === 'rel' && b.k === 'rel') return and(eq(a.type, b.type), eq(a.rowid, b.rowid));
      return unsupported('comparing a node or relationship with another kind of value');
    }
    // A value of any kind and a string or number literal: smaltdb's `cmp_eq` is Cypher's `=` there (NULL with a NULL;
    // false for a value of another kind, booleans, lists and maps included; numbers by value, NaN equal to nothing), and
    // a plain comparison lets smaltdb seek with an index on the property.
    if ((a.t === 'any' && scalarLiteral(b)) || (b.t === 'any' && scalarLiteral(a))) return eq(a.e, b.e);
    const e = this.compareBy(a, b, (x, y, kind) => {
      if (kind === K_NUMBER) return mayBeNaN(x.t) || mayBeNaN(y.t) ? and(eq(x.e, y.e), not(isNaNExpr(x.e))) : eq(x.e, y.e);
      if (kind === K_BOOL) return eq(asBoolValue(x), asBoolValue(y));
      return eq(x.e, y.e);
    }, FALSE, (x, y) => valueEquals(x, y, NESTING));
    return bindVars(e);
  }

  /**
   * `<` and the others: NULL across kinds, for NaN and for maps; strings by code unit order is smaltdb's UTF-8 byte
   * order; lists element by element.
   */
  private ordering(fn: string, a: Val, b: Val): PlanExpr {
    if (a.k !== 'value' || b.k !== 'value') return unsupported('ordering comparisons of nodes and relationships');
    // A value of any kind and a string or number literal: smaltdb's comparison where the value is of the literal's kind
    // (a number that isn't NaN), else NULL.
    const literal = scalarLiteral(a) ? a : scalarLiteral(b) ? b : undefined;
    const other = literal === a ? b : a;
    if (literal && other.t === 'any') {
      const kind = call('any_type', [other.e], 'text');
      const same = literal.t === 'text' ? eq(kind, lit('text')) : and(call('in_list', [kind, lit('int'), lit('real')], 'bool'), not(isNaNExpr(other.e)));
      return caseWhen([[same, call(fn, [a.e, b.e], 'bool')]], NULL, 'bool');
    }
    const e = this.compareBy(a, b, (x, y, kind) => {
      const c = (p: PlanExpr, q: PlanExpr) => call(fn, [p, q], 'bool');
      if (kind === K_NUMBER) return mayBeNaN(x.t) || mayBeNaN(y.t) ? caseWhen([[or(isNaNExpr(x.e), isNaNExpr(y.e)), NULL]], c(x.e, y.e), 'bool') : c(x.e, y.e);
      if (kind === K_BOOL) return c(asBoolValue(x), asBoolValue(y));
      return c(x.e, y.e);
    }, NULL, (x, y) => {
      if (!(may(x, K_LIST) && may(y, K_LIST))) return NULL;
      const lists = call(fn, [listCompare(asList(x), asList(y), NESTING - 1), lit(0)], 'bool');
      return staticKind(x.t) === K_LIST || staticKind(y.t) === K_LIST ? lists : caseWhen([[eq(kindExpr(x), lit(K_LIST)), lists]], NULL, 'bool');
    });
    return bindVars(e);
  }

  /**
   * A comparison of two values by their kinds: `same` for two numbers, strings or booleans, `nested` for two lists or
   * two maps, `across` for values of different kinds.
   */
  private compareBy(
    a: { e: PlanExpr; t: PlanType },
    b: { e: PlanExpr; t: PlanType },
    same: (a: { e: PlanExpr; t: PlanType }, b: { e: PlanExpr; t: PlanType }, kind: number) => PlanExpr,
    across: PlanExpr,
    nested: (a: { e: PlanExpr; t: PlanType }, b: { e: PlanExpr; t: PlanType }) => PlanExpr,
  ): PlanExpr {
    const ka = staticKind(a.t);
    const kb = staticKind(b.t);
    const comparable = (k: number) => k === K_NUMBER || k === K_STRING || k === K_BOOL;
    const container = (k: number) => k === K_LIST || k === K_MAP;
    if (ka === K_NULL || kb === K_NULL) return NULL;
    if (ka !== undefined && kb !== undefined) {
      if (ka === kb && comparable(ka)) return same(a, b, ka);
      if (ka === kb && container(ka)) return caseWhen([[or(isNull(a.e), isNull(b.e)), NULL]], nested(a, b), 'bool');
      return caseWhen([[or(isNull(a.e), isNull(b.e)), NULL]], ka === kb ? NULL : across, 'bool');
    }
    // A kind is known only when the value is: compare by kind at run time.
    const kindA = ka !== undefined ? lit(ka) : kindExpr(a);
    const kindB = kb !== undefined ? lit(kb) : kindExpr(b);
    const kinds = [K_NUMBER, K_STRING, K_BOOL].filter((k) => (ka === undefined || ka === k) && (kb === undefined || kb === k));
    const containers = [K_LIST, K_MAP].some((k) => (ka === undefined || ka === k) && (kb === undefined || kb === k));
    return caseWhen(
      [
        [or(isNull(a.e), isNull(b.e)), NULL],
        [not(eq(kindA, kindB)), across],
        ...kinds.map((k) => [eq(kindA, lit(k)), same(a, b, k)] as const),
        ...(containers ? [[call('in_list', [kindA, lit(K_LIST), lit(K_MAP)], 'bool'), nested(a, b)] as const] : []),
      ],
      NULL,
      'bool',
    );
  }

  // Functions.

  private call(fn: string, args: readonly Expr[], frame: Frame): Val {
    const value = (e: PlanExpr, t: PlanType): Val => ({ k: 'value', e, t });
    const vals = () => args.map((a) => this.expr(a, frame));
    const values = () => vals().map((v) => (v.k !== 'value' ? unsupported(`${fn}() of ${entity(v)}`) : v));
    switch (fn) {
      case 'eq': {
        const [a, b] = vals();
        return value(this.equals(a!, b!), 'bool');
      }
      case 'neq': {
        const [a, b] = vals();
        return value(not(this.equals(a!, b!)), 'bool');
      }
      case 'lt': case 'le': case 'gt': case 'ge': {
        const [a, b] = vals();
        return value(this.ordering(`cmp_${fn}`, a!, b!), 'bool');
      }
      case 'add': case 'sub': case 'mul': case 'div': case 'div_float': case 'mod':
        return this.arithmetic(fn, values() as { e: PlanExpr; t: PlanType }[]);
      case 'neg': {
        const [a] = values() as { e: PlanExpr; t: PlanType }[];
        return value(call('neg', [this.number(a!, 'negate()')], isNumberType(a!.t) ? a!.t : 'any'), isNumberType(a!.t) ? a!.t : 'any');
      }
      case 'in': {
        // A list written in the query: x IN [a, b] is x = a OR x = b, with Cypher's NULLs.
        if (args[1]!.k !== 'list') return unsupported('IN with a list that is not written in the query');
        const x = this.expr(args[0]!, frame);
        const items = args[1]!.items.map((i) => this.expr(i, frame));
        return value(items.length ? or(...items.map((i) => this.equals(x, i))) : FALSE, 'bool');
      }
      case 'starts_with': case 'ends_with': case 'contains': case 'regex_match': {
        const [a, b] = values() as { e: PlanExpr; t: PlanType }[];
        // NULL unless both are strings. =~ matches the whole string.
        const pattern = fn === 'regex_match' ? call('text_concat', [call('text_concat', [lit('^(?:'), b!.e], 'text'), lit(')$')], 'text') : b!.e;
        const both = and(eq(kindExpr(a!), lit(K_STRING)), eq(kindExpr(b!), lit(K_STRING)));
        return value(caseWhen([[both, call(fn, [a!.e, pattern], 'bool')]], NULL, 'bool'), 'bool');
      }
      case 'id': {
        const [a] = vals();
        if (a!.k === 'node') return value(a!.id, 'int');
        if (a!.k !== 'rel') return unsupported('id() of a value that is not a node or a relationship');
        // A relationship's rowid is its smaltcy id only when the graph was loaded with them (schema.ts).
        if (!this.t.relationshipIds) return unsupported('id() of a relationship (the graph was loaded without relationship ids)');
        return value(a!.rowid, 'int');
      }
      case 'type': {
        const [a] = vals();
        if (a!.k !== 'rel') return unsupported('type() of a value that is not a relationship');
        return value(a!.type, 'text');
      }
      case 'startNode': case 'endNode': {
        const [a] = vals();
        if (a!.k !== 'rel') return unsupported(`${fn}() of a value that is not a relationship`);
        return this.nodeById(fn === 'startNode' ? a!.start : a!.end);
      }
      case 'degree':
        return value(this.degree(args, frame), 'int');
      case 'length': {
        const [a] = vals();
        if (a!.k !== 'path') return unsupported('length() of a value that is not a path');
        return value(call('list_len', [a!.hops], 'int'), 'int');
      }
      case 'nodes': {
        const [a] = vals();
        if (a!.k !== 'path') return unsupported('nodes() of a value that is not a path');
        return { k: 'nodes', ids: this.pathNodeIds(a!) };
      }
      case 'relationships': {
        const [a] = vals();
        if (a!.k !== 'path') return unsupported('relationships() of a value that is not a path');
        return { k: 'rels', hops: a!.hops };
      }
      case 'labels': {
        const [a] = vals();
        if (a!.k !== 'node') return unsupported('labels() of a value that is not a node');
        return value(this.labelsOf(a!.id), 'list<text>');
      }
      case 'properties': {
        const [a] = vals();
        if (a!.k !== 'node' && a!.k !== 'rel') return unsupported('properties() of a value that is not a node or a relationship');
        return value(a!.props, PROPS);
      }
      case 'keys':
        // A map keeps its keys sorted; smaltcy's keys() gives a node's in the order they were set.
        return unsupported('keys() (a smaltdb map keeps its keys sorted)');
      case 'size': {
        const [g] = vals();
        if (g!.k === 'rels') return value(call('list_len', [g!.hops], 'int'), 'int');
        if (g!.k === 'nodes') return value(call('list_len', [g!.ids], 'int'), 'int');
        const [a] = values() as { e: PlanExpr; t: PlanType }[];
        const k = staticKind(a!.t);
        if (k === K_STRING) return value(call('length', [a!.e], 'int'), 'int');
        if (k === K_LIST) return value(call('list_len', [a!.e], 'int'), 'int');
        if (k === K_MAP) return value(call('map_len', [a!.e], 'int'), 'int');
        if (k === K_NULL) return value(NULL, 'null');
        if (k === undefined) {
          return value(
            caseWhen(
              [
                [isNull(a!.e), NULL],
                [eq(kindExpr(a!), lit(K_STRING)), call('length', [a!.e], 'int')],
                [eq(kindExpr(a!), lit(K_LIST)), call('list_len', [call('any_list', [a!.e], 'list<any>')], 'int')],
                [eq(kindExpr(a!), lit(K_MAP)), call('map_len', [call('any_map', [a!.e], 'map<text, any>')], 'int')],
              ],
              raise('SMALTCY_TYPE', message("size() can't take a ", typeNameExpr(a!)), 'int'),
              'int',
            ),
            'int',
          );
        }
        return unsupported(`size() of a ${a!.t}`);
      }
      case 'toUpper': case 'toLower': {
        const [a] = values() as { e: PlanExpr; t: PlanType }[];
        return value(call(fn === 'toUpper' ? 'upper_unicode' : 'lower_unicode', [this.string(a!, `${fn}()`)], 'text'), 'text');
      }
      case 'coalesce': {
        const vs = values() as { e: PlanExpr; t: PlanType }[];
        const t = commonType(vs.map((v) => v.t)) ?? unsupported('coalesce() of booleans or lists and values of other types');
        return vs.length === 1 ? vs[0]! as Val : value(call('coalesce', vs.map((v) => v.e), t), t);
      }
      case 'abs': {
        const [a] = values() as { e: PlanExpr; t: PlanType }[];
        const t = isNumberType(a!.t) ? a!.t : 'any';
        return value(call('abs', [this.number(a!, 'abs()')], t), t);
      }
      case 'head': case 'last': case 'tail': case 'reverse': {
        const [a] = values() as { e: PlanExpr; t: PlanType }[];
        if (staticKind(a!.t) !== K_LIST) return unsupported(`${fn}() of a ${a!.t}`);
        const elem = a!.t.slice(5, -1) as PlanType;
        if (fn === 'head') return value(call('list_get', [a!.e, lit(0)], elem), elem);
        if (fn === 'last') return value(call('list_get', [a!.e, lit(-1)], elem), elem);
        if (fn === 'tail') return value(call('list_slice', [a!.e, lit(1)], a!.t), a!.t);
        return value(call('list_reverse', [a!.e], a!.t), a!.t);
      }
      case 'range': {
        // smaltdb's `range` table function, imploded; smaltcy's range() of a NULL is NULL, and of no integers [].
        const vs = values() as { e: PlanExpr; t: PlanType }[];
        if (vs.length < 2 || vs.length > 3) return unsupported(`range() with ${vs.length} arguments`);
        if (vs.some((v) => v.t !== 'int' && v.t !== 'null')) return unsupported('range() of values that may not be integers');
        const src: PlanOp = { op: 'source', kind: 'function', name: 'range', args: vs.map((v) => deepen(v.e)), types: ['int'] };
        const agg: PlanOp = { op: 'aggregate', input: src, keys: [], aggs: [{ fn: 'implode', args: [colRef(0, 'int')], star: false, distinct: false, collation: 'binary', type: IDS }], carry: [] };
        const list = call('coalesce', [{ k: 'subquery', mode: 'scalar', plan: agg, type: IDS, collation: 'binary' }, call('list_of', [], IDS)], IDS);
        return value(caseWhen([[or(...vs.map((v) => isNull(v.e))), NULL]], list, IDS), IDS);
      }
      case 'version':
        return this.version();
      case 'commits': case 'commit': case 'history':
        // smaltdb records a commit's id, time, author and message (smalt_commits); smaltcy's commit maps also hold
        // its counts and the graph's size, and history() each change, which smaltdb doesn't record.
        return unsupported(`${fn}(), whose commit maps hold counts and changes smaltdb doesn't record`);
      default:
        return unsupported(`the function ${fn}()`);
    }
  }

  /**
   * `version()`: the version the query reads, a smaltdb commit id (ADR 0004). `AT VERSION v` reads v; otherwise the
   * last commit recorded in `smalt_commits` (at or before `AT TIME`'s moment), 0 before the first. NULL for a graph
   * that keeps no history, as smaltcy gives it.
   */
  private version(): Val {
    if (!this.t.history) return literal(null);
    if (this.asOf && 'commit' in this.asOf) return { k: 'value', e: lit(this.asOf.commit), t: 'int' };
    let commits: PlanOp = { op: 'scan', table: COMMITS_TABLE, columns: [0, 1] };
    if (this.asOf) commits = { op: 'filter', input: commits, pred: call('cmp_le', [colRef(1, 'int'), lit(this.asOf.time)], 'bool') };
    const last: PlanOp = { op: 'aggregate', input: commits, keys: [], aggs: [{ fn: 'max', args: [colRef(0, 'int')], star: false, distinct: false, collation: 'binary', type: 'int' }], carry: [] };
    return { k: 'value', e: call('coalesce', [{ k: 'subquery', mode: 'scalar', plan: last, type: 'int', collation: 'binary' }, lit(0)], 'int'), t: 'int' };
  }

  /** A value that must be a number: anything else (but NULL) is Cypher's type error. */
  private number(v: { e: PlanExpr; t: PlanType }, what: string): PlanExpr {
    const k = staticKind(v.t);
    if (k === K_NUMBER || k === K_NULL) return v.e;
    if (k !== undefined) return unsupported(`${what} of a ${v.t}`);
    return caseWhen([[isNull(v.e), NULL], [isNumber(v), v.e]], raise('SMALTCY_TYPE', message(`${what} can't take a `, typeNameExpr(v))), 'any');
  }

  /** A value that must be a string. */
  private string(v: { e: PlanExpr; t: PlanType }, what: string): PlanExpr {
    const k = staticKind(v.t);
    if (k === K_STRING || k === K_NULL) return v.e;
    if (k !== undefined) return unsupported(`${what} of a ${v.t}`);
    return caseWhen([[isNull(v.e), NULL], [eq(kindExpr(v), lit(K_STRING)), v.e]], raise('SMALTCY_TYPE', message(`${what} can't take a `, typeNameExpr(v))), 'any');
  }

  /**
   * Arithmetic with Cypher's meaning: integers stay integers (64-bit: overflow is an error, smaltdb's checked
   * operations), division of two integers truncates and by zero is an error, `%` of floats is JavaScript's; `+` joins
   * two strings, a string and a number or a boolean (as `String()` writes them), and lists (a list and a value: the
   * value appended or prepended).
   */
  private arithmetic(fn: string, [a, b]: { e: PlanExpr; t: PlanType }[]): Val {
    const ka = staticKind(a!.t);
    const kb = staticKind(b!.t);
    const known = ka !== undefined && kb !== undefined;
    const value = (v: { e: PlanExpr; t: PlanType }): Val => ({ k: 'value', e: bindVars(v.e), t: v.t });
    const numOrBool = (k: number | undefined) => k === K_NUMBER || k === K_BOOL;
    if (fn === 'add' && known && (ka === K_LIST || kb === K_LIST)) return value(addLists(a!, b!));
    if ((ka === K_NULL || kb === K_NULL) && !(fn === 'add' && (may(a!, K_LIST) || may(b!, K_LIST)))) return { k: 'value', e: NULL, t: 'null' };
    if (fn === 'add' && ka === K_STRING && kb === K_STRING) return { k: 'value', e: call('text_concat', [a!.e, b!.e], 'text'), t: 'text' };
    if (fn === 'add' && ((ka === K_STRING && numOrBool(kb)) || (numOrBool(ka) && kb === K_STRING))) {
      return value({ e: call('text_concat', [ka === K_STRING ? a!.e : valueText(a!), kb === K_STRING ? b!.e : valueText(b!)], 'text'), t: 'text' });
    }
    if (known && (ka !== K_NUMBER || kb !== K_NUMBER)) return unsupported(`${fn} of a ${a!.t} and a ${b!.t}`);
    const t: PlanType = known ? (a!.t === b!.t ? a!.t : 'num') : 'any';
    const numeric = (x: PlanExpr, y: PlanExpr): PlanExpr => {
      const bothInt = (p: PlanExpr, q: PlanExpr): PlanExpr =>
        known ? (a!.t === 'int' && b!.t === 'int' ? TRUE : a!.t === 'real' || b!.t === 'real' ? FALSE : intTest(p, q)) : intTest(p, q);
      const intTest = (p: PlanExpr, q: PlanExpr) => and(eq(call('any_type', [p], 'text'), lit('int')), eq(call('any_type', [q], 'text'), lit('int')));
      const zeroCheck = (op: string): PlanExpr =>
        caseWhen([[and(bothInt(x, y), eq(y, lit(0))), raise('SMALTCY_TYPE', 'Division by zero', 'int')], [bothInt(x, y), call(op, [x, y], 'int')]], call('div_float', [x, y], 'real'), t === 'int' ? 'int' : t);
      switch (fn) {
        case 'add': return call('add_checked', [x, y], t);
        case 'sub': return call('sub_checked', [x, y], t);
        case 'mul': return call('mul_checked', [x, y], t);
        case 'div_float': return call('div_float', [x, y], 'real');
        case 'div': return zeroCheck('div_trunc');
        // Two integers: smaltdb's remainder (64-bit). Otherwise JavaScript's, which smaltcy's numbers take.
        default: return known && a!.t === 'int' && b!.t === 'int' ? zeroCheck('mod_trunc') : floatModulo(x, y, t);
      }
    };
    const rt: PlanType = fn === 'div_float' ? 'real' : t;
    if (known) return { k: 'value', e: numeric(a!.e, b!.e), t: rt };
    // Known only at run time: numbers, for + strings and lists too; NULL gives NULL.
    const kindA = ka !== undefined ? lit(ka) : kindExpr(a!);
    const kindB = kb !== undefined ? lit(kb) : kindExpr(b!);
    const whens: [PlanExpr, PlanExpr][] = [];
    if (fn === 'add') {
      // smaltcy's add: a list first (two lists joined, a value appended), then a value prepended to a list; NULL is
      // a value there.
      const list = lit(K_LIST);
      if (may(a!, K_LIST)) {
        const la = asList(a!);
        const joined = !may(b!, K_LIST) ? concatLists(la, listOfOne(b!)) : oneListType([[eq(kindB, list), concatLists(la, asList(b!))]], concatLists(la, listOfOne(b!)));
        whens.push([eq(kindA, list), asAny(joined)]);
      }
      if (may(b!, K_LIST)) whens.push([eq(kindB, list), asAny(concatLists(listOfOne(a!), asList(b!)))]);
    }
    whens.push([or(isNull(a!.e), isNull(b!.e)), NULL]);
    if (may(a!, K_NUMBER) && may(b!, K_NUMBER)) whens.push([and(eq(kindA, lit(K_NUMBER)), eq(kindB, lit(K_NUMBER))), numeric(a!.e, b!.e)]);
    if (fn === 'add') {
      const string = lit(K_STRING);
      const nb = (k: PlanExpr) => call('in_list', [k, lit(K_NUMBER), lit(K_BOOL)], 'bool');
      if (may(a!, K_STRING) && may(b!, K_STRING)) whens.push([and(eq(kindA, string), eq(kindB, string)), call('text_concat', [a!.e, b!.e], 'text')]);
      if (may(a!, K_STRING) && (may(b!, K_NUMBER) || may(b!, K_BOOL))) whens.push([and(eq(kindA, string), nb(kindB)), call('text_concat', [a!.e, valueText(b!)], 'text')]);
      if ((may(a!, K_NUMBER) || may(a!, K_BOOL)) && may(b!, K_STRING)) whens.push([and(nb(kindA), eq(kindB, string)), call('text_concat', [valueText(a!), b!.e], 'text')]);
    }
    // smaltcy's type error for the rest, as its engine words it.
    const verb = ({ add: 'add', sub: 'subtract', mul: 'multiply', div: 'divide', div_float: 'divide', mod: 'take the modulo of' } as Record<string, string>)[fn]!;
    return value({ e: caseWhen(whens, raise('SMALTCY_TYPE', message(`Can't ${verb} `, typeNameExpr(a!), ' and ', typeNameExpr(b!))), 'any'), t: 'any' });
  }
}
