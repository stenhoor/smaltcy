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
 * - **Statements are kept.** The smaltdb statements made here for a Cypher statement are kept for its shape (shape.ts,
 *   `writeByShape`; `Runner.site`): each is prepared once and run again by the next statement of the shape. Their
 *   parameters are the Cypher statement's values, the row they run over (one row is a `values` of one row of
 *   parameters) and the runner's own values (a new id, a rowid, a property map). A write of all its rows at once
 *   writes them into its statements, which smaltdb plans each time; a statement that adds a label or a type makes
 *   its statements anew from there, for the graph's new tables.
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
import { runByShape, writeByShape } from './shape.js';
import {
  and, asOfOf, call, caseWhen, colRef, Compiler, compileQuery, eq, HOPS, IDS, isNull, lastCommitOf, lastOf, lit, noHistory, NULL, or,
  paramsRead, paramValues, PROPS, Unsupported, type AsOf, type Binding, type Frame, type Rel, type Val,
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
  /** `Database.preparePlan`: with it, a query's statement is prepared once for its shape and kept (shape.ts). */
  preparePlan?(stmt: PlanStatementInput): { result(params?: readonly never[]): { readonly rows: readonly (readonly unknown[])[] } };
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
    // By its shape, where it has one that is kept (shape.ts); else compiled as written.
    let r = runByShape(db, gp, tables, params);
    if (!r) {
      const q = compileQuery(gp, tables, { params, ...(version !== undefined ? { asOf: { commit: version } } : {}) });
      r = { columns: q.columns, rows: db.queryPlan(q.statement, paramValues(q, params)).rows };
    }
    const read = version ?? (tables.history && !db.inTransaction ? latestVersion(db) : undefined);
    return { columns: r.columns, rows: r.rows, counts: emptyCounts(), tables, ...(read !== undefined ? { version: read } : {}) };
  }
  if (gp.asOf) throw new Unsupported('AT VERSION and AT TIME');
  if (own && db.inTransaction) throw new Unsupported("an author or a message for a statement inside a transaction (give them to the transaction's begin or commit)");
  // The statement with its values as parameters, and what the runner kept for its shape (shape.ts): the statements it
  // makes for one statement of a shape and for the next differ only in their parameters, so it makes each once.
  const stated = writeByShape(db, gp, tables, params);
  const run = new Runner(db, tables, stated.params, options.ids, stated.sites);
  const transaction = (action: string, more: object = {}) => db.queryPlan({ kind: 'transaction', action, ...more } as PlanStatementInput);
  const around = own ? null : savepoints(db);
  if (own) {
    transaction('begin', { mode: 'deferred', ...(options.author !== undefined ? { author: options.author } : {}), ...(options.message !== undefined ? { message: options.message } : {}) });
  } else {
    around!.savepoint();
  }
  let out: { columns: readonly string[]; rows: unknown[][] };
  try {
    out = run.statement(stated.plan);
  } catch (e) {
    if (own) transaction('rollback');
    else {
      around!.rollback();
      around!.release();
    }
    throw e;
  }
  if (own) transaction('commit');
  else around!.release();
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

/** The three statements around a write that runs in a savepoint. */
interface Savepoints {
  readonly savepoint: () => void;
  readonly rollback: () => void;
  readonly release: () => void;
}

/** A database's savepoint statements, prepared the first time a write runs on it and kept. */
const savepointsOf = new WeakMap<object, Savepoints>();

function savepoints(db: SmaltdbDatabase): Savepoints {
  let kept = savepointsOf.get(db);
  if (kept) return kept;
  const statement = (action: string, more: object): (() => void) => {
    const stmt = { kind: 'transaction', action, ...more } as PlanStatementInput;
    const prepared = db.preparePlan?.(stmt);
    return prepared ? () => void prepared.result() : () => void db.queryPlan(stmt);
  };
  kept = { savepoint: statement('savepoint', { name: SAVEPOINT }), rollback: statement('rollback', { savepoint: SAVEPOINT }), release: statement('release', { name: SAVEPOINT }) };
  savepointsOf.set(db, kept);
  return kept;
}

/** The latest version of a graph that keeps history: the last commit recorded in `smalt_commits`, 0 before any. */
export function latestVersion(db: SmaltdbDatabase): number {
  return lastCommit(db);
}

type Prepared = NonNullable<ReturnType<NonNullable<SmaltdbDatabase['preparePlan']>>>;

/**
 * A database's statements for its last commit, each prepared the first time it is run and kept: the latest, and the
 * last at or before a time (its parameter). Every statement on a graph that keeps history runs the first, so smaltdb
 * does not look it up by its plan each time.
 */
const commitLookups = new WeakMap<object, { latest?: Prepared; atTime?: Prepared }>();

