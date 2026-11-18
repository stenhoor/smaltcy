/**
 * Cypher statements that write, run on smaltdb (ADR 0004; smaltdb ADR 0033, step 8). A query that only reads is one
 * smaltdb query (`compileQuery`); a statement that writes is run here, row by row, the way smaltcy's engine runs it:
 *
 * - **Rows stream.** Each row goes through the writes and the operations between them (`project`, `filter`,
 *   `unwind`, `match`) before the next row starts, so a write sees what earlier rows wrote, as in smaltcy's engine.
 *   The rows are held here, as the compiler's columns; each operation on a row is a smaltdb query over that row (a
 *   `values` plan), and each write one or more smaltdb write statements (`append`, `update`, `delete`).
 * - **Reading before writing.** Where the plan reads everything first (`eager`, `sort`, `aggregate`), or what it reads
 *   doesn't depend on the graph (no MATCH, EXISTS or pattern comprehension), its rows are one query.
 * - **Entities are read live.** A row holds a node's id and a relationship's type and rowid; every query over a row
 *   reads their properties from their tables again, so `SET n.x = 1 RETURN n.x` reads 1. Values computed before a
 *   write keep what they were. Nodes, relationships and paths in the results are read once the statement is done, as
 *   smaltcy's engine reads them.
 * - **One transaction.** The statement runs in a savepoint (inside the caller's transaction, if there is one): an
 *   error rolls back everything it wrote, the new labels and types included.
 * - **New labels and types** are added to the graph (`alterPropertyGraph` `addLabel` / `addType`) when a write first
 *   uses them. The reserved label `smaltcy:node` is refused, as are labels and types that differ from the graph's
 *   only in case (smaltdb finds them ignoring case).
 * - **New ids** are chosen here: a node's is one more than the largest node id, a relationship's rowid one more than
 *   the largest rowid of any edge table, so a relationship's rowid stays unique across types (its id).
 *
 * What it can't run as smaltcy's engine does it refuses with `Unsupported`: before anything runs where the plan shows
 * it, else when a row shows it (a DELETE of a list value), and the savepoint undoes what earlier rows wrote. After a
 * DELETE, the functions smaltcy's engine fails on for a deleted node or relationship (`labels()`, `type()` …) are
 * refused, where smaltdb would give a value.
 */
import type { plan, PlanStatementInput } from 'smaltdb/engine';
import { SmaltcyError } from '../errors.js';
import type { Expr } from '../plan/expr.js';
import type { GraphPlan, Op, Pattern, RemoveItem, SetItem } from '../plan/ops.js';
import type { GraphTables } from './schema.js';
import { NODE_LABEL } from './schema.js';
import {
  and, call, caseWhen, colRef, Compiler, compileQuery, eq, HOPS, IDS, isNull, lit, NULL, or, paramValues, PROPS, Unsupported,
  type Binding, type Frame, type Rel, type Val,
} from './compile.js';

type PlanOp = plan.PlanOp;
type PlanExpr = plan.PlanExpr;
type PlanType = plan.PlanType;

/** What a statement wrote, as smaltcy's engine counts it. */
export interface WriteCounts {
  nodesCreated: number;
  nodesDeleted: number;
  relationshipsCreated: number;
  relationshipsDeleted: number;
  propertiesSet: number;
  labelsAdded: number;
  labelsRemoved: number;
}

const emptyCounts = (): WriteCounts => ({ nodesCreated: 0, nodesDeleted: 0, relationshipsCreated: 0, relationshipsDeleted: 0, propertiesSet: 0, labelsAdded: 0, labelsRemoved: 0 });

/** What the runner needs of a smaltdb database: `Database.queryPlan` of `smaltdb/engine` (synchronous). */
export interface SmaltdbDatabase {
  queryPlan(stmt: PlanStatementInput, params?: readonly unknown[]): { readonly rows: readonly (readonly unknown[])[] };
}

export interface RunResult {
  readonly columns: readonly string[];
  /** Rows as smaltcy's engine gives them: nodes, relationships and paths as maps of their data. */
  readonly rows: readonly (readonly unknown[])[];
  readonly counts: WriteCounts;
  /** The graph's tables after the statement: with the labels and types it added. */
  readonly tables: GraphTables;
}

export interface RunOptions {
  readonly params?: Readonly<Record<string, unknown>>;
}

const refuse = (feature: string): never => {
  throw new Unsupported(feature);
};

const WRITES = new Set(['create', 'merge', 'set', 'remove', 'delete']);
const SAVEPOINT = 'smaltcy_write';

/** Whether a plan writes (its operations, not the nested plans of its expressions, which only read). */
export function writes(op: Op): boolean {
  if (WRITES.has(op.op)) return true;
  if (op.op === 'argument') return false;
  if (op.op === 'union') return op.inputs.some(writes);
  return writes(op.input);
}

/**
 * Runs a Cypher statement's graph plan on smaltdb, on the graph whose tables are `tables`: a query that only reads as
 * one query, a statement that writes row by row in a savepoint. Returns its rows and what it wrote, and the tables as
 * they are after it (with the labels and types it added; the caller's `tables` are left as they were).
 */
