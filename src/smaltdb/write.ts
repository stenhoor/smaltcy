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
 * - **Writes in batches.** A CREATE, SET, REMOVE or DELETE whose rows are read before it (as above), with nothing after
 *   it in its clause that reads the graph, writes or stops early (LIMIT), writes all its rows at once: a few smaltdb
 *   statements, not a few per row. It does only where that writes what row by row would: a SET or REMOVE sets one
 *   property or labels, of entities no two rows share, to values that read no other entity; a CREATE's properties read
 *   no nested plan and no entity it creates; a DELETE of nodes detaches them. Anything else runs row by row.
 * - **Entities are read live.** A row holds a node's id and a relationship's type and rowid; every query over a row
 *   reads their properties from their tables again, so `SET n.x = 1 RETURN n.x` reads 1. Values computed before a
 *   write keep what they were. Nodes, relationships and paths in the results are read once the statement is done, as
 *   smaltcy's engine reads them.
 * - **One transaction.** The statement runs in a savepoint (inside the caller's transaction, if there is one): an
 *   error rolls back everything it wrote, the new labels and types included. Given an author or a message, it runs
 *   in a transaction of its own, which carries them to its commit (`smalt_commits`).
 * - **History.** On a graph that keeps history, each commit that changes it is a version, numbered by its smaltdb
 *   commit id; a write that changes nothing (a property set to the value it has) writes nothing, so it makes none.
 * - **New labels and types** are added to the graph (`alterPropertyGraph` `addLabel` / `addType`) when a write first
 *   uses them. The reserved label `smaltcy:node` is refused. Labels and types are case-sensitive in smaltdb as in
 *   Cypher, and the tables made for them are numbered (`<graph>_l<k>`, `<graph>_t<k>`), so `Person` and `person` are
 *   two labels with a table each.
 * - **New ids** are chosen here: a node's is one more than the largest node id, a relationship's rowid one more than
 *   the largest rowid of any edge table, so a relationship's rowid stays unique across types (its id). With history,
 *   the largest in the graph's past versions counts too, so an id is never given again while a version holds it. A
 *   caller that keeps the next ids (`RunOptions.ids`) gets smaltcy's numbering: ids go on from there, used or not.
 *
 * What it can't run as smaltcy's engine does it refuses with `Unsupported`: before anything runs where the plan shows
 * it, else when a row shows it (a DELETE of a list value), and the savepoint undoes what earlier rows wrote. After a
 * DELETE, the functions smaltcy's engine fails on for a deleted node or relationship (`labels()`, `type()` …) are
 * refused, where smaltdb would give a value.
 */
import type { plan, PlanStatementInput } from 'smaltdb/engine';
import { SmaltcyError } from '../errors.js';
import { forEachChild, slotsRead, type Expr } from '../plan/expr.js';
import { exprsOf, type GraphPlan, type Op, type Pattern, type RemoveItem, type SetItem } from '../plan/ops.js';
import type { GraphTables } from './schema.js';
import { NODE_LABEL } from './schema.js';
import {
  and, asOfOf, call, caseWhen, colRef, COMMITS_TABLE, Compiler, compileQuery, eq, HOPS, IDS, isNull, lit, noHistory, NULL, or,
  paramValues, PROPS, Unsupported, type AsOf, type Binding, type Frame, type Rel, type Val,
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
  /** Whether a transaction is open (`Database.inTransaction`): a statement with an author or a message needs none. */
  readonly inTransaction?: boolean;
}

export interface RunResult {
  readonly columns: readonly string[];
  /** Rows as smaltcy's engine gives them: nodes, relationships and paths as maps of their data. */
  readonly rows: readonly (readonly unknown[])[];
  readonly counts: WriteCounts;
  /** The graph's tables after the statement: with the labels and types it added. */
  readonly tables: GraphTables;
  /**
   * On a graph that keeps history: the version the statement read (`AT VERSION`, `AT TIME`), or the latest once it is
   * done (a smaltdb commit id; 0 before the first). Not given for a statement inside an open transaction.
   */
  readonly version?: number;
}

/** The next node and relationship ids, kept by the caller across statements, as smaltcy's stores keep them. */
export interface NextIds {
  node: number;
  relationship: number;
}

export interface RunOptions {
  readonly params?: Readonly<Record<string, unknown>>;
  /**
   * The commit's author and message (smaltcy's `run(…, { author, message })`): the statement runs in a transaction
   * of its own, whose commit records them in `smalt_commits`. Refused inside an open transaction: its `begin` or
   * `commit` takes them.
   */
  readonly author?: string;
  readonly message?: string;
  /**
   * The next ids, kept by the caller: new nodes and relationships take ids from here (or past the largest the graph
   * holds, when that is higher) and move them on, whether the statement succeeds or not, as smaltcy's stores do.
   */
  readonly ids?: NextIds;
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
  const own = options.author !== undefined || options.message !== undefined;
  if (gp.kind !== 'query') {
    db.queryPlan(indexStatement(gp, tables));
    return { columns: [], rows: [], counts: emptyCounts(), tables };
  }
  if (!writes(gp.root)) {
    const asOf = asOfOf(gp, params);
    if (asOf && !tables.history) noHistory();
    const version = asOf ? versionRead(db, tables, asOf) : undefined;
    const q = compileQuery(gp, tables, { params, ...(version !== undefined ? { asOf: { commit: version } } : {}) });
    const r = db.queryPlan(q.statement, paramValues(q, params));
    const read = version ?? (tables.history && !db.inTransaction ? latestVersion(db) : undefined);
    return { columns: q.columns, rows: r.rows, counts: emptyCounts(), tables, ...(read !== undefined ? { version: read } : {}) };
  }
  if (gp.asOf) throw new Unsupported('AT VERSION and AT TIME');
  if (own && db.inTransaction) throw new Unsupported("an author or a message for a statement inside a transaction (give them to the transaction's begin or commit)");
  const run = new Runner(db, tables, params, options.ids);
  const transaction = (action: string, more: object = {}) => db.queryPlan({ kind: 'transaction', action, ...more } as PlanStatementInput);
  if (own) {
    transaction('begin', { mode: 'deferred', ...(options.author !== undefined ? { author: options.author } : {}), ...(options.message !== undefined ? { message: options.message } : {}) });
  } else {
    transaction('savepoint', { name: SAVEPOINT });
  }
  let out: { columns: readonly string[]; rows: unknown[][] };
  try {
    out = run.statement(gp);
  } catch (e) {
    if (own) transaction('rollback');
    else {
      transaction('rollback', { savepoint: SAVEPOINT });
      transaction('release', { name: SAVEPOINT });
    }
    throw e;
  }
  if (own) transaction('commit');
  else transaction('release', { name: SAVEPOINT });
  const version = tables.history && !db.inTransaction ? latestVersion(db) : undefined;
  return { ...out, counts: run.counts, tables: run.tables(), ...(version !== undefined ? { version } : {}) };
}

/**
 * The smaltdb index a smaltcy property index (`CREATE INDEX FOR (n:L) ON (n.k)`) is: an expression index on the node
 * table, on `map_get(props, k)`. A node table holds every node, so it indexes the key's values of nodes of any label;
 * the label stays a semi-join on the label index, as in every match. Its name is the graph's, `_ix_`, then the label
 * and the key in hex (smaltdb's names ignore case; Cypher's don't), so each label and key has its own. Creating one
 * that exists and dropping one that doesn't do nothing, as in smaltcy's stores.
 */
export function indexStatement(gp: Extract<GraphPlan, { kind: 'createIndex' | 'dropIndex' }>, t: GraphTables): PlanStatementInput {
  const hex = (x: string) => [...new TextEncoder().encode(x)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const name = `${t.graph}_ix_${hex(gp.label)}_${hex(gp.key)}`;
  if (gp.kind === 'dropIndex') return { kind: 'schema', op: { op: 'drop', objectType: 'index', name, ifExists: true } } as PlanStatementInput;
  const expr = call('map_get', [colRef(1, PROPS), lit(gp.key, 'text')], 'any');
  const index: plan.IndexDef = {
    name,
    table: t.nodes,
    unique: false,
    columns: [{ column: -1, expr: { text: `map_get(props, ${JSON.stringify(gp.key)})`, expr }, desc: false, collation: 'binary' }],
  };
  return { kind: 'schema', op: { op: 'createIndex', index, ifNotExists: true } } as PlanStatementInput;
}

/** The latest version of a graph that keeps history: the last commit recorded in `smalt_commits`, 0 before any. */
export function latestVersion(db: SmaltdbDatabase): number {
  return lastCommit(db);
}

function lastCommit(db: SmaltdbDatabase, atOrBefore?: number): number {
  let commits: PlanOp = scan(COMMITS_TABLE, [0, 1]);
  if (atOrBefore !== undefined) commits = filter(commits, call('cmp_le', [colRef(1, 'int'), lit(atOrBefore)], 'bool'));
  const r = db.queryPlan({ kind: 'query', plan: maxOf(commits), columns: [{ name: 'v', type: 'int' }] } as PlanStatementInput);
  return (r.rows[0]?.[0] as number | null) ?? 0;
}

/**
 * The version a query of the past reads, as smaltcy's engine finds it: `AT VERSION v`'s v, which must be one the
 * history keeps (from the oldest not forgotten to the latest: smaltdb would read the present for a commit after it),
 * or the last commit at or before `AT TIME`'s moment (the oldest kept, when that is later).
 */
function versionRead(db: SmaltdbDatabase, t: GraphTables, asOf: AsOf): number {
  const first = horizon(db, t);
  if ('time' in asOf) return Math.max(lastCommit(db, asOf.time), first);
  const latest = lastCommit(db);
  if (asOf.commit < first || asOf.commit > latest) throw new SmaltcyError('SMALTCY_NOT_FOUND', `There is no version ${asOf.commit}: this history has versions ${first} to ${latest}`);
  return asOf.commit;
}

/**
 * The oldest version the graph's history keeps: the node table's horizon in smaltdb's `smalt_history` (`name`,
 * `horizon`; there once something was forgotten), 0 when nothing was. `forgetOnSmaltdb` moves every table's together.
 */
function horizon(db: SmaltdbDatabase, t: GraphTables): number {
  const names = db.queryPlan({ kind: 'query', plan: scan('sqlite_schema', [1]), columns: [{ name: 'name', type: 'text' }] } as PlanStatementInput).rows;
  if (!names.some(([n]) => n === 'smalt_history')) return 0;
  const mine = filter(scan('smalt_history', [0, 1]), eq(call('lower', [colRef(0, 'text')], 'text'), lit(t.nodes.toLowerCase(), 'text')));
  const r = db.queryPlan({ kind: 'query', plan: project(mine, [colRef(1, 'int')]), columns: [{ name: 'h', type: 'int' }] } as PlanStatementInput).rows;
  return (r[0]?.[0] as number | undefined) ?? 0;
}

/**
 * smaltcy's `forget(version)` on smaltdb: the graph's tables forget the versions before `version` (smaltdb's `forget`
 * maintenance statement, for each of them, in one savepoint), so reading an earlier one is an error. The horizon only
 * moves forward; a version after the latest is smaltcy's error.
 */
export function forgetOnSmaltdb(db: SmaltdbDatabase, tables: GraphTables, version: number): void {
  if (!tables.history) noHistory();
  if (!Number.isInteger(version)) throw new SmaltcyError('SMALTCY_TYPE', `forget() takes a whole number, not ${JSON.stringify(version)}`);
  const latest = lastCommit(db);
  if (version > latest) throw new SmaltcyError('SMALTCY_NOT_FOUND', `There is no version ${version}`);
  const all = [tables.nodes, tables.labels, ...tables.labelTables.values(), ...tables.types.values()];
  const transaction = (action: string, more: object) => db.queryPlan({ kind: 'transaction', action, ...more } as PlanStatementInput);
  transaction('savepoint', { name: SAVEPOINT });
  try {
    for (const table of all) db.queryPlan({ kind: 'maintenance', action: 'forget', before: { commit: lit(version) }, table } as PlanStatementInput);
  } catch (e) {
    transaction('rollback', { savepoint: SAVEPOINT });
    transaction('release', { name: SAVEPOINT });
    throw e;
  }
  transaction('release', { name: SAVEPOINT });
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
    private readonly ids?: NextIds,
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
  private stream(op: Op, above: boolean, quiet = true): Stream {
    if (!writes(op) && settled(op)) return this.query(op);
    if (op.op !== 'delete' && op.op !== 'argument' && deletes(op) && readsDeleted(op)) refuse(AFTER_DELETE_FEATURE);
    const inputAbove = WRITES.has(op.op) || (above && op.op !== 'eager' && op.op !== 'sort' && op.op !== 'aggregate');
    // `quiet`: nothing above this operation, up to one that reads all its rows first, reads the graph, writes or stops
    // early, so a write here may write all its rows at once.
    const inputQuiet = BARRIERS.has(op.op) || (quiet && !touches(op));
    // Its rows are read before it writes (`stream` makes them one query), and it can write them all at once.
    const batch = quiet && op.op !== 'argument' && op.op !== 'union' && settled(op.input);
    switch (op.op) {
      case 'argument':
        if (op.slots.length) return refuse('a nested plan with writes');
        return { frame: { types: [], slots: new Map() }, run: (sink) => sink([]) };
      case 'filter': case 'project': case 'unwind': case 'match':
        return this.perRow(op, this.stream(op.input, inputAbove, inputQuiet));
      case 'eager': case 'sort': case 'aggregate':
        return this.allRows(op, this.stream(op.input, inputAbove, inputQuiet));
      case 'distinct':
        // smaltcy's DISTINCT passes each row on as it comes: with writes on both sides, the order they run in matters.
        if (above) return refuse('DISTINCT between writes');
        return this.allRows(op, this.stream(op.input, inputAbove, inputQuiet));
      case 'limit':
        return this.limit(op, this.stream(op.input, inputAbove, inputQuiet));
      case 'union':
        return refuse('UNION with writes');
      case 'create': {
        const input = this.stream(op.input, inputAbove, inputQuiet);
        return this.create(op, input, batch && this.createInBatch(op.pattern, input.frame));
      }
      case 'merge': {
        const input = this.stream(op.input, inputAbove, inputQuiet);
        return this.merge(op, input, batch && this.mergeInBatch(op, input.frame));
      }
      case 'set': {
        const input = this.stream(op.input, inputAbove, inputQuiet);
        if (batch && this.setInBatch(op.items, input.frame)) return this.batched(input, (rows) => this.setRows(op.items, input.frame, rows, false));
        return { frame: input.frame, run: (sink) => input.run((row) => (this.setItems(op.items, input.frame, row), sink(row))) };
      }
      case 'remove': {
        const input = this.stream(op.input, inputAbove, inputQuiet);
        if (batch && this.setInBatch(op.items, input.frame)) return this.batched(input, (rows) => this.setRows(op.items, input.frame, rows, true));
        return { frame: input.frame, run: (sink) => input.run((row) => (this.removeItems(op.items, input.frame, row), sink(row))) };
      }
      case 'delete': {
        const input = this.stream(op.input, inputAbove, inputQuiet);
        if (batch && this.deleteInBatch(op, input.frame)) return this.batched(input, (rows) => this.deleteRows(op, input.frame, rows));
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

  /** A write over all its input's rows at once (`apply` writes and gives the rows it passes on), then those rows passed on. */
  private batched(input: Stream, apply: (rows: Row[]) => Row[], frame: Frame = input.frame): Stream {
    return {
      frame,
      run: (sink) => {
        const rows: Row[] = [];
        input.run((row) => (rows.push(row), true));
        for (const out of apply(rows)) if (!sink(out)) return false;
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

  /** An expression's value for each of the rows, as one query. */
  private evaluateAll(frame: Frame, rows: readonly Row[], x: Expr): Value[] {
    if (!rows.length) return [];
    if (x.k === 'lit' || x.k === 'param' || rows.length === 1) return rows.map((row) => this.evaluate(frame, row, x));
    const c = this.compiler();
    const leaf = this.leaf(frame, rows);
    const v = c.expr(x, leaf.frame);
    const [exprs, types] = columnsOf(v);
    return this.exec(c, { kind: 'query', plan: project(leaf.plan, exprs), columns: types.map((type, i) => ({ name: `c${i}`, type })) }).map((out) => decode(v, out));
  }

  /** `propertyMap` for each of the rows: a map literal's entries evaluated for all of them in one query. */
  private propertyMaps(frame: Frame, rows: readonly Row[], x: Expr, what: string): { props: Props; nulls: string[]; isMap: boolean }[] {
    if (x.k !== 'map' || rows.length < 2) return rows.map((row) => this.propertyMap(frame, row, x, what));
    const c = this.compiler();
    const leaf = this.leaf(frame, rows);
    const vals = x.entries.map(([, e]) => c.expr(e, leaf.frame));
    const cols = vals.map(columnsOf);
    const outs = vals.length ? this.exec(c, { kind: 'query', plan: project(leaf.plan, cols.flatMap(([e]) => e)), columns: cols.flatMap(([, t]) => t).map((type, i) => ({ name: `c${i}`, type })) }) : rows.map(() => []);
    return outs.map((out) => {
      const raw: Record<string, Value> = {};
      let at = 0;
      x.entries.forEach(([k], i) => {
        const n = cols[i]![1].length;
        raw[k] = decode(vals[i]!, out.slice(at, at + n));
        at += n;
      });
      return toProps(raw, true, what);
    });
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
    return toProps(raw, isMap, what);
  }

  private typeNames(): string[] {
    return [...this.types.keys()];
  }

  // CREATE and MERGE.

  private create(op: Extract<Op, { op: 'create' }>, input: Stream, batch = false): Stream {
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
    if (batch) return this.batched(input, (rows) => this.createRows(op.pattern, input.frame, frame, rows), frame);
    return { frame, run: (sink) => input.run((row) => sink(this.createRow(op.pattern, input.frame, frame, row))) };
  }

  /**
   * Whether a CREATE can create all its rows' patterns at once: its properties read no nested plan (which could see
   * what earlier rows created) and nothing the pattern creates (they are evaluated for all rows first).
   */
  private createInBatch(p: Pattern, inFrame: Frame): boolean {
    const props = [...p.nodes.filter((n) => !inFrame.slots.has(n.slot)), ...p.rels].flatMap((x) => (x.props ? [x.props] : []));
    return props.every((x) => !readsGraph(x) && [...slotsRead(x)].every((slot) => inFrame.slots.has(slot)));
  }

  /**
   * `createRow` for all the rows at once: the same checks, ids and counts, in the same order, with one append per
   * table. The properties are evaluated for all rows first (`createInBatch` says when that reads the same).
   */
  private createRows(p: Pattern, inFrame: Frame, out: Frame, rows: readonly Row[]): Row[] {
    if (!rows.length) return [];
    const nodeOf = (slot: number) => out.slots.get(slot) as Extract<Binding, { k: 'node' }>;
    const created: Pattern['nodes'][number][] = [];
    const seen = new Set<number>();
    for (const n of p.nodes) {
      const bound = inFrame.slots.get(n.slot);
      if (bound) {
        if (bound.k !== 'node') refuse('CREATE with a node held in a value');
        continue;
      }
      if (!seen.has(n.slot)) created.push(n);
      seen.add(n.slot);
    }
    for (const row of rows) {
      for (const n of p.nodes) {
        const bound = inFrame.slots.get(n.slot) as Extract<Binding, { k: 'node' }> | undefined;
        if (bound && row[bound.id] === null) throw new SmaltcyError('SMALTCY_TYPE', "Can't create a relationship to NULL");
      }
    }
    for (const n of created) for (const l of n.labels) this.label(l);
    for (const r of p.rels) {
      if (r.types.length !== 1) throw new SmaltcyError('SMALTCY_SEMANTIC', 'A relationship to create needs exactly one type');
      if (r.dir === 'both') throw new SmaltcyError('SMALTCY_SEMANTIC', 'A relationship to create needs a direction');
      if (r.min !== undefined) throw new SmaltcyError('SMALTCY_SEMANTIC', "Can't create a variable-length relationship");
    }
    const nodeProps = created.map((n) => (n.props ? this.propertyMaps(inFrame, rows, n.props, 'CREATE').map((m) => m.props) : rows.map((): Props => ({}))));
    const relProps = p.rels.map((r) => (r.props ? this.propertyMaps(inFrame, rows, r.props, 'CREATE').map((m) => m.props) : rows.map((): Props => ({}))));
    const relTables = p.rels.map((r) => this.type(r.types[0]!));
    const node = { ids: [] as number[], props: [] as Props[] };
    const labels = { ids: [] as number[], labels: [] as string[] };
    const rels = relTables.map(() => ({ rowids: [] as number[], starts: [] as number[], ends: [] as number[], props: [] as Props[] }));
    const outRows = rows.map((row, i) => {
      const next: Row = new Array(out.types.length).fill(null);
      for (let j = 0; j < inFrame.types.length; j++) next[j] = row[j];
      created.forEach((n, k) => {
        const props = nodeProps[k]![i]!;
        const id = this.newNodeId();
        node.ids.push(id);
        node.props.push(props);
        for (const l of new Set(n.labels)) {
          labels.ids.push(id);
          labels.labels.push(l);
        }
        const b = nodeOf(n.slot);
        next[b.id] = id;
        next[b.props] = props;
        this.counts.nodesCreated++;
        this.counts.labelsAdded += n.labels.length;
        this.counts.propertiesSet += Object.keys(props).length;
      });
      const hops = new Map<number, Hop>();
      p.rels.forEach((r, k) => {
        const type = r.types[0]!;
        const a = next[nodeOf(p.nodes[r.from]!.slot).id] as number;
        const z = next[nodeOf(p.nodes[r.to]!.slot).id] as number;
        const [start, end] = r.dir === 'out' ? [a, z] : [z, a];
        const props = relProps[k]![i]!;
        const rowid = this.newRelId();
        const t = rels[k]!;
        t.rowids.push(rowid);
        t.starts.push(start);
        t.ends.push(end);
        t.props.push(props);
        const b = out.slots.get(r.slot) as Extract<Binding, { k: 'rel' }>;
        next[b.type] = type;
        next[b.rowid] = rowid;
        next[b.start] = start;
        next[b.end] = end;
        next[b.props] = props;
        hops.set(r.slot, { edge: this.typeNames().indexOf(type), rowid, from: a, to: z });
        this.counts.relationshipsCreated++;
        this.counts.propertiesSet += Object.keys(props).length;
      });
      for (const path of p.paths ?? []) {
        const b = out.slots.get(path.slot) as Extract<Binding, { k: 'path' }>;
        next[b.hops] = path.rels.map((j) => hops.get(p.rels[j]!.slot)!);
      }
      return next;
    });
    if (node.ids.length) this.db.queryPlan(this.append(this.tables().nodes, ['int', PROPS], [node.ids, node.props], [0, 1]));
    if (labels.ids.length) this.db.queryPlan(this.append(this.tables().labels, ['int', 'text'], [labels.ids, labels.labels], [0, 1]));
    rels.forEach((t, k) => {
      if (t.rowids.length) this.db.queryPlan(this.append(relTables[k]!, ['int', 'int', 'int', PROPS], [t.rowids, t.starts, t.ends, t.props], [-1, 0, 1, 2]));
    });
    return outRows;
  }

  /**
   * MERGE, as smaltcy's engine runs it: for each row, every match of the whole pattern (each through ON MATCH, then
   * passed on), or, when there is none, the pattern created (its unbound nodes and its relationships), through ON
   * CREATE. A row sees what earlier rows created.
   */
  private merge(op: Extract<Op, { op: 'merge' }>, input: Stream, batch = false): Stream {
    const match: Extract<Op, { op: 'match' }> = { op: 'match', input: op.input, pattern: op.pattern, optional: false };
    const { frame } = this.over(match, input.frame, []).r;
    if (batch) return this.batched(input, (rows) => this.mergeRows(op, match, input.frame, frame, rows), frame);
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
   * Whether a MERGE can run all its rows at once: one node, not bound before, with properties that read no nested
   * plan, and no ON CREATE or ON MATCH. A row then matches either nodes that were there before the statement, or the
   * node an earlier row with the same properties created (`mergeRows`).
   */
  private mergeInBatch(op: Extract<Op, { op: 'merge' }>, inFrame: Frame): boolean {
    const p = op.pattern;
    if (op.onCreate.length || op.onMatch.length || p.rels.length || p.nodes.length !== 1 || (p.paths ?? []).length) return false;
    if (inFrame.slots.has(p.nodes[0]!.slot)) return false;
    return this.createInBatch(p, inFrame);
  }

  /**
   * MERGE of one node for all the rows at once: one query matches every row (each numbered, so its matches come back
   * to it); of the rows that match nothing, the first with each set of properties creates the node (one CREATE batch),
   * and the later ones with the same properties match it, as they would row by row. A property that is NULL runs the
   * rows one by one.
   */
  private mergeRows(op: Extract<Op, { op: 'merge' }>, match: Extract<Op, { op: 'match' }>, inFrame: Frame, out: Frame, rows: Row[]): Row[] {
    if (!rows.length) return [];
    const n = op.pattern.nodes[0]!;
    const maps = n.props ? this.propertyMaps(inFrame, rows, n.props, 'MERGE') : rows.map(() => ({ props: {} as Props, nulls: [] as string[], isMap: true }));
    if (maps.some((m) => m.nulls.length) || rows.length === 1) {
      const outRows: Row[] = [];
      this.merge(op, { frame: inFrame, run: (sink) => rows.every((r) => sink(r)) }).run((r) => (outRows.push(r), true));
      return outRows;
    }
    // Every row's matches, in one query: the rows numbered (a last column), so each match names its row.
    const w = inFrame.types.length;
    const numbered: Frame = { types: [...inFrame.types, 'int'], slots: inFrame.slots };
    const c = this.compiler();
    c.given.set(match.input, this.leaf(numbered, rows.map((r, i) => [...r, i])));
    const r = c.op(match);
    const found = new Map<number, Row[]>();
    for (const f of this.rowsOf(c, r)) {
      const i = f[w] as number;
      let list = found.get(i);
      if (!list) found.set(i, (list = []));
      list.push([...f.slice(0, w), ...f.slice(w + 1)]);
    }
    // The rows that match nothing: the first of each set of properties creates.
    const key = (props: Props) => JSON.stringify(Object.keys(props).sort().map((k) => [k, props[k]]));
    const creators = new Map<string, number>();
    const toCreate: number[] = [];
    rows.forEach((_row, i) => {
      if (found.has(i)) return;
      const k = key(maps[i]!.props);
      if (!creators.has(k)) {
        creators.set(k, i);
        toCreate.push(i);
      }
    });
    const created = new Map<number, Row>();
    const made = this.createRows(op.pattern, inFrame, out, toCreate.map((i) => rows[i]!));
    toCreate.forEach((i, j) => created.set(i, made[j]!));
    return rows.flatMap((row, i) => {
      const matches = found.get(i);
      if (matches) return matches;
      const mine = created.get(i);
      if (mine) return [mine];
      // A later row with the same properties: the node the first created, with this row's own columns.
      const first = created.get(creators.get(key(maps[i]!.props))!)!;
      return [[...row, ...first.slice(w)]];
    });
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
    if (this.nextNode === undefined) this.nextNode = Math.max(this.largest(this.tables().nodes, 0) + 1, this.ids?.node ?? 0);
    const id = this.nextNode++;
    if (this.ids) this.ids.node = this.nextNode;
    return id;
  }

  private newRelId(): number {
    if (this.nextRel === undefined) {
      let max = -1;
      for (const table of this.types.values()) max = Math.max(max, this.largest(table, -1));
      this.nextRel = Math.max(max + 1, this.ids?.relationship ?? 0);
    }
    const id = this.nextRel++;
    if (this.ids) this.ids.relationship = this.nextRel;
    return id;
  }

  /**
   * The largest rowid of a table (`column`: the rowid's column, or -1), -1 for none; with history, of its past versions
   * too (smaltdb's `smalt_versions_<table>` or `smalt_log_<table>`, whose `$rowid` is column 0 or 2), so an id a version
   * holds is not given again.
   */
  private largest(table: string, column: number): number {
    const tables: [string, number][] = [[table, column]];
    if (this.t0.history === 'versions') tables.push([`smalt_versions_${table}`, 0]);
    if (this.t0.history === 'log') tables.push([`smalt_log_${table}`, 2]);
    let max = -1;
    for (const [t, c] of tables) {
      const m = this.lookup(maxOf(scan(t, [c])), ['int'])[0]![0] as number | null;
      if (m !== null && m > max) max = m;
    }
    return max;
  }

  /** A label's table: the label added to the graph if it hasn't it yet. */
  private label(l: string): string {
    const known = this.labelTables.get(l);
    if (known) return known;
    if (l === NODE_LABEL) return refuse(`the label ${NODE_LABEL}, which is reserved`);
    const table = `${this.t0.graph}_l${this.labelTables.size}`;
    this.db.queryPlan({ kind: 'schema', op: { op: 'alterPropertyGraph', name: this.t0.graph, action: { kind: 'addLabel', label: l, table } } } as PlanStatementInput);
    this.labelTables.set(l, table);
    return table;
  }

  /** A relationship type's edge table: the type added to the graph if it hasn't it yet. */
  private type(t: string): string {
    const known = this.types.get(t);
    if (known) return known;
    const table = `${this.t0.graph}_t${this.types.size}`;
    this.db.queryPlan({ kind: 'schema', op: { op: 'alterPropertyGraph', name: this.t0.graph, action: { kind: 'addType', type: t, table } } } as PlanStatementInput);
    this.types.set(t, table);
    return table;
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
          if (v.k === 'value' && v.v === null) this.setProps(target, (cur) => removeKeys(cur, [it.key]), 1, without(target.props, [it.key]));
          else {
            const value = propertyValue(v, 'SET');
            this.setProps(target, (cur, given) => call('map_merge', [removeKeys(cur, [it.key]), call('map_of', [lit(it.key), given], PROPS)], PROPS), 1, { ...without(target.props, [it.key]), [it.key]: value }, value);
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
            this.setProps(target, (_cur, given) => given, removed + Object.keys(props).length, props, props, PROPS);
          } else {
            // With +=, a NULL in the map removes the key.
            const gone = isMap ? nulls : [];
            this.setProps(target, (cur, given) => call('map_merge', [removeKeys(cur, gone), given], PROPS), gone.length + Object.keys(props).length, { ...without(target.props, gone), ...props }, props, PROPS);
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
        const target = this.entity(t, "Can't set a property on a");
        this.setProps(target, (cur) => removeKeys(cur, [it.key]), 1, without(target.props, [it.key]));
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

  /**
   * Whether a SET or REMOVE can write all its rows at once: each item sets or removes one property or labels of a node
   * or relationship its row holds, to a value that reads no nested plan and no other node or relationship (so no row
   * reads what another writes). `setRows` checks that no two rows share a target.
   */
  private setInBatch(items: readonly (SetItem | RemoveItem)[], frame: Frame): boolean {
    return items.every((it) => {
      if (it.target.k !== 'slot') return false;
      const b = frame.slots.get(it.target.i);
      if (!b || (b.k !== 'node' && (b.k !== 'rel' || it.kind === 'labels'))) return false;
      if (it.kind === 'labels') return true;
      if (it.kind !== 'prop') return false;
      if (!('value' in it)) return true;
      const target = it.target.i;
      return !readsGraph(it.value) && [...slotsRead(it.value)].every((slot) => slot === target || frame.slots.get(slot)?.k === 'value');
    });
  }

  /**
   * SET (`remove` false) or REMOVE for all the rows at once, item by item: each item's targets and values are read for
   * all rows, then written in one statement. With no target in two rows, that is what row by row writes; when one is,
   * the rows run one by one.
   */
  private setRows(items: readonly (SetItem | RemoveItem)[], frame: Frame, rows: Row[], remove: boolean): Row[] {
    const idOf = (row: Row, slot: number): string | null => {
      const b = frame.slots.get(slot)!;
      if (b.k === 'node') return row[b.id] === null ? null : `n${row[b.id]}`;
      const r = b as Extract<Binding, { k: 'rel' }>;
      return row[r.rowid] === null ? null : `r${row[r.type]}:${row[r.rowid]}`;
    };
    const shared = items.some((it) => {
      const ids = rows.map((row) => idOf(row, (it.target as { i: number }).i)).filter((x) => x !== null);
      return new Set(ids).size !== ids.length;
    });
    if (shared || rows.length < 2) {
      for (const row of rows) remove ? this.removeItems(items as RemoveItem[], frame, row) : this.setItems(items as SetItem[], frame, row);
      return rows;
    }
    for (const it of items) {
      const live = rows.filter((row) => idOf(row, (it.target as { i: number }).i) !== null);
      if (!live.length) continue;
      if (it.kind === 'labels') {
        const b = frame.slots.get((it.target as { i: number }).i) as Extract<Binding, { k: 'node' }>;
        this.labelRows(live.map((row) => row[b.id] as number), it.labels, remove);
        continue;
      }
      if (it.kind !== 'prop') return refuse('SET of a property map in a batch');
      const targets = this.evaluateAll(frame, live, it.target);
      const values = 'value' in it ? this.evaluateAll(frame, live, it.value) : null;
      // By table: the rowids, and the value each gets (`null` removes the key).
      const writes = new Map<string, { column: number; rowids: number[]; given: unknown[]; removed: number[] }>();
      targets.forEach((t, i) => {
        const target = this.entity(t, "Can't set a property on a");
        if (target.props === null) return;
        const v = values?.[i];
        const gone = !v || (v.k === 'value' && v.v === null);
        const value = gone ? null : propertyValue(v, 'SET');
        const next = gone ? without(target.props, [it.key]) : { ...without(target.props, [it.key]), [it.key]: value };
        this.counts.propertiesSet++;
        if (next !== null && sameProps(target.props, next)) return;
        let w = writes.get(target.table);
        if (!w) writes.set(target.table, (w = { column: target.column, rowids: [], given: [], removed: [] }));
        if (gone) w.removed.push(target.rowid);
        else {
          w.rowids.push(target.rowid);
          w.given.push(value);
        }
      });
      for (const [table, w] of writes) {
        if (w.removed.length) this.updateProps(table, w.column, w.removed, null, (cur) => removeKeys(cur, [it.key]));
        if (w.rowids.length) this.updateProps(table, w.column, w.rowids, w.given, (cur, g) => call('map_merge', [removeKeys(cur, [it.key]), call('map_of', [lit(it.key), g], PROPS)], PROPS));
      }
    }
    return rows;
  }

  /** Sets a property map column of the rows `rowids` of a table to `f` of what it is and of `given` (one per row). */
  private updateProps(table: string, column: number, rowids: readonly number[], given: readonly unknown[] | null, f: (cur: PlanExpr, given: PlanExpr) => PlanExpr): void {
    // A value of `any` crosses as a one-element `list<any>`, which keeps its kind (smaltdb ADR 0039).
    const values = { op: 'values', rows: [], types: given ? ['int', 'list<any>'] : ['int'], columns: given ? [rowids, given.map((g) => [g])] : [rowids] } as unknown as PlanOp;
    const input = filter({ op: 'join', kind: 'cross', inputs: [scan(table, [-1, column]), values] }, eq(colRef(0, 'int'), colRef(2, 'int')));
    const g = given ? call('list_get', [colRef(3, 'list<any>'), lit(0)], 'any') : NULL;
    this.db.queryPlan(write({ op: 'update', table, db: 'main', input, rowid: 0, sets: [{ column, value: f(colRef(1, PROPS), g) }], from: true }));
  }

  /** Adds (or with `remove`, removes) labels of the nodes `ids` (no two the same), counting those it changes. */
  private labelRows(ids: readonly number[], labels: readonly string[], remove: boolean): void {
    for (const l of labels) {
      const given = { op: 'values', rows: [], types: ['int'], columns: [ids] } as unknown as PlanOp;
      // The label index's entries for these nodes and this label.
      const entries = filter({ op: 'join', kind: 'cross', inputs: [given, scan(this.tables().labels, [-1, 0, 1])] }, and(eq(colRef(0, 'int'), colRef(2, 'int')), eq(colRef(3, 'text'), lit(l, 'text'))));
      if (remove) {
        if (!this.labelTables.has(l)) continue;
        const rowids = this.lookup(project(entries, [colRef(1, 'int')]), ['int']).map((r) => r[0]);
        if (!rowids.length) continue;
        const del = filter(scan(this.tables().labels, [-1]), call('in_list', [colRef(0, 'int'), ...rowids.map((r) => lit(r))], 'bool'));
        this.counts.labelsRemoved += this.deleted(this.tables().labels, del);
        continue;
      }
      const has = this.labelTables.has(l) ? new Set(this.lookup(project(entries, [colRef(0, 'int')]), ['int']).map((r) => r[0] as number)) : new Set<number>();
      const missing = ids.filter((id) => !has.has(id));
      if (!missing.length) continue;
      this.label(l);
      this.db.queryPlan(this.append(this.tables().labels, ['int', 'text'], [missing, missing.map(() => l)], [0, 1]));
      this.counts.labelsAdded += missing.length;
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
   * `next` is what they become: when it is what they are, nothing is written (smaltcy's history records no change).
   */
  private setProps(e: { table: string; column: number; rowid: number; props: Props | null }, f: (cur: PlanExpr, given: PlanExpr) => PlanExpr, count: number, next: Props | null, given: unknown = null, type: PlanType = 'any'): void {
    if (e.props === null) return;
    if (next !== null && sameProps(e.props, next)) {
      this.counts.propertiesSet += count;
      return;
    }
    // A value of `any` crosses as a one-element `list<any>`, which keeps its kind (smaltdb ADR 0039).
    const wrapped = type === 'any';
    const values = { op: 'values', rows: [], types: [wrapped ? 'list<any>' : type], columns: [[wrapped ? [given] : given]] } as unknown as PlanOp;
    // The target joined with the value (smaltdb's UPDATE … FROM shape: the WHERE over the join).
    const input = filter({ op: 'join', kind: 'cross', inputs: [scan(e.table, [-1, e.column]), values], ordered: true }, eq(colRef(0, 'int'), lit(e.rowid)));
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

  /**
   * Whether a DELETE can delete all its rows' targets at once: each target is a node, relationship or path its row
   * holds, and nodes are detached (a node's check for relationships left would see what later rows delete).
   */
  private deleteInBatch(op: Extract<Op, { op: 'delete' }>, frame: Frame): boolean {
    return op.targets.every((t) => {
      if (t.k !== 'slot') return false;
      const k = frame.slots.get(t.i)?.k;
      if (k === 'rel' || k === 'rels') return true;
      return op.detach && (k === 'node' || k === 'nodes' || k === 'path');
    });
  }

  /** DELETE for all the rows at once: their relationships, then (detached) their nodes, one statement per table. */
  private deleteRows(op: Extract<Op, { op: 'delete' }>, frame: Frame, rows: Row[]): Row[] {
    const rels = new Map<string, Set<number>>();
    const nodes = new Set<number>();
    const rel = (type: string, rowid: number) => {
      let set = rels.get(type);
      if (!set) rels.set(type, (set = new Set()));
      set.add(rowid);
    };
    const names = this.typeNames();
    for (const row of rows) {
      for (const t of op.targets) {
        const b = frame.slots.get((t as { i: number }).i)!;
        switch (b.k) {
          case 'rel': if (row[b.rowid] !== null) rel(row[b.type] as string, row[b.rowid] as number); break;
          case 'rels': for (const h of (row[b.hops] as Hop[] | null) ?? []) rel(names[h.edge]!, h.rowid); break;
          case 'node': if (row[b.id] !== null) nodes.add(row[b.id] as number); break;
          case 'nodes': for (const id of (row[b.ids] as (number | null)[] | null) ?? []) if (id !== null) nodes.add(id); break;
          case 'path': {
            const hops = row[b.hops] as Hop[] | null;
            if (hops === null || row[b.start] === null) break;
            for (const h of hops) rel(names[h.edge]!, h.rowid);
            for (const id of [row[b.start] as number, ...hops.map((h) => h.to)]) nodes.add(id);
            break;
          }
          default: refuse('DELETE of a value');
        }
      }
    }
    for (const [type, rowids] of rels) {
      const table = this.types.get(type)!;
      this.counts.relationshipsDeleted += this.deleted(table, filter(scan(table, [-1]), call('in_list', [colRef(0, 'int'), ...[...rowids].map((r) => lit(r))], 'bool')));
    }
    if (nodes.size) {
      const ids = [...nodes];
      for (const table of this.types.values()) {
        for (const end of [0, 1]) {
          const given = { op: 'values', rows: [], types: ['int'], columns: [ids] } as unknown as PlanOp;
          // Each end on its own, so each is a seek on the edge table's index; a self-loop's second finds it gone.
          const touching = project(filter({ op: 'join', kind: 'cross', inputs: [given, scan(table, [-1, end])] }, eq(colRef(0, 'int'), colRef(2, 'int'))), [colRef(1, 'int')]);
          const rowids = this.lookup(touching, ['int']).map((r) => r[0] as number);
          if (rowids.length) this.counts.relationshipsDeleted += this.deleted(table, filter(scan(table, [-1]), call('in_list', [colRef(0, 'int'), ...rowids.map((r) => lit(r))], 'bool')));
        }
      }
      // Their entries in the label index go with them (smaltdb's rules on a graph's tables).
      this.counts.nodesDeleted += this.deleted(this.tables().nodes, filter(scan(this.tables().nodes, [0]), call('in_list', [colRef(0, 'int'), ...ids.map((r) => lit(r))], 'bool')));
    }
    return rows;
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
    // Each end on its own, so each is a seek on the edge table's index (an OR of the two would scan the table).
    const touching = (table: string, end: 1 | 2) => filter(scan(table, [-1, 0, 1]), eq(colRef(end, 'int'), lit(id)));
    const tables = [...this.types.values()];
    const ends = tables.flatMap((t) => [exists(touching(t, 1)), exists(touching(t, 2))]);
    const [here, connected] = this.lookup(project(ONE_ROW, [exists(node), ends.length ? or(...ends) : lit(false)]), ['bool', 'bool'])[0]!;
    if (here !== true) return;
    if (connected === true) {
      if (!detach) throw new SmaltcyError('SMALTCY_CONSTRAINT', `Cannot delete node ${id}: it still has relationships (use DETACH DELETE)`);
      // A self-loop starts and ends here: the second delete finds it gone.
      for (const t of tables) this.counts.relationshipsDeleted += this.deleted(t, touching(t, 1)) + this.deleted(t, touching(t, 2));
    }
    // Its entries in the label index go with it (smaltdb's rules on a graph's tables).
    this.deleted(this.tables().nodes, node);
    this.counts.nodesDeleted++;
  }
}

/** A property map's entries as properties: NULLs dropped (their keys in `nulls`), the rest checked. */
function toProps(raw: Record<string, Value>, isMap: boolean, what: string): { props: Props; nulls: string[]; isMap: boolean } {
  const props: Props = {};
  const nulls: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (v.k === 'value' && v.v === null) nulls.push(k);
    else props[k] = propertyValue(v, what);
  }
  return { props, nulls, isMap };
}

/** Operations that read all their rows before passing any on (`allRows`): writes above them wait for them. */
const BARRIERS = new Set(['eager', 'sort', 'aggregate', 'distinct']);

/** Whether a plan's rows are one query: it writes nothing and reads all it reads first (EAGER), or reads no graph. */
function settled(op: Op): boolean {
  return !writes(op) && (op.op === 'eager' || !readsGraph(op));
}

/** Whether an expression reads only its row's values: no properties, labels, functions or nested plans. */
function plainExpr(x: Expr): boolean {
  if (x.k === 'lit' || x.k === 'param' || x.k === 'slot') return true;
  if (!['list', 'map', 'and', 'or', 'xor', 'not', 'isNull', 'case'].includes(x.k)) return false;
  let ok = true;
  forEachChild(x, (c) => void (ok &&= plainExpr(c)));
  return ok;
}

/**
 * Whether an operation, above a write in the same clause, would see that write's rows differ written one at a time
 * or all at once: it writes, matches, stops early, or reads more than its rows' values.
 */
function touches(op: Op): boolean {
  if (WRITES.has(op.op) || op.op === 'match' || op.op === 'limit' || op.op === 'union') return true;
  return exprsOf(op).some((x) => !plainExpr(x));
}

/** Properties without some keys (NULL: gone). */
function without(props: Props | null, keys: readonly string[]): Props | null {
  if (props === null) return null;
  const out = { ...props };
  for (const k of keys) delete out[k];
  return out;
}

/** Whether two property maps hold the same values (as smaltcy's history compares them: lists by their elements). */
function sameProps(a: Props, b: Props): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => k in b && sameValue(a[k], b[k]));
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  return false;
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