/** The last commit recorded in `smalt_commits` (`lastCommitOf`), 0 before any: with `atOrBefore`, the last at or before that time. */
function lastCommit(db: SmaltdbDatabase, atOrBefore?: number): number {
  const statement = (time?: PlanExpr): PlanStatementInput => ({ kind: 'query', plan: lastCommitOf(time), columns: [{ name: 'v', type: 'int' }] }) as PlanStatementInput;
  let rows: readonly (readonly unknown[])[];
  if (!db.preparePlan) rows = db.queryPlan(statement(atOrBefore === undefined ? undefined : lit(atOrBefore))).rows;
  else {
    let kept = commitLookups.get(db);
    if (!kept) commitLookups.set(db, (kept = {}));
    if (atOrBefore === undefined) rows = (kept.latest ??= db.preparePlan(statement())).result().rows;
    else rows = (kept.atTime ??= db.preparePlan(statement({ k: 'param', index: 0, type: 'num' }))).result([atOrBefore] as never).rows;
  }
  return (rows[0]?.[0] as number | null) ?? 0;
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

/** The most nodes and relationships a DELETE deletes one by one, each by a statement kept for one (`deleteRows`). */
const FEW = 8;

/** A parameter's name for a column of the row a kept statement runs with: no name Cypher can write, then the column. */
const ROW = '\u0001';

/**
 * A statement the runner makes for one row, or for values of its own, with those as its parameters. It is made once
 * for a part of a write's plan and kept there (`Runner.site`), then run with each row's values, where a statement with
 * the values written in it is a plan of its own each time, which smaltdb plans from nothing. It holds no runner: a
 * statement kept outlives the run that made it.
 */
interface Stmt {
  /** Runs it with its parameters bound: its rows. */
  readonly rows: (bound: readonly unknown[]) => readonly (readonly unknown[])[];
  /** Its parameters in order: a column of the row (0 and up), a value of the runner's (-1 - k), or a Cypher parameter's name. */
  readonly order: readonly (number | string)[];
  /** The row's columns of type `any`: each is given as a one-element `list<any>`, which keeps its kind (smaltdb ADR 0039). */
  readonly wrapped: readonly boolean[] | null;
}

/** A value of the runner's as a parameter of a statement it makes by hand: parameter `k`, given as `given[k]` (`Runner.run`). */
const own = (k: number, type: PlanType): PlanExpr => ({ k: 'param', index: k, type });

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
    private readonly ids: NextIds | undefined,
    /**
     * What runs of this statement's shape keep (shape.ts, `writeByShape`): by part of the plan, then by what it is
     * for. Null when nothing is kept: the statement is run as written, or this run changed the graph's tables (a new
     * label or type), which what is kept was made for.
     */
    private sites: Map<unknown, Map<string, unknown>> | null,
  ) {
    this.labelTables = new Map(t0.labelTables);
    this.types = new Map(t0.types);
  }

  /** What is kept for `role` of a part of the plan (`anchor`, or a table's name): made by the first run that needs it. */
  private site<T>(anchor: unknown, role: string, make: () => T): T {
    const sites = this.sites;
    if (sites === null) return make();
    let roles = sites.get(anchor);
    if (roles === undefined) sites.set(anchor, (roles = new Map()));
    let kept = roles.get(role) as T | undefined;
    if (kept === undefined) roles.set(role, (kept = make()));
    return kept;
  }

  /** A parameter for column `i` of the row a statement runs with, numbered among `c`'s parameters. */
  private rowParam(c: Compiler, i: number, type: PlanType): PlanExpr {
    return { k: 'param', index: c.paramNames.push(ROW + i) - 1, type };
  }

  /**
   * A statement compiled by `c` over one row of `frame` (`leafOne`), as one to run with each row's values and the
   * statement's Cypher parameters. It is prepared when it is kept; one made for this run alone goes by its plan.
   */
  private stmt(c: Compiler, statement: PlanStatementInput, frame: Frame | null): Stmt {
    const order = paramsRead(statement, c.paramNames).map((name) => (name.startsWith(ROW) ? Number(name.slice(ROW.length)) : name));
    return this.prepared(statement, order, frame ? frame.types.map((t) => t === 'any') : null);
  }

  /** A statement made by hand, whose parameters are `count` values of the runner's (`own`). */
  private ownStmt(statement: PlanStatementInput, count: number): Stmt {
    return this.prepared(statement, Array.from({ length: count }, (_, k) => -1 - k), null);
  }

  private prepared(statement: PlanStatementInput, order: readonly (number | string)[], wrapped: readonly boolean[] | null): Stmt {
    const db = this.db;
    const prepared = this.sites !== null ? db.preparePlan?.(statement) : undefined;
    return { order, wrapped, rows: prepared ? (bound) => prepared.result(bound as readonly never[]).rows : (bound) => db.queryPlan(statement, bound).rows };
  }

  /** Runs a statement with `row`'s values, the runner's (`given`) and the Cypher statement's parameters. */
  private run(s: Stmt, row: Row | null, given?: readonly unknown[]): readonly (readonly unknown[])[] {
    const order = s.order;
    const bound: unknown[] = new Array(order.length);
    for (let i = 0; i < order.length; i++) {
      const p = order[i]!;
      // A named one is there: the compiler refuses a parameter that wasn't given, and a shape holds which are.
      if (typeof p === 'string') bound[i] = this.params[p];
      else if (p < 0) bound[i] = given![-1 - p];
      else bound[i] = s.wrapped![p] ? [row![p] ?? null] : (row![p] ?? null);
    }
    return s.rows(bound);
  }

  /**
   * The graph's tables as they are now: the ones given, until this run adds a label or a type (then with the runner's
   * maps, which grow as more are added). The same object while nothing is added, so what is kept by the tables (a
   * shape's signature, shape.ts) is found again by the caller's next statement.
   */
  tables(): GraphTables {
    return this.grown ?? this.t0;
  }
  private grown: GraphTables | null = null;

  private compiler(): Compiler {
    return new Compiler(this.tables(), this.params);
  }

  private exec(c: Compiler, stmt: PlanStatementInput): unknown[][] {
    const r = this.db.queryPlan(stmt, paramValues({ statement: stmt, columns: [], params: paramsRead(stmt, c.paramNames) }, this.params));
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

  /** Whether the statement deletes: a node or relationship a row holds may then be gone. */
  private deleting = false;

  statement(gp: Extract<GraphPlan, { kind: 'query' }>): { columns: readonly string[]; rows: unknown[][] } {
    this.deleting = this.site(gp, 'deletes', () => deletes(gp.root));
    const s = this.stream(gp.root, false);
    for (const col of gp.columns) {
      // smaltcy's engine gives a deleted node or relationship in a path or list as an empty one; smaltdb's lists drop it.
      const k = s.frame.slots.get(col.slot)?.k;
      if ((k === 'path' || k === 'rels' || k === 'nodes') && deletes(gp.root)) refuse(AFTER_DELETE_FEATURE);
    }
    const rows: Row[] = [];
    s.run((row) => (rows.push(row), true));
    // The results, read now: nodes, relationships and paths as they are at the end of the statement.
    if (!gp.columns.length) return { columns: [], rows: rows.map(() => []) };
    const results = (c: Compiler, leaf: Rel): PlanStatementInput => {
      const exprs: PlanExpr[] = [];
      const columns: { name: string; type: PlanType }[] = [];
      for (const col of gp.columns) {
        const b = leaf.frame.slots.get(col.slot) ?? refuse(`a result column (${col.name}) that isn't bound`);
        const v = c.valueOf(b);
        const r = v.k === 'value' ? { e: v.e, t: v.t } : c.resultValue(v);
        exprs.push(r.e);
        columns.push({ name: col.name, type: r.t });
      }
      return { kind: 'query', plan: project(leaf.plan, exprs), columns };
    };
    let out: unknown[][];
    if (rows.length === 1) {
      // One row: a statement kept for the plan, the row its parameters.
      const kept = this.site(gp, 'results', () => {
        const c = this.compiler();
        return this.stmt(c, results(c, this.leafOne(c, s.frame, true)), s.frame);
      });
      out = this.run(kept, rows[0]!).map((row) => [...row]);
    } else {
      const c = this.compiler();
      out = this.exec(c, results(c, this.leaf(s.frame, rows, true)));
    }
    return { columns: gp.columns.map((col) => col.name), rows: out };
  }

  /**
   * An operation's rows, streamed. `above`: whether an operation above this one, before anything that reads all its
   * input first, writes (so the order rows reach it in matters).
   */
  private stream(op: Op, above: boolean, quiet = true): Stream {
    // What the operation is to the runner is read from the plan alone, where it is at one place (so `above` and
    // `quiet` are the same each time): worked out once for a plan that is kept.
    const how = this.site(op, 'how', () => ({
      query: !writes(op) && settled(op),
      refused: op.op !== 'delete' && op.op !== 'argument' && deletes(op) && readsDeleted(op),
      inputAbove: WRITES.has(op.op) || (above && op.op !== 'eager' && op.op !== 'sort' && op.op !== 'aggregate'),
      // `quiet`: nothing above this operation, up to one that reads all its rows first, reads the graph, writes or
      // stops early, so a write here may write all its rows at once.
      inputQuiet: BARRIERS.has(op.op) || (quiet && !touches(op)),
      // Its rows are read before it writes (`stream` makes them one query), and it can write them all at once.
      batch: quiet && op.op !== 'argument' && op.op !== 'union' && settled((op as Op & { input: Op }).input),
    }));
    if (how.query) return this.query(op);
    if (how.refused) refuse(AFTER_DELETE_FEATURE);
    const { inputAbove, inputQuiet, batch } = how;
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
        return this.create(op, input, batch && this.site(op, 'in a batch', () => this.createInBatch(op.pattern, input.frame)));
      }
      case 'merge': {
        const input = this.stream(op.input, inputAbove, inputQuiet);
        return this.merge(op, input, batch && this.site(op, 'in a batch', () => this.mergeInBatch(op, input.frame)));
      }
      case 'set': {
        const input = this.stream(op.input, inputAbove, inputQuiet);
        if (batch && this.site(op, 'in a batch', () => this.setInBatch(op.items, input.frame))) return this.batched(input, (rows) => this.setRows(op.items, input.frame, rows, false));
        return { frame: input.frame, run: (sink) => input.run((row) => (this.setItems(op.items, input.frame, row), sink(row))) };
      }
      case 'remove': {
        const input = this.stream(op.input, inputAbove, inputQuiet);
        if (batch && this.site(op, 'in a batch', () => this.setInBatch(op.items, input.frame))) return this.batched(input, (rows) => this.setRows(op.items, input.frame, rows, true));
        return { frame: input.frame, run: (sink) => input.run((row) => (this.removeItems(op.items, input.frame, row), sink(row))) };
      }
      case 'delete': {
        const input = this.stream(op.input, inputAbove, inputQuiet);
        if (batch && this.site(op, 'in a batch', () => this.deleteInBatch(op, input.frame))) return this.batched(input, (rows) => this.deleteRows(op, input.frame, rows));
        return {
          frame: input.frame,
          run: (sink) =>
            input.run((row) => {
              op.targets.forEach((t, k) => this.deleteValue(this.evaluate(op, k === 0 ? 'target' : `target ${k}`, input.frame, row, t), op.detach));
              return sink(row);
            }),
        };
      }
    }
  }

  /** A plan that writes nothing and reads what writes don't change: one query, run when its rows are wanted. */
  private query(op: Op): Stream {
    // Asked for when it runs: by then an earlier write of this run may have added a label or a type (`site`).
    const kept = () =>
      this.site(op, 'query', () => {
        const c = this.compiler();
        const r = c.op(op);
        return { frame: r.frame, stmt: this.stmt(c, { kind: 'query', plan: r.plan, columns: r.frame.types.map((type, i) => ({ name: `c${i}`, type })) }, null) };
      });
    return {
      frame: kept().frame,
      run: (sink) => {
        for (const row of this.run(kept().stmt, null)) if (!sink([...row])) return false;
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

  /**
   * `op` over one row of `frame` (its input's rows), as a statement kept for `anchor`: the frame of its rows, and the
   * statement, which runs with a row as its parameters.
   */
  private overOne(anchor: unknown, role: string, op: Op & { input: Op }, frame: Frame): { frame: Frame; stmt: Stmt } {
    return this.site(anchor, role, () => {
      const c = this.compiler();
      c.given.set(op.input, this.leafOne(c, frame));
      const r = c.op(op);
      return { frame: r.frame, stmt: this.stmt(c, { kind: 'query', plan: r.plan, columns: r.frame.types.map((type, i) => ({ name: `c${i}`, type })) }, frame) };
    });
  }

  /** An operation that passes rows on as they come: run on each row, its rows passed on before the next row's. */
  private perRow(op: Op & { input: Op }, input: Stream): Stream {
    return {
      frame: this.overOne(op, 'rows', op, input.frame).frame,
      run: (sink) =>
        input.run((row) => {
          // Asked for at each row: an earlier row's write may have added a label or a type (`site`).
          for (const out of this.run(this.overOne(op, 'rows', op, input.frame).stmt, row)) if (!sink([...out])) return false;
          return true;
        }),
    };
  }

  /** An operation that reads all its input first (EAGER, ORDER BY, aggregates): all of it, then one query. */
  private allRows(op: Op & { input: Op }, input: Stream): Stream {
    return {
      frame: this.overOne(op, 'rows', op, input.frame).frame,
      run: (sink) => {
        const rows: Row[] = [];
        input.run((row) => (rows.push(row), true));
        // One row: the statement kept for a row. More, or none: one query with their values written in it.
        let outs: Row[];
        if (rows.length === 1) outs = this.run(this.overOne(op, 'rows', op, input.frame).stmt, rows[0]!).map((out) => [...out]);
        else {
          const { c, r } = this.over(op, input.frame, rows);
          outs = this.rowsOf(c, r);
        }
        for (const out of outs) if (!sink(out)) return false;
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
    // A node's or relationship's properties are read from its table below: the rows' own are not sent.
    const live = liveProps(frame);
    const columns = frame.types.map((t, i) => (live.has(i) ? rows.map(() => null) : rows.map((r) => (t === 'any' ? [r[i] ?? null] : (r[i] ?? null)))));
    return this.leafOver({ op: 'values', rows: [], types, columns } as unknown as PlanOp, frame, results);
  }

  /**
   * One row the runner holds as a plan, its values the statement's parameters (`rowParam`): what `leaf` makes of one
   * row, for a statement that is kept and run with each row.
   */
  private leafOne(c: Compiler, frame: Frame, results = false): Rel {
    if (frame.types.length === 0) return { plan: ONE_ROW, frame };
    const types = frame.types.map((t) => (t === 'any' ? 'list<any>' : t));
    const live = liveProps(frame);
    const row = types.map((t, i) => (live.has(i) ? lit(null, t) : this.rowParam(c, i, t)));
    return this.leafOver({ op: 'values', rows: [row], types } as PlanOp, frame, results);
  }

  /** `values` (the rows' columns) as the frame's columns: each node's and relationship's properties read from its table. */
  private leafOver(values: PlanOp, frame: Frame, results: boolean): Rel {
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

  /**
   * An expression's value for one row. Its statement is kept for `role` of `anchor`: the part of the plan the
   * expression belongs to (a SET item, a DELETE, a pattern's node). What keeps a statement is read with rows of one
   * frame, the one the statement was made for: an expression read with rows of two (a pattern's property map, before
   * and after the pattern's nodes are in the row) is kept under a role for each.
   */
  private evaluate(anchor: unknown, role: string, frame: Frame, row: Row, x: Expr): Value {
    if (x.k === 'lit') return { k: 'value', v: x.v };
    if (x.k === 'param') {
      if (!(x.name in this.params)) throw new SmaltcyError('SMALTCY_PARAM', `Missing parameter $${x.name}`);
      return { k: 'value', v: this.params[x.name] ?? null };
    }
    const kept = this.site(anchor, role, () => {
      const c = this.compiler();
      const leaf = this.leafOne(c, frame);
      const v = c.expr(x, leaf.frame);
      const [exprs, types] = columnsOf(v);
      return { v, stmt: this.stmt(c, { kind: 'query', plan: project(leaf.plan, exprs), columns: types.map((type, i) => ({ name: `c${i}`, type })) }, frame) };
    });
    return decode(kept.v, this.run(kept.stmt, row)[0]!);
  }

  /** An expression's value for each of the rows, as one query (one row: `evaluate`, by the statement kept for it). */
  private evaluateAll(anchor: unknown, role: string, frame: Frame, rows: readonly Row[], x: Expr): Value[] {
    if (!rows.length) return [];
    if (x.k === 'lit' || x.k === 'param' || rows.length === 1) return rows.map((row) => this.evaluate(anchor, role, frame, row, x));
    const c = this.compiler();
    const leaf = this.leaf(frame, rows);
    const v = c.expr(x, leaf.frame);
    const [exprs, types] = columnsOf(v);
    return this.exec(c, { kind: 'query', plan: project(leaf.plan, exprs), columns: types.map((type, i) => ({ name: `c${i}`, type })) }).map((out) => decode(v, out));
  }

  /** `propertyMap` for each of the rows: a map literal's entries evaluated for all of them in one query. */
  private propertyMaps(anchor: unknown, frame: Frame, rows: readonly Row[], x: Expr, what: string): { props: Props; nulls: string[]; isMap: boolean }[] {
    if (x.k !== 'map' || rows.length < 2) return rows.map((row) => this.propertyMap(anchor, 'props', frame, row, x, what));
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

  /**
   * A map literal's entries when each is a written value or a parameter (`plain` for the map) holding NULL, a boolean,
   * a string or a number: their values, with no query. Undefined when one holds anything else (a list, a map, a
   * parameter that wasn't given): the query then gives the value, or the error, it always gave.
   */
  private plainEntries(entries: readonly (readonly [string, Expr])[]): Record<string, Value> | undefined {
    const raw: Record<string, Value> = {};
    for (const [k, e] of entries) {
      let v: unknown;
      if (e.k === 'lit') v = e.v;
      else if (e.k === 'param' && e.name in this.params) v = this.params[e.name];
      else return undefined;
      if (!(v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number')) return undefined;
      raw[k] = { k: 'value', v };
    }
    return raw;
  }

  /**
   * A property map's entries (a map literal's evaluated together, a parameter's or a node's as they are), NULLs
   * dropped. Its statement is kept for `role` of `anchor`: the pattern's node or relationship, or the SET item, the
   * map belongs to (`evaluate`).
   */
  private propertyMap(anchor: unknown, role: string, frame: Frame, row: Row, x: Expr, what: string): { props: Props; nulls: string[]; isMap: boolean } {
    let raw: Record<string, Value>;
    let isMap = true;
    // A map whose every entry is a value written in the statement or a parameter's is read here, as `evaluate` reads one.
    const plain = x.k === 'map' && this.site(x, 'plain', () => x.entries.every(([, e]) => e.k === 'lit' || e.k === 'param')) ? this.plainEntries(x.entries) : undefined;
    if (plain !== undefined) raw = plain;
    else if (x.k === 'map') {
      const kept = this.site(anchor, role, () => {
        const c = this.compiler();
        const leaf = this.leafOne(c, frame);
        const vals = x.entries.map(([, e]) => c.expr(e, leaf.frame));
        const cols = vals.map(columnsOf);
        const statement: PlanStatementInput = { kind: 'query', plan: project(leaf.plan, cols.flatMap(([e]) => e)), columns: cols.flatMap(([, t]) => t).map((type, i) => ({ name: `c${i}`, type })) };
        return { vals, widths: cols.map(([, t]) => t.length), stmt: vals.length ? this.stmt(c, statement, frame) : null };
      });
      const out = kept.stmt ? this.run(kept.stmt, row)[0]! : [];
      const entries: Record<string, Value> = {};
      let at = 0;
      x.entries.forEach(([k], i) => {
        const n = kept.widths[i]!;
        entries[k] = decode(kept.vals[i]!, out.slice(at, at + n));
        at += n;
      });
      raw = entries;
    } else {
      const v = this.evaluate(anchor, role, frame, row, x);
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
    const nodeProps = created.map((n) => (n.props ? this.propertyMaps(n, inFrame, rows, n.props, 'CREATE').map((m) => m.props) : rows.map((): Props => ({}))));
    const relProps = p.rels.map((r) => (r.props ? this.propertyMaps(r, inFrame, rows, r.props, 'CREATE').map((m) => m.props) : rows.map((): Props => ({}))));
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
    this.appendRows(this.tables().nodes, ['int', PROPS], [node.ids, node.props], [0, 1]);
    this.appendRows(this.tables().labels, ['int', 'text'], [labels.ids, labels.labels], [0, 1]);
    rels.forEach((t, k) => this.appendRows(relTables[k]!, ['int', 'int', 'int', PROPS], [t.rowids, t.starts, t.ends, t.props], [-1, 0, 1, 2]));
    return outRows;
  }

  /**
   * MERGE, as smaltcy's engine runs it: for each row, every match of the whole pattern (each through ON MATCH, then
   * passed on), or, when there is none, the pattern created (its unbound nodes and its relationships), through ON
   * CREATE. A row sees what earlier rows created.
   */
  private merge(op: Extract<Op, { op: 'merge' }>, input: Stream, batch = false): Stream {
    const match: Extract<Op, { op: 'match' }> = { op: 'match', input: op.input, pattern: op.pattern, optional: false };
    const frame = this.overOne(op, 'match', match, input.frame).frame;
    if (batch) return this.batched(input, (rows) => this.mergeRows(op, match, input.frame, frame, rows), frame);
    return {
      frame,
      run: (sink) =>
        input.run((row) => {
          const found = this.run(this.overOne(op, 'match', match, input.frame).stmt, row).map((f) => [...f]);
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
    const maps = n.props ? this.propertyMaps(n, inFrame, rows, n.props, 'MERGE') : rows.map(() => ({ props: {} as Props, nulls: [] as string[], isMap: true }));
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
      const props = n.props ? this.propertyMap(n, 'props, row by row', out, next, n.props, 'CREATE').props : {};
      const id = this.newNodeId();
      this.appendRow(this.tables().nodes, ['int', PROPS], [id, props], [0, 1]);
      for (const l of new Set(n.labels)) this.appendRow(this.tables().labels, ['int', 'text'], [id, l], [0, 1]);
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
      const props = r.props ? this.propertyMap(r, 'props, row by row', out, next, r.props, 'CREATE').props : {};
      const rowid = this.newRelId();
      this.appendRow(table, ['int', 'int', 'int', PROPS], [rowid, start, end, props], [-1, 0, 1, 2]);
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

  /** Appends one row to a table: a statement kept for the table, the row's values its parameters. */
  private appendRow(table: string, types: readonly PlanType[], row: readonly unknown[], into: readonly number[]): void {
    const kept = this.site(table, 'append', () => {
      const input = { op: 'values', rows: [types.map((t, k) => own(k, t))], types } as PlanOp;
      return this.ownStmt(write({ op: 'append', table, db: 'main', input, columns: into, upserts: [] }), types.length);
    });
    this.run(kept, null, row);
  }

  /** Appends rows given as columns: one row by the statement kept for it, more as one statement with their values in it. */
  private appendRows(table: string, types: readonly PlanType[], columns: readonly (readonly unknown[])[], into: readonly number[]): void {
    const n = columns[0]!.length;
    if (n === 1) this.appendRow(table, types, columns.map((c) => c[0]), into);
    else if (n > 1) this.db.queryPlan(this.append(table, types, columns, into));
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
    // The table's own largest is its last row. Its past versions hold the rowid as a column: those are scanned.
    const one = (plan: PlanOp): PlanStatementInput => ({ kind: 'query', plan, columns: [{ name: 'c0', type: 'int' }] });
    const last = this.run(this.site(table, 'last', () => this.ownStmt(one(lastOf(scan(table, [column]))), 0)), null)[0];
    let max = last ? (last[0] as number) : -1;
    const past: [string, number][] = [];
    if (this.t0.history === 'versions') past.push([`smalt_versions_${table}`, 0]);
    if (this.t0.history === 'log') past.push([`smalt_log_${table}`, 2]);
    for (const [t, c] of past) {
      const m = this.run(this.site(t, 'max', () => this.ownStmt(one(maxOf(scan(t, [c]))), 0)), null)[0]![0] as number | null;
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
    this.grown ??= { ...this.t0, labelTables: this.labelTables, types: this.types };
    // What is kept was made for the graph's tables as they were: the rest of this run makes its statements anew.
    this.sites = null;
    return table;
  }

  /** A relationship type's edge table: the type added to the graph if it hasn't it yet. */
  private type(t: string): string {
    const known = this.types.get(t);
    if (known) return known;
    const table = `${this.t0.graph}_t${this.types.size}`;
    this.db.queryPlan({ kind: 'schema', op: { op: 'alterPropertyGraph', name: this.t0.graph, action: { kind: 'addType', type: t, table } } } as PlanStatementInput);
    this.types.set(t, table);
    this.grown ??= { ...this.t0, labelTables: this.labelTables, types: this.types };
    this.sites = null;
    return table;
  }

  // SET and REMOVE.

  private setItems(items: readonly SetItem[], frame: Frame, row: Row): void {
    for (const it of items) {
      // The target first: a NULL target is a no-op, its value not computed (as in smaltcy's engine).
      const t = this.evaluate(it, 'target', frame, row, it.target);
      if (isNullValue(t)) continue;
      switch (it.kind) {
        case 'prop': {
          const target = this.entity(t, "Can't set a property on a");
          const v = this.evaluate(it, 'value', frame, row, it.value);
          if (v.k === 'value' && v.v === null) this.setProps(it, 'unset', it.key, target, 1, without(target.props, [it.key]));
          else {
            const value = propertyValue(v, 'SET');
            this.setProps(it, 'set', it.key, target, 1, { ...without(target.props, [it.key]), [it.key]: value }, value);
          }
          break;
        }
        case 'props': {
          const target = this.entity(t, "Can't set a property on a");
          const { props, nulls, isMap } = this.propertyMap(it, 'value', frame, row, it.value, 'SET');
          if (target.props === null) break;
          if (!it.merge) {
            // Every property the map hasn't is removed, then the map's set.
            const removed = Object.keys(target.props).filter((k) => !(k in props)).length;
            this.setProps(it, 'replace', null, target, removed + Object.keys(props).length, props, props, PROPS);
          } else {
            // With +=, a NULL in the map removes the key.
            const gone = isMap ? nulls : [];
            this.setProps(it, 'merge', null, target, gone.length + Object.keys(props).length, { ...without(target.props, gone), ...props }, props, PROPS, gone);
          }
          break;
        }
        case 'labels': {
          if (t.k !== 'node') throw new SmaltcyError('SMALTCY_TYPE', `Can't set labels on a ${valueTypeName(t)}`);
          for (const l of it.labels) {
            if (this.hasLabel(t.id!, l)) continue;
            this.label(l);
            this.appendRow(this.tables().labels, ['int', 'text'], [t.id, l], [0, 1]);
            this.counts.labelsAdded++;
          }
          break;
        }
      }
    }
  }

  private removeItems(items: readonly RemoveItem[], frame: Frame, row: Row): void {
    for (const it of items) {
      const t = this.evaluate(it, 'target', frame, row, it.target);
      if (isNullValue(t)) continue;
      if (it.kind === 'prop') {
        const target = this.entity(t, "Can't set a property on a");
        this.setProps(it, 'unset', it.key, target, 1, without(target.props, [it.key]));
        continue;
      }
      if (t.k !== 'node') throw new SmaltcyError('SMALTCY_TYPE', `Can't remove labels from a ${valueTypeName(t)}`);
      for (const l of it.labels) {
        if (!this.hasLabel(t.id!, l)) continue;
        const labels = this.tables().labels;
        const kept = this.site(labels, `drop:${l}`, () => {
          const entries = filter(scan(labels, [-1, 0, 1]), and(eq(colRef(1, 'int'), own(0, 'int')), eq(colRef(2, 'text'), lit(l, 'text'))));
          return this.ownStmt(write({ op: 'delete', table: labels, db: 'main', input: entries, rowid: 0 }), 1);
        });
        this.run(kept, null, [t.id]);
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
      if (!this.deleting) {
        this.setPropRows(it, frame, live);
        continue;
      }
      const targets = this.evaluateAll(it, 'target', frame, live, it.target);
      const values = 'value' in it ? this.evaluateAll(it, 'value', frame, live, it.value) : null;
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
        // map_merge keeps the second map's value of a key both have: the key is set without removing it first.
        if (w.rowids.length) this.updateProps(table, w.column, w.rowids, w.given, (cur, g) => call('map_merge', [cur, call('map_of', [lit(it.key), g], PROPS)], PROPS));
      }
    }
    return rows;
  }

  /**
   * One property set (or removed) on the targets of rows that hold them, in a statement that deletes nothing (so each
   * is there): its values read for all rows, then one update per table. Every row counts one property set, as
   * smaltcy's engine counts.
   */
  private setPropRows(it: Extract<SetItem | RemoveItem, { kind: 'prop' }>, frame: Frame, rows: readonly Row[]): void {
    const b = frame.slots.get((it.target as { i: number }).i)!;
    const values = 'value' in it ? this.evaluateAll(it, 'value', frame, rows, it.value) : null;
    const writes = new Map<string, { column: number; rowids: number[]; given: unknown[]; removed: number[] }>();
    rows.forEach((row, i) => {
      const [table, column, rowid] = b.k === 'node' ? [this.tables().nodes, 1, row[b.id] as number] : [this.types.get(row[(b as Extract<Binding, { k: 'rel' }>).type] as string)!, 2, row[(b as Extract<Binding, { k: 'rel' }>).rowid] as number];
      const v = values?.[i];
      const gone = !v || (v.k === 'value' && v.v === null);
      let w = writes.get(table);
      if (!w) writes.set(table, (w = { column, rowids: [], given: [], removed: [] }));
      if (gone) w.removed.push(rowid);
      else {
        w.rowids.push(rowid);
        w.given.push(propertyValue(v, 'SET'));
      }
      this.counts.propertiesSet++;
    });
    // With history, a row the write leaves as it was is not written: it would be a version that changes nothing.
    // Without, writing it changes nothing anyone sees, and comparing would cost more than writing.
    const changedOnly = this.t0.history !== undefined;
    for (const [table, w] of writes) {
      if (w.removed.length) this.updateProps(table, w.column, w.removed, null, (cur) => removeKeys(cur, [it.key]), changedOnly);
      // map_merge keeps the second map's value of a key both have: the key is set without removing it first.
      if (w.rowids.length) this.updateProps(table, w.column, w.rowids, w.given, (cur, g) => call('map_merge', [cur, call('map_of', [lit(it.key), g], PROPS)], PROPS), changedOnly);
    }
  }

  /**
   * Sets a property map column of the rows `rowids` of a table to `f` of what it is and of `given` (one per row); with
   * `changedOnly`, only the rows that changes.
   */
  private updateProps(table: string, column: number, rowids: readonly number[], given: readonly unknown[] | null, f: (cur: PlanExpr, given: PlanExpr) => PlanExpr, changedOnly = false): void {
    // A value of `any` crosses as a one-element `list<any>`, which keeps its kind (smaltdb ADR 0039).
    const values = { op: 'values', rows: [], types: given ? ['int', 'list<any>'] : ['int'], columns: given ? [rowids, given.map((g) => [g])] : [rowids] } as unknown as PlanOp;
    const g = given ? call('list_get', [colRef(3, 'list<any>'), lit(0)], 'any') : NULL;
    const value = f(colRef(1, PROPS), g);
    const match = eq(colRef(0, 'int'), colRef(2, 'int'));
    // An UPDATE's input is its join region, so the comparison computes the new properties a second time.
    const input = filter({ op: 'join', kind: 'cross', inputs: [scan(table, [-1, column]), values] }, changedOnly ? and(match, call('cmp_is_not', [value, colRef(1, PROPS)], 'bool')) : match);
    this.db.queryPlan(write({ op: 'update', table, db: 'main', input, rowid: 0, sets: [{ column, value }], from: true }));
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
    const labels = this.tables().labels;
    const kept = this.site(labels, `has:${l}`, () => {
      const entries = filter(scan(labels, [0, 1]), and(eq(colRef(0, 'int'), own(0, 'int')), eq(colRef(1, 'text'), lit(l, 'text'))));
      return this.ownStmt({ kind: 'query', plan: project(ONE_ROW, [exists(entries)]), columns: [{ name: 'c0', type: 'bool' }] }, 1);
    });
    return this.run(kept, null, [id])[0]![0] === true;
  }

  /** A node or relationship whose properties are set: its table, rowid and properties (NULL: it's gone). */
  private entity(t: Value, message: string): { table: string; column: number; rowid: number; props: Props | null } {
    if (t.k === 'node') return { table: this.tables().nodes, column: 1, rowid: t.id!, props: t.props };
    if (t.k === 'rel') return { table: this.types.get(t.type!)!, column: 2, rowid: t.rowid!, props: t.props };
    throw new SmaltcyError('SMALTCY_TYPE', `${message} ${valueTypeName(t)}`);
  }

  /**
   * Sets a node's or relationship's properties from what they are (in the table) and `given` (a value given from
   * here, `any` or `type`), counting `count` properties set; nothing when it's gone, as in smaltcy's engine. `how`:
   * `set` sets the key `key` to `given`, `unset` removes it, `replace` makes them `given` (a map), and `merge` removes
   * the keys `gone`, then sets `given`'s (a map's). `next` is what they become: when it is what they are, nothing is
   * written (smaltcy's history records no change). The statement is kept for `anchor` (the SET or REMOVE item) and the
   * table: the row's rowid, `given` and `gone` are its parameters.
   */
  private setProps(anchor: unknown, how: 'set' | 'unset' | 'replace' | 'merge', key: string | null, e: { table: string; column: number; rowid: number; props: Props | null }, count: number, next: Props | null, given: unknown = null, type: PlanType = 'any', gone: readonly string[] = []): void {
    if (e.props === null) return;
    if (next !== null && sameProps(e.props, next)) {
      this.counts.propertiesSet += count;
      return;
    }
    // A value of `any` crosses as a one-element `list<any>`, which keeps its kind (smaltdb ADR 0039).
    const wrapped = type === 'any';
    const kept = this.site(anchor, `${how}:${e.table}`, () => {
      const values = { op: 'values', rows: [[own(1, wrapped ? 'list<any>' : type)]], types: [wrapped ? 'list<any>' : type] } as PlanOp;
      // The target joined with the value (smaltdb's UPDATE … FROM shape: the WHERE over the join).
      const input = filter({ op: 'join', kind: 'cross', inputs: [scan(e.table, [-1, e.column]), values], ordered: true }, eq(colRef(0, 'int'), own(0, 'int')));
      const g = wrapped ? call('list_get', [colRef(2, 'list<any>'), lit(0)], 'any') : colRef(2, type);
      const cur = colRef(1, PROPS);
      // map_merge keeps the second map's value of a key both have: the key is set without removing it first.
      const value =
        how === 'set' ? call('map_merge', [cur, call('map_of', [lit(key), g], PROPS)], PROPS)
        : how === 'unset' ? removeKeys(cur, [key!])
        : how === 'replace' ? g
        : call('map_merge', [call('map_remove', [cur, own(2, 'list<text>')], PROPS), g], PROPS);
      return this.ownStmt(write({ op: 'update', table: e.table, db: 'main', input, rowid: 0, sets: [{ column: e.column, value }], from: true }), how === 'merge' ? 3 : 2);
    });
    this.run(kept, null, [e.rowid, wrapped ? [given] : given, gone]);
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
    // A few of them: each by the statements kept for one (`deleteRel`, `deleteWhere`), which seek it by its id. The
    // statements below hold the ids and are planned each time, and smaltdb joins a list of ids with an edge table's
    // ends by reading the whole table where an end has many relationships on average.
    let few = nodes.size;
    for (const rowids of rels.values()) few += rowids.size;
    if (few <= FEW) {
      for (const [type, rowids] of rels) for (const rowid of rowids) this.deleteRel(type, rowid);
      for (const id of nodes) {
        // A self-loop starts and ends here: the second delete finds it gone.
        for (const table of this.types.values()) this.counts.relationshipsDeleted += this.deleteWhere(table, [-1, 0, 1], 1, id) + this.deleteWhere(table, [-1, 0, 1], 2, id);
        this.counts.nodesDeleted += this.deleteWhere(this.tables().nodes, [0], 0, id);
      }
      return rows;
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
    this.counts.relationshipsDeleted += this.deleteWhere(this.types.get(type)!, [-1], 0, rowid);
  }

  /**
   * Deletes the rows of a table whose column `column` (of `columns`, the first of them the rowid) is `value`: how many
   * there were. A statement kept for the table, `value` its parameter.
   */
  private deleteWhere(table: string, columns: readonly number[], column: number, value: number): number {
    const kept = this.site(table, `delete:${columns.join()}:${column}`, () => {
      const input = filter(scan(table, columns), eq(colRef(column, 'int'), own(0, 'int')));
      return this.ownStmt(write({ op: 'delete', table, db: 'main', input, rowid: 0, returning: [lit(1)] }), 1);
    });
    return this.run(kept, null, [value]).length;
  }

  /** Deletes the rows of `input` (column 0 their rowid): how many there were. */
  private deleted(table: string, input: PlanOp): number {
    return this.db.queryPlan(write({ op: 'delete', table, db: 'main', input, rowid: 0, returning: [lit(1)] })).rows.length;
  }

  private deleteNode(id: number, detach: boolean): void {
    const nodes = this.tables().nodes;
    const tables = [...this.types.values()];
    // Whether it is there, and whether a relationship starts or ends at it: one statement kept, the id its parameter.
    const state = this.site(nodes, 'state', () => {
      const node = filter(scan(nodes, [0]), eq(colRef(0, 'int'), own(0, 'int')));
      // Each end on its own, so each is a seek on the edge table's index (an OR of the two would scan the table).
      const touching = (table: string, end: 1 | 2) => filter(scan(table, [-1, 0, 1]), eq(colRef(end, 'int'), own(0, 'int')));
      const ends = tables.flatMap((t) => [exists(touching(t, 1)), exists(touching(t, 2))]);
      return this.ownStmt({ kind: 'query', plan: project(ONE_ROW, [exists(node), ends.length ? or(...ends) : lit(false)]), columns: [{ name: 'c0', type: 'bool' }, { name: 'c1', type: 'bool' }] }, 1);
    });
    const [here, connected] = this.run(state, null, [id])[0]!;
    if (here !== true) return;
    if (connected === true) {
      if (!detach) throw new SmaltcyError('SMALTCY_CONSTRAINT', `Cannot delete node ${id}: it still has relationships (use DETACH DELETE)`);
      // A self-loop starts and ends here: the second delete finds it gone.
      for (const t of tables) this.counts.relationshipsDeleted += this.deleteWhere(t, [-1, 0, 1], 1, id) + this.deleteWhere(t, [-1, 0, 1], 2, id);
    }
    // Its entries in the label index go with it (smaltdb's rules on a graph's tables).
    this.deleteWhere(nodes, [0], 0, id);
    this.counts.nodesDeleted++;
  }
}

/** The columns of a frame that hold a node's or a relationship's properties: read from its table, not sent with a row. */
function liveProps(frame: Frame): Set<number> {
  const live = new Set<number>();
  for (const b of frame.slots.values()) if (b.k === 'node' || b.k === 'rel') live.add(b.props);
  return live;
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