export function runOnSmaltdb(db: SmaltdbDatabase, gp: GraphPlan, tables: GraphTables, options: RunOptions = {}): RunResult {
  const params = options.params ?? {};
  if (gp.kind !== 'query' || !writes(gp.root)) {
    const q = compileQuery(gp, tables, { params });
    const r = db.queryPlan(q.statement, paramValues(q, params));
    return { columns: q.columns, rows: r.rows, counts: emptyCounts(), tables };
  }
  if (gp.asOf) throw new Unsupported('AT VERSION and AT TIME');
  const run = new Runner(db, tables, params);
  db.queryPlan({ kind: 'transaction', action: 'savepoint', name: SAVEPOINT } as PlanStatementInput);
  try {
    const out = run.statement(gp);
    db.queryPlan({ kind: 'transaction', action: 'release', name: SAVEPOINT } as PlanStatementInput);
    return { ...out, counts: run.counts, tables: run.tables() };
  } catch (e) {
    db.queryPlan({ kind: 'transaction', action: 'rollback', savepoint: SAVEPOINT } as PlanStatementInput);
    db.queryPlan({ kind: 'transaction', action: 'release', name: SAVEPOINT } as PlanStatementInput);
    throw e;
  }
}

// The rows the runner holds: the compiler's columns (`Frame`), as JavaScript values.

type Row = unknown[];

interface Stream {
  readonly frame: Frame;
  /** Pushes each row to `sink` in order; `sink` returns false to stop (as smaltcy's LIMIT stops what feeds it). */
  readonly run: (sink: (row: Row) => boolean) => boolean;
}

/** A hop of a path or a variable-length relationship: `HOP`'s fields. */
interface Hop {
  readonly edge: number;
  readonly rowid: number;
  readonly from: number;
  readonly to: number;
}

type Props = Record<string, unknown>;

/** An expression's value for one row, as JavaScript: a value, or a node, relationship or path by identity. */
type Value =
  | { readonly k: 'value'; readonly v: unknown }
  /** `props` is NULL when the node is gone (deleted by an earlier write). */
  | { readonly k: 'node'; readonly id: number | null; readonly props: Props | null }
  | { readonly k: 'rel'; readonly type: string | null; readonly rowid: number | null; readonly props: Props | null }
  | { readonly k: 'rels'; readonly hops: readonly Hop[] | null }
  | { readonly k: 'path'; readonly start: number | null; readonly hops: readonly Hop[] | null }
  | { readonly k: 'nodes'; readonly ids: readonly (number | null)[] | null };

/** smaltcy's names for kinds of values, in its error messages. */
function typeName(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return 'BOOLEAN';
  if (typeof v === 'number') return Number.isInteger(v) ? 'INTEGER' : 'FLOAT';
  if (typeof v === 'string') return 'STRING';
  if (Array.isArray(v)) return 'LIST';
  return 'MAP';
}

/** Whether a value is NULL: no value, node, relationship or path. */
function isNullValue(v: Value): boolean {
  switch (v.k) {
    case 'value': return v.v === null;
    case 'node': return v.id === null;
    case 'rel': return v.rowid === null;
    case 'rels': return v.hops === null;
    case 'path': return v.hops === null;
    case 'nodes': return v.ids === null;
  }
}

const valueTypeName = (v: Value): string =>
  v.k === 'value' ? typeName(v.v) : ({ node: 'NODE', rel: 'RELATIONSHIP', rels: 'LIST', path: 'PATH', nodes: 'LIST' })[v.k];

/** A value a store can hold, as smaltcy's `toPropertyValue` checks it: no maps, and lists of plain values only. */
function propertyValue(v: Value, what: string): unknown {
  if (v.k !== 'value') throw new SmaltcyError('SMALTCY_TYPE', `${what}: a property can't be a ${valueTypeName(v)}`);
  const x = v.v;
  if (x === null || typeof x !== 'object') return x;
  if (Array.isArray(x)) {
    for (const e of x) if (e !== null && typeof e === 'object') throw new SmaltcyError('SMALTCY_TYPE', `${what}: a property list holds only strings, numbers and booleans`);
    return x;
  }
  throw new SmaltcyError('SMALTCY_TYPE', `${what}: a property can't be a MAP`);
}

const write = (p: PlanOp): PlanStatementInput => ({ kind: 'write', plan: p }) as PlanStatementInput;
const scan = (table: string, columns: readonly number[]): PlanOp => ({ op: 'scan', table, columns });
const filter = (input: PlanOp, pred: PlanExpr): PlanOp => ({ op: 'filter', input, pred });
const project = (input: PlanOp, exprs: readonly PlanExpr[]): PlanOp => ({ op: 'project', input, exprs });
const EMPTY: PlanExpr = call('map_of', [], PROPS);
const isNotNull = (arg: PlanExpr): PlanExpr => ({ k: 'isNull', arg, not: true });
const ONE_ROW: PlanOp = { op: 'values', rows: [[]], types: [] };
const scalar = (p: PlanOp, type: PlanType): PlanExpr => ({ k: 'subquery', mode: 'scalar', plan: p, type, collation: 'binary' });
const exists = (p: PlanOp): PlanExpr => ({ k: 'subquery', mode: 'exists', plan: p, type: 'bool', collation: 'binary' });
const maxOf = (p: PlanOp): PlanOp => ({ op: 'aggregate', input: p, keys: [], aggs: [{ fn: 'max', args: [colRef(0, 'int')], star: false, distinct: false, collation: 'binary', type: 'int' }], carry: [] });

/** Whether a plan reads the graph: a MATCH, or an EXISTS or pattern comprehension (a nested plan) in an expression. */
function readsGraph(x: unknown): boolean {
  if (Array.isArray(x)) return x.some(readsGraph);
  if (x === null || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  if (o.op === 'match' || o.k === 'exists' || o.k === 'collectSub') return true;
  return Object.values(o).some(readsGraph);
}

/** Whether a plan deletes (its operations). */
function deletes(op: Op): boolean {
  if (op.op === 'delete') return true;
  if (op.op === 'argument') return false;
  if (op.op === 'union') return op.inputs.some(deletes);
  return deletes(op.input);
}

/**
 * What smaltcy's engine fails on for a node or relationship deleted earlier in the statement ("Node 4 does not
 * exist"), where smaltdb would give a value: refused after a DELETE, whatever they are given.
 */
const READS_DELETED = new Set(['labels', 'properties', 'type', 'startNode', 'endNode', 'nodes', 'relationships', 'keys']);
const AFTER_DELETE_FEATURE = 'labels(), properties(), type(), startNode(), endNode(), nodes() and relationships() after a DELETE, and paths and lists of nodes or relationships in its results';

/** Whether an operation's own expressions (not its input's) call one of `READS_DELETED`. */
function readsDeleted(op: Op): boolean {
  const walk = (x: unknown): boolean => {
    if (Array.isArray(x)) return x.some(walk);
    if (x === null || typeof x !== 'object') return false;
    const o = x as Record<string, unknown>;
    if (o.k === 'call' && READS_DELETED.has(o.fn as string)) return true;
    return Object.values(o).some(walk);
  };
  return Object.entries(op).some(([k, v]) => k !== 'input' && k !== 'inputs' && walk(v));
}

class Runner {
  readonly counts = emptyCounts();
  private readonly labelTables: Map<string, string>;
  private readonly types: Map<string, string>;
  private nextNode: number | undefined;
  private nextRel: number | undefined;

  constructor(
    private readonly db: SmaltdbDatabase,
    private readonly t0: GraphTables,
    private readonly params: Readonly<Record<string, unknown>>,
  ) {
    this.labelTables = new Map(t0.labelTables);
    this.types = new Map(t0.types);
  }

  /** The graph's tables as they are now (the compiler reads the maps, which grow as labels and types are added). */
  tables(): GraphTables {
    return { ...this.t0, labelTables: this.labelTables, types: this.types };
  }

  private compiler(): Compiler {
    return new Compiler(this.tables(), this.params);
  }

  private exec(c: Compiler, stmt: PlanStatementInput): unknown[][] {
    const r = this.db.queryPlan(stmt, paramValues({ statement: stmt, columns: [], params: c.paramNames }, this.params));
    return r.rows.map((row) => [...row]);
  }

  /** A plan's rows: the frame's columns. */
  private rowsOf(c: Compiler, r: Rel): Row[] {
    return this.exec(c, { kind: 'query', plan: r.plan, columns: r.frame.types.map((type, i) => ({ name: `c${i}`, type })) });
  }

  /** A query with no parameters, for the runner's own lookups. */
  private lookup(p: PlanOp, types: readonly PlanType[]): unknown[][] {
    return this.exec(this.compiler(), { kind: 'query', plan: p, columns: types.map((type, i) => ({ name: `c${i}`, type })) });
  }

  // The statement.

  statement(gp: Extract<GraphPlan, { kind: 'query' }>): { columns: readonly string[]; rows: unknown[][] } {
    const s = this.stream(gp.root, false);
    for (const col of gp.columns) {
      // smaltcy's engine gives a deleted node or relationship in a path or list as an empty one; smaltdb's lists drop it.
      const k = s.frame.slots.get(col.slot)?.k;
      if ((k === 'path' || k === 'rels' || k === 'nodes') && deletes(gp.root)) refuse(AFTER_DELETE_FEATURE);
    }
    const rows: Row[] = [];
    s.run((row) => (rows.push(row), true));
    // The results, read now: nodes, relationships and paths as they are at the end of the statement.
    const c = this.compiler();
    const leaf = this.leaf(s.frame, rows, true);
    const exprs: PlanExpr[] = [];
    const columns: { name: string; type: PlanType }[] = [];
    for (const col of gp.columns) {
      const b = leaf.frame.slots.get(col.slot) ?? refuse(`a result column (${col.name}) that isn't bound`);
      const v = c.valueOf(b);
      const r = v.k === 'value' ? { e: v.e, t: v.t } : c.resultValue(v);
      exprs.push(r.e);
      columns.push({ name: col.name, type: r.t });
    }
    const out = gp.columns.length ? this.exec(c, { kind: 'query', plan: project(leaf.plan, exprs), columns }) : rows.map(() => []);
    return { columns: gp.columns.map((col) => col.name), rows: out };
  }

  /**
   * An operation's rows, streamed. `above`: whether an operation above this one, before anything that reads all its
   * input first, writes (so the order rows reach it in matters).
   */
  private stream(op: Op, above: boolean): Stream {
    if (!writes(op) && (op.op === 'eager' || !readsGraph(op))) return this.query(op);
    if (op.op !== 'delete' && op.op !== 'argument' && deletes(op) && readsDeleted(op)) refuse(AFTER_DELETE_FEATURE);
    const inputAbove = WRITES.has(op.op) || (above && op.op !== 'eager' && op.op !== 'sort' && op.op !== 'aggregate');
    switch (op.op) {
      case 'argument':
        if (op.slots.length) return refuse('a nested plan with writes');
        return { frame: { types: [], slots: new Map() }, run: (sink) => sink([]) };
      case 'filter': case 'project': case 'unwind': case 'match':
        return this.perRow(op, this.stream(op.input, inputAbove));
      case 'eager': case 'sort': case 'aggregate':
        return this.allRows(op, this.stream(op.input, inputAbove));
      case 'distinct':
        // smaltcy's DISTINCT passes each row on as it comes: with writes on both sides, the order they run in matters.
        if (above) return refuse('DISTINCT between writes');
        return this.allRows(op, this.stream(op.input, inputAbove));
      case 'limit':
        return this.limit(op, this.stream(op.input, inputAbove));
      case 'union':
        return refuse('UNION with writes');
      case 'create':
        return this.create(op, this.stream(op.input, inputAbove));
      case 'merge':
        return this.merge(op, this.stream(op.input, inputAbove));
      case 'set': {
        const input = this.stream(op.input, inputAbove);
        return { frame: input.frame, run: (sink) => input.run((row) => (this.setItems(op.items, input.frame, row), sink(row))) };
      }
      case 'remove': {
        const input = this.stream(op.input, inputAbove);
        return { frame: input.frame, run: (sink) => input.run((row) => (this.removeItems(op.items, input.frame, row), sink(row))) };
      }
      case 'delete': {
        const input = this.stream(op.input, inputAbove);
        return {
          frame: input.frame,
          run: (sink) =>
            input.run((row) => {
              for (const t of op.targets) this.deleteValue(this.evaluate(input.frame, row, t), op.detach);
              return sink(row);
            }),
        };
      }
    }
  }

  /** A plan that writes nothing and reads what writes don't change: one query, run when its rows are wanted. */
  private query(op: Op): Stream {
    const c = this.compiler();
    const r = c.op(op);
    return {
      frame: r.frame,
      run: (sink) => {
        for (const row of this.rowsOf(c, r)) if (!sink(row)) return false;
        return true;
      },
    };
  }

  /** `op` over the rows given, as one query. */
  private over(op: Op & { input: Op }, frame: Frame, rows: readonly Row[]): { c: Compiler; r: Rel } {
    const c = this.compiler();
    c.given.set(op.input, this.leaf(frame, rows));
    return { c, r: c.op(op) };
  }

  /** An operation that passes rows on as they come: run on each row, its rows passed on before the next row's. */
  private perRow(op: Op & { input: Op }, input: Stream): Stream {
    const { frame } = this.over(op, input.frame, []).r;
    return {
      frame,
      run: (sink) =>
        input.run((row) => {
          const { c, r } = this.over(op, input.frame, [row]);
          for (const out of this.rowsOf(c, r)) if (!sink(out)) return false;
          return true;
        }),
    };
  }

  /** An operation that reads all its input first (EAGER, ORDER BY, aggregates): all of it, then one query. */
  private allRows(op: Op & { input: Op }, input: Stream): Stream {
    const { frame } = this.over(op, input.frame, []).r;
    return {
      frame,
      run: (sink) => {
        const rows: Row[] = [];
        input.run((row) => (rows.push(row), true));
        const { c, r } = this.over(op, input.frame, rows);
        for (const out of this.rowsOf(c, r)) if (!sink(out)) return false;
        return true;
      },
    };
  }

  /** SKIP and LIMIT as smaltcy's engine runs them: once LIMIT has its rows, what feeds it stops (and writes no more). */
  private limit(op: Extract<Op, { op: 'limit' }>, input: Stream): Stream {
    const intOf = (x: Expr | undefined, what: string, none: number): number => {
      if (!x) return none;
      const v = x.k === 'lit' ? x.v : x.k === 'param' ? this.params[x.name] : refuse(`${what} that isn't a literal or a parameter`);
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new SmaltcyError('SMALTCY_TYPE', `${what} must be a non-negative integer`);
      return v;
    };
    return {
      frame: input.frame,
      run: (sink) => {
        const skip = intOf(op.skip, 'SKIP', 0);
        const count = intOf(op.count, 'LIMIT', Infinity);
        if (count === 0) return true;
        let seen = 0;
        let stopped = false;
        input.run((row) => {
          if (seen++ < skip) return true;
          if (!sink(row)) return ((stopped = true), false);
          return seen - skip < count;
        });
        return !stopped;
      },
    };
  }

  // Rows as plans.

  /**
   * Rows the runner holds as a plan: a `values` plan of their columns (a column of `any` as a one-element `list<any>`,
   * which keeps booleans, lists and maps typed), with each node's and relationship's properties read from its table.
   */
  private leaf(frame: Frame, rows: readonly Row[], results = false): Rel {
    const n = frame.types.length;
    if (n === 0) return { plan: { op: 'values', rows: rows.map(() => []), types: [] }, frame };
    const types = frame.types.map((t) => (t === 'any' ? 'list<any>' : t));
    const columns = frame.types.map((t, i) => rows.map((r) => (t === 'any' ? [r[i] ?? null] : (r[i] ?? null))));
    const values = { op: 'values', rows: [], types, columns } as unknown as PlanOp;
    const exprs = frame.types.map((t, i) => (t === 'any' ? call('list_get', [colRef(i, 'list<any>'), lit(0)], 'any') : colRef(i, t)));
    for (const b of frame.slots.values()) {
      if (b.k === 'node') {
        const props = this.nodeProps(colRef(b.id, 'int'));
        // In results, a node deleted by the statement has no properties, as smaltcy's engine gives it.
        exprs[b.props] = results ? caseWhen([[isNull(colRef(b.id, 'int')), NULL]], call('coalesce', [props, EMPTY], PROPS), PROPS) : props;
      } else if (b.k === 'rel') {
        const props = this.relProps(colRef(b.type, 'text'), colRef(b.rowid, 'int'));
        exprs[b.props] = props;
        if (results) {
          // A relationship deleted by the statement: no type, ends or properties, as smaltcy's engine gives it.
          const gone = and(isNotNull(colRef(b.rowid, 'int')), isNull(props));
          exprs[b.type] = caseWhen([[gone, lit('', 'text')]], colRef(b.type, 'text'), 'text');
          exprs[b.start] = caseWhen([[gone, lit(-1)]], colRef(b.start, 'int'), 'int');
          exprs[b.end] = caseWhen([[gone, lit(-1)]], colRef(b.end, 'int'), 'int');
          exprs[b.props] = caseWhen([[gone, EMPTY]], props, PROPS);
        }
      }
    }
    return { plan: project(values, exprs), frame };
  }

  /** A node's properties, read from the node table (NULL when it's gone). */
  private nodeProps(id: PlanExpr): PlanExpr {
    const outer = { ...(id as Extract<PlanExpr, { k: 'col' }>), depth: 1 };
    return scalar(project(filter(scan(this.tables().nodes, [0, 1]), eq(colRef(0, 'int'), outer)), [colRef(1, PROPS)]), PROPS);
  }

  /** A relationship's properties, read from its type's edge table (NULL when it's gone). */
  private relProps(type: PlanExpr, rowid: PlanExpr): PlanExpr {
    const outer = { ...(rowid as Extract<PlanExpr, { k: 'col' }>), depth: 1 };
    const whens = [...this.types].map(([name, table]) => [eq(type, lit(name, 'text')), scalar(project(filter(scan(table, [-1, 2]), eq(colRef(0, 'int'), outer)), [colRef(1, PROPS)]), PROPS)] as const);
    return whens.length ? caseWhen(whens, NULL, PROPS) : NULL;
  }

  // Expressions.

  /** An expression's value for one row. */
  private evaluate(frame: Frame, row: Row, x: Expr): Value {
    if (x.k === 'lit') return { k: 'value', v: x.v };
    if (x.k === 'param') {
      if (!(x.name in this.params)) throw new SmaltcyError('SMALTCY_PARAM', `Missing parameter $${x.name}`);
      return { k: 'value', v: this.params[x.name] ?? null };
    }
    const c = this.compiler();
    const leaf = this.leaf(frame, [row]);
    const v = c.expr(x, leaf.frame);
    const [exprs, types] = columnsOf(v);
    const out = this.exec(c, { kind: 'query', plan: project(leaf.plan, exprs), columns: types.map((type, i) => ({ name: `c${i}`, type })) })[0]!;
    return decode(v, out);
  }

  /** A property map's entries (a map literal's evaluated together, a parameter's or a node's as they are), NULLs dropped. */
  private propertyMap(frame: Frame, row: Row, x: Expr, what: string): { props: Props; nulls: string[]; isMap: boolean } {
    let raw: Record<string, Value>;
    let isMap = true;
    if (x.k === 'map') {
      const c = this.compiler();
      const leaf = this.leaf(frame, [row]);
      const vals = x.entries.map(([, e]) => c.expr(e, leaf.frame));
      const cols = vals.map(columnsOf);
      const out = vals.length ? this.exec(c, { kind: 'query', plan: project(leaf.plan, cols.flatMap(([e]) => e)), columns: cols.flatMap(([, t]) => t).map((type, i) => ({ name: `c${i}`, type })) })[0]! : [];
      raw = {};
      let at = 0;
      x.entries.forEach(([k], i) => {
        const n = cols[i]![1].length;
        raw[k] = decode(vals[i]!, out.slice(at, at + n));
        at += n;
      });
    } else {
      const v = this.evaluate(frame, row, x);
      if (v.k === 'node' || v.k === 'rel') {
        isMap = false;
        raw = Object.fromEntries(Object.entries(v.props ?? {}).map(([k, p]) => [k, { k: 'value', v: p }]));
      } else if (v.k === 'value' && v.v === null) {
        raw = {};
      } else if (v.k === 'value' && typeof v.v === 'object' && !Array.isArray(v.v)) {
        raw = Object.fromEntries(Object.entries(v.v as Props).map(([k, p]) => [k, { k: 'value', v: p ?? null }]));
      } else {
        throw new SmaltcyError('SMALTCY_TYPE', `${what}: properties must be a map, not ${valueTypeName(v)}`);
      }
    }
    const props: Props = {};
    const nulls: string[] = [];
    for (const [k, v] of Object.entries(raw)) {
      if (v.k === 'value' && v.v === null) nulls.push(k);
      else props[k] = propertyValue(v, what);
    }
    return { props, nulls, isMap };
  }

  private typeNames(): string[] {
    return [...this.types.keys()];
  }

  // CREATE and MERGE.

  private create(op: Extract<Op, { op: 'create' }>, input: Stream): Stream {
    const types = [...input.frame.types];
    const slots = new Map(input.frame.slots);
    for (const n of op.pattern.nodes) {
      if (slots.has(n.slot)) continue;
      slots.set(n.slot, { k: 'node', id: types.length, props: types.length + 1 });
      types.push('int', PROPS);
    }
    for (const r of op.pattern.rels) {
      const at = types.length;
      slots.set(r.slot, { k: 'rel', type: at, rowid: at + 1, start: at + 2, end: at + 3, props: at + 4 });
      types.push('text', 'int', 'int', 'int', PROPS);
    }
    for (const p of op.pattern.paths ?? []) {
      const first = slots.get(op.pattern.nodes[p.nodes[0]!]!.slot) as Extract<Binding, { k: 'node' }>;
      slots.set(p.slot, { k: 'path', start: first.id, hops: types.length });
      types.push(HOPS);
    }
    const frame: Frame = { types, slots };
    return { frame, run: (sink) => input.run((row) => sink(this.createRow(op.pattern, input.frame, frame, row))) };
  }

  /**
   * MERGE, as smaltcy's engine runs it: for each row, every match of the whole pattern (each through ON MATCH, then
   * passed on), or, when there is none, the pattern created (its unbound nodes and its relationships), through ON
   * CREATE. A row sees what earlier rows created.
   */
  private merge(op: Extract<Op, { op: 'merge' }>, input: Stream): Stream {
    const match: Extract<Op, { op: 'match' }> = { op: 'match', input: op.input, pattern: op.pattern, optional: false };
    const { frame } = this.over(match, input.frame, []).r;
    return {
      frame,
      run: (sink) =>
        input.run((row) => {
          const { c, r } = this.over(match, input.frame, [row]);
          const found = this.rowsOf(c, r);
          if (found.length) {
            for (const f of found) {
              this.setItems(op.onMatch, frame, f);
              if (!sink(f)) return false;
            }
            return true;
          }
          const created = this.createRow(op.pattern, input.frame, frame, row);
          this.setItems(op.onCreate, frame, created);
          return sink(created);
        }),
    };
  }

  /**
   * Creates a pattern's unbound nodes, then its relationships, for one row (as smaltcy's engine's `creator`): the row
   * in `out`'s columns, with the new nodes, relationships and paths.
   */
  private createRow(p: Pattern, inFrame: Frame, out: Frame, row: Row): Row {
    const next: Row = new Array(out.types.length).fill(null);
    for (let i = 0; i < inFrame.types.length; i++) next[i] = row[i];
    const nodeOf = (slot: number) => out.slots.get(slot) as Extract<Binding, { k: 'node' }>;
    const done = new Set<number>();
    for (const n of p.nodes) {
      const bound = inFrame.slots.get(n.slot);
      if (bound) {
        if (bound.k !== 'node') refuse('CREATE with a node held in a value');
        if (next[(bound as Extract<Binding, { k: 'node' }>).id] === null) throw new SmaltcyError('SMALTCY_TYPE', "Can't create a relationship to NULL");
        continue;
      }
      if (done.has(n.slot)) continue;
      done.add(n.slot);
      for (const l of n.labels) this.label(l);
      // The properties read the row as it is now: the nodes created before this one are in it.
      const props = n.props ? this.propertyMap(out, next, n.props, 'CREATE').props : {};
      const id = this.newNodeId();
      this.db.queryPlan(this.append(this.tables().nodes, ['int', PROPS], [[id], [props]], [0, 1]));
      const labels = [...new Set(n.labels)];
      if (labels.length) this.db.queryPlan(this.append(this.tables().labels, ['int', 'text'], [labels.map(() => id), labels], [0, 1]));
      const b = nodeOf(n.slot);
      next[b.id] = id;
      next[b.props] = props;
      this.counts.nodesCreated++;
      this.counts.labelsAdded += n.labels.length;
      this.counts.propertiesSet += Object.keys(props).length;
    }
    const hops = new Map<number, Hop>();
    for (const r of p.rels) {
      if (r.types.length !== 1) throw new SmaltcyError('SMALTCY_SEMANTIC', 'A relationship to create needs exactly one type');
      if (r.dir === 'both') throw new SmaltcyError('SMALTCY_SEMANTIC', 'A relationship to create needs a direction');
      if (r.min !== undefined) throw new SmaltcyError('SMALTCY_SEMANTIC', "Can't create a variable-length relationship");
      const type = r.types[0]!;
      const table = this.type(type);
      const a = next[nodeOf(p.nodes[r.from]!.slot).id] as number;
      const z = next[nodeOf(p.nodes[r.to]!.slot).id] as number;
      const [start, end] = r.dir === 'out' ? [a, z] : [z, a];
      const props = r.props ? this.propertyMap(out, next, r.props, 'CREATE').props : {};
      const rowid = this.newRelId();
      this.db.queryPlan(this.append(table, ['int', 'int', 'int', PROPS], [[rowid], [start], [end], [props]], [-1, 0, 1, 2]));
      const b = out.slots.get(r.slot) as Extract<Binding, { k: 'rel' }>;
      next[b.type] = type;
      next[b.rowid] = rowid;
      next[b.start] = start;
      next[b.end] = end;
      next[b.props] = props;
      hops.set(r.slot, { edge: this.typeNames().indexOf(type), rowid, from: a, to: z });
      this.counts.relationshipsCreated++;
      this.counts.propertiesSet += Object.keys(props).length;
    }
    for (const path of p.paths ?? []) {
      const b = out.slots.get(path.slot) as Extract<Binding, { k: 'path' }>;
      next[b.hops] = path.rels.map((i) => hops.get(p.rels[i]!.slot)!);
    }
    return next;
  }

  private append(table: string, types: readonly PlanType[], columns: readonly (readonly unknown[])[], into: readonly number[]): PlanStatementInput {
    const input = { op: 'values', rows: [], types, columns } as unknown as PlanOp;
    return write({ op: 'append', table, db: 'main', input, columns: into, upserts: [] });
  }

  private newNodeId(): number {
    if (this.nextNode === undefined) {
      const max = this.lookup(maxOf(scan(this.tables().nodes, [0])), ['int'])[0]![0] as number | null;
      this.nextNode = max === null ? 0 : max + 1;
    }
    return this.nextNode++;
  }

  private newRelId(): number {
    if (this.nextRel === undefined) {
      let max = -1;
      for (const table of this.types.values()) {
        const m = this.lookup(maxOf(scan(table, [-1])), ['int'])[0]![0] as number | null;
        if (m !== null && m > max) max = m;
      }
      this.nextRel = max + 1;
    }
    return this.nextRel++;
  }

  /** A label's table: the label added to the graph if it hasn't it yet. */
  private label(l: string): string {
    const known = this.labelTables.get(l);
    if (known) return known;
    if (l.toLowerCase() === NODE_LABEL) return refuse(`the label ${NODE_LABEL}, which is reserved`);
    this.sameButCase(l, this.labelTables, 'label');
    const table = `${this.t0.graph}_l${this.labelTables.size}`;
    this.db.queryPlan({ kind: 'schema', op: { op: 'alterPropertyGraph', name: this.t0.graph, action: { kind: 'addLabel', label: l, table } } } as PlanStatementInput);
    this.labelTables.set(l, table);
    return table;
  }

  /** A relationship type's edge table: the type added to the graph if it hasn't it yet. */
  private type(t: string): string {
    const known = this.types.get(t);
    if (known) return known;
    this.sameButCase(t, this.types, 'relationship type');
    const table = `${this.t0.graph}_t${this.types.size}`;
    this.db.queryPlan({ kind: 'schema', op: { op: 'alterPropertyGraph', name: this.t0.graph, action: { kind: 'addType', type: t, table } } } as PlanStatementInput);
    this.types.set(t, table);
    return table;
  }

  /** smaltdb finds a graph's labels and types ignoring case; Cypher's are case-sensitive. */
  private sameButCase(name: string, names: ReadonlyMap<string, string>, what: string): void {
    for (const other of names.keys()) {
      if (other.toLowerCase() === name.toLowerCase()) refuse(`the ${what} ${name} beside ${other} (a smaltdb property graph finds them ignoring case)`);
    }
  }

  // SET and REMOVE.

  private setItems(items: readonly SetItem[], frame: Frame, row: Row): void {
    for (const it of items) {
      // The target first: a NULL target is a no-op, its value not computed (as in smaltcy's engine).
      const t = this.evaluate(frame, row, it.target);
      if (isNullValue(t)) continue;
      switch (it.kind) {
        case 'prop': {
          const target = this.entity(t, "Can't set a property on a");
          const v = this.evaluate(frame, row, it.value);
          if (v.k === 'value' && v.v === null) this.setProps(target, (cur) => removeKeys(cur, [it.key]), 1);
          else {
            const value = propertyValue(v, 'SET');
            this.setProps(target, (cur, given) => call('map_merge', [removeKeys(cur, [it.key]), call('map_of', [lit(it.key), given], PROPS)], PROPS), 1, value);
          }
          break;
        }
        case 'props': {
          const target = this.entity(t, "Can't set a property on a");
          const { props, nulls, isMap } = this.propertyMap(frame, row, it.value, 'SET');
          if (target.props === null) break;
          if (!it.merge) {
            // Every property the map hasn't is removed, then the map's set.
            const removed = Object.keys(target.props).filter((k) => !(k in props)).length;
            this.setProps(target, (_cur, given) => given, removed + Object.keys(props).length, props, PROPS);
          } else {
            // With +=, a NULL in the map removes the key.
            const gone = isMap ? nulls : [];
            this.setProps(target, (cur, given) => call('map_merge', [removeKeys(cur, gone), given], PROPS), gone.length + Object.keys(props).length, props, PROPS);
          }
          break;
        }
        case 'labels': {
          if (t.k !== 'node') throw new SmaltcyError('SMALTCY_TYPE', `Can't set labels on a ${valueTypeName(t)}`);
          for (const l of it.labels) {
            if (this.hasLabel(t.id!, l)) continue;
            this.label(l);
            this.db.queryPlan(this.append(this.tables().labels, ['int', 'text'], [[t.id], [l]], [0, 1]));
            this.counts.labelsAdded++;
          }
          break;
        }
      }
    }
  }

  private removeItems(items: readonly RemoveItem[], frame: Frame, row: Row): void {
    for (const it of items) {
      const t = this.evaluate(frame, row, it.target);
      if (isNullValue(t)) continue;
      if (it.kind === 'prop') {
        this.setProps(this.entity(t, "Can't set a property on a"), (cur) => removeKeys(cur, [it.key]), 1);
        continue;
      }
      if (t.k !== 'node') throw new SmaltcyError('SMALTCY_TYPE', `Can't remove labels from a ${valueTypeName(t)}`);
      for (const l of it.labels) {
        if (!this.hasLabel(t.id!, l)) continue;
        const entries = filter(scan(this.tables().labels, [-1, 0, 1]), and(eq(colRef(1, 'int'), lit(t.id)), eq(colRef(2, 'text'), lit(l, 'text'))));
        this.db.queryPlan(write({ op: 'delete', table: this.tables().labels, db: 'main', input: entries, rowid: 0 }));
        this.counts.labelsRemoved++;
      }
    }
  }

  private hasLabel(id: number, l: string): boolean {
    const entries = filter(scan(this.tables().labels, [0, 1]), and(eq(colRef(0, 'int'), lit(id)), eq(colRef(1, 'text'), lit(l, 'text'))));
    return this.lookup(project(ONE_ROW, [exists(entries)]), ['bool'])[0]![0] === true;
  }

  /** A node or relationship whose properties are set: its table, rowid and properties (NULL: it's gone). */
  private entity(t: Value, message: string): { table: string; column: number; rowid: number; props: Props | null } {
    if (t.k === 'node') return { table: this.tables().nodes, column: 1, rowid: t.id!, props: t.props };
    if (t.k === 'rel') return { table: this.types.get(t.type!)!, column: 2, rowid: t.rowid!, props: t.props };
    throw new SmaltcyError('SMALTCY_TYPE', `${message} ${valueTypeName(t)}`);
  }

  /**
   * Sets a node's or relationship's properties to `f` of what they are (in the table) and of `given` (a value given
   * from here, `any` or `type`), counting `count` properties set; nothing when it's gone, as in smaltcy's engine.
   */
  private setProps(e: { table: string; column: number; rowid: number; props: Props | null }, f: (cur: PlanExpr, given: PlanExpr) => PlanExpr, count: number, given: unknown = null, type: PlanType = 'any'): void {
    if (e.props === null) return;
    // A value of `any` crosses as a one-element `list<any>`, which keeps its kind (smaltdb ADR 0039).
    const wrapped = type === 'any';
    const values = { op: 'values', rows: [], types: [wrapped ? 'list<any>' : type], columns: [[wrapped ? [given] : given]] } as unknown as PlanOp;
    // The target joined with the value (smaltdb's UPDATE … FROM shape: the WHERE over the join).
    const input = filter({ op: 'join', kind: 'cross', inputs: [scan(e.table, [-1, e.column]), values] }, eq(colRef(0, 'int'), lit(e.rowid)));
    const g = wrapped ? call('list_get', [colRef(2, 'list<any>'), lit(0)], 'any') : colRef(2, type);
    this.db.queryPlan(write({ op: 'update', table: e.table, db: 'main', input, rowid: 0, sets: [{ column: e.column, value: f(colRef(1, PROPS), g) }], from: true }));
    this.counts.propertiesSet += count;
  }

  // DELETE.

  private deleteValue(v: Value, detach: boolean): void {
    switch (v.k) {
      case 'value':
        if (v.v === null) return;
        if (Array.isArray(v.v)) return refuse('DELETE of a list');
        throw new SmaltcyError('SMALTCY_TYPE', `Can't delete a ${typeName(v.v)}`);
      case 'rel':
        if (v.rowid !== null) this.deleteRel(v.type!, v.rowid);
        return;
      case 'rels':
        for (const h of v.hops ?? []) this.deleteRel(this.typeNames()[h.edge]!, h.rowid);
        return;
      case 'node':
        if (v.id !== null) this.deleteNode(v.id, detach);
        return;
      case 'nodes':
        for (const id of v.ids ?? []) if (id !== null) this.deleteNode(id, detach);
        return;
      case 'path':
        if (v.hops === null || v.start === null) return;
        for (const h of v.hops) this.deleteRel(this.typeNames()[h.edge]!, h.rowid);
        for (const id of [v.start, ...v.hops.map((h) => h.to)]) this.deleteNode(id, detach);
        return;
    }
  }

  private deleteRel(type: string, rowid: number): void {
    const table = this.types.get(type)!;
    const rows = filter(scan(table, [-1]), eq(colRef(0, 'int'), lit(rowid)));
    this.counts.relationshipsDeleted += this.deleted(table, rows);
  }

  /** Deletes the rows of `input` (column 0 their rowid): how many there were. */
  private deleted(table: string, input: PlanOp): number {
    return this.db.queryPlan(write({ op: 'delete', table, db: 'main', input, rowid: 0, returning: [lit(1)] })).rows.length;
  }

  private deleteNode(id: number, detach: boolean): void {
    const node = filter(scan(this.tables().nodes, [0]), eq(colRef(0, 'int'), lit(id)));
    const touching = (table: string) => filter(scan(table, [-1, 0, 1]), or(eq(colRef(1, 'int'), lit(id)), eq(colRef(2, 'int'), lit(id))));
    const tables = [...this.types.values()];
    const [here, connected] = this.lookup(project(ONE_ROW, [exists(node), tables.length ? or(...tables.map((t) => exists(touching(t)))) : lit(false)]), ['bool', 'bool'])[0]!;
    if (here !== true) return;
    if (connected === true) {
      if (!detach) throw new SmaltcyError('SMALTCY_CONSTRAINT', `Cannot delete node ${id}: it still has relationships (use DETACH DELETE)`);
      for (const t of tables) this.counts.relationshipsDeleted += this.deleted(t, touching(t));
    }
    // Its entries in the label index go with it (smaltdb's rules on a graph's tables).
    this.deleted(this.tables().nodes, node);
    this.counts.nodesDeleted++;
  }
}

/** A props map without some keys. */
function removeKeys(cur: PlanExpr, keys: readonly string[]): PlanExpr {
  return keys.length ? call('map_remove', [cur, call('list_of', keys.map((k) => lit(k, 'text')), 'list<text>')], PROPS) : cur;
}

/** The columns a value's expressions give: the value, or a node's, relationship's or path's identity and properties. */
function columnsOf(v: Val): [PlanExpr[], PlanType[]] {
  switch (v.k) {
    case 'value': return [[v.e], [v.t]];
    case 'node': return [[v.id, v.props], ['int', PROPS]];
    case 'rel': return [[v.type, v.rowid, v.props], ['text', 'int', PROPS]];
    case 'rels': return [[v.hops], [HOPS]];
    case 'path': return [[v.start, v.hops], ['int', HOPS]];
    case 'nodes': return [[v.ids], [IDS]];
  }
}

function decode(v: Val, cols: readonly unknown[]): Value {
  switch (v.k) {
    case 'value': return { k: 'value', v: cols[0] ?? null };
    case 'node': return { k: 'node', id: cols[0] as number | null, props: cols[0] === null ? null : (cols[1] as Props | null) };
    case 'rel': return { k: 'rel', type: cols[0] as string | null, rowid: cols[1] as number | null, props: cols[1] === null ? null : (cols[2] as Props | null) };
    case 'rels': return { k: 'rels', hops: cols[0] as Hop[] | null };
    case 'path': return { k: 'path', start: cols[0] as number | null, hops: cols[1] as Hop[] | null };
    case 'nodes': return { k: 'nodes', ids: cols[0] as (number | null)[] | null };
  }
}

