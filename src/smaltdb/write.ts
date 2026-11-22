/**
 * Cypher statements run on smaltdb (ADR 0004; smaltdb ADR 0033, step 8, and ADR 0042, step 3).
 *
 * - **A statement is one smaltdb statement.** A query that only reads is one query (`compileQuery`); a statement that
 *   writes is one plan of smaltdb's graph writes (`compileWrite`, write-plan.ts), which smaltdb runs: its rows in
 *   order, each through every write before the next, so a write sees what earlier rows wrote.
 * - **Statements are kept by their shape** (shape.ts): what a statement compiles to is prepared once and run again by
 *   the next statement of the shape, with its own values.
 * - **All or nothing.** A statement is one statement to smaltdb, inside the caller's transaction if there is one: an
 *   error undoes everything it wrote, the new labels and types included. Given an author or a message, it runs in a
 *   transaction of its own, which carries them to its commit (`smalt_commits`).
 * - **History.** On a graph that keeps history, each commit that changes it is a version, numbered by its smaltdb
 *   commit id; a write that changes nothing (a property set to the value it has) writes nothing, so it makes none.
 * - **New labels and types** are added to the graph when a row first needs them: a statement no row of which reaches
 *   the write adds none. The reserved label `smaltcy:node` is refused. Labels and types are case-sensitive in smaltdb
 *   as in Cypher, and the tables made for them are numbered (`<graph>_l<k>`, `<graph>_t<k>`), so `Person` and `person`
 *   are two labels with a table each.
 * - **New ids** are smaltdb's: a node's is one more than the largest node id the graph has had, a relationship's rowid
 *   one more than the largest of any of its edge tables (so it is unique across types, and is its id). smaltdb keeps
 *   the next ids for the connection, so an id is not given again after a DELETE or a statement that failed, as in
 *   smaltcy's stores, nor while a past version holds it. (Which ids a statement that fails had taken by then can
 *   differ from smaltcy's: ADR 0004, known differences.)
 *
 * What can't be run as smaltcy's engine runs it is refused with `Unsupported`: when the statement is compiled where
 * the plan shows it, else when a row shows it (a DELETE of a list value), and smaltdb undoes what earlier rows wrote.
 * After a DELETE, the functions smaltcy's engine fails on for a deleted node or relationship (`labels()`, `type()` …)
 * are refused, where smaltdb would give a value.
 */
import type { plan, PlanStatementInput } from 'smaltdb/engine';
import { SmaltcyError } from '../errors.js';
import type { GraphPlan } from '../plan/ops.js';
import type { GraphTables } from './schema.js';
import { runByShape, writeByShape } from './shape.js';
import { asOfOf, call, colRef, compileQuery, eq, lastCommitOf, lit, noHistory, paramValues, PROPS, Unsupported, type AsOf } from './compile.js';
import { compileWrite, writes, type CompiledWrite } from './write-plan.js';

type PlanOp = plan.PlanOp;
type PlanExpr = plan.PlanExpr;

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

/** What a statement is run on: a smaltdb database's `Database.queryPlan` of `smaltdb/engine` (synchronous). */
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

export interface RunOptions {
  readonly params?: Readonly<Record<string, unknown>>;
  /**
   * The commit's author and message (smaltcy's `run(…, { author, message })`): the statement runs in a transaction
   * of its own, whose commit records them in `smalt_commits`. Refused inside an open transaction: its `begin` or
   * `commit` takes them.
   */
  readonly author?: string;
  readonly message?: string;
}

const SAVEPOINT = 'smaltcy_write';

export { writes };

/** What is kept for a write's shape: its compiled statement, prepared where the database prepares. */
interface KeptWrite {
  readonly w: CompiledWrite;
  readonly prepared: ReturnType<NonNullable<SmaltdbDatabase['preparePlan']>> | undefined;
}

/**
 * Runs a Cypher statement's graph plan on smaltdb, on the graph whose tables are `tables`: a query that only reads as
 * one query, a statement that writes as one plan. Returns its rows and what it wrote, and the tables as they are after
 * it (with the labels and types it added; the caller's `tables` are left as they were).
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
  // The statement with its values as parameters, and what is kept for its shape (shape.ts): one statement of a shape
  // and the next differ only in their parameters, so the plan is compiled, and prepared, once for the shape.
  const stated = writeByShape(db, gp, tables, params);
  let kept = stated.kept?.made as KeptWrite | undefined;
  if (!kept) {
    const compiled = compileWrite(stated.plan, tables, stated.params);
    kept = { w: compiled, prepared: stated.kept ? db.preparePlan?.(compiled.statement) : undefined };
    if (stated.kept) stated.kept.made = kept;
  }
  const w = kept.w;
  const bound = paramValues(w, stated.params);
  const transaction = (action: string, more: object = {}) => db.queryPlan({ kind: 'transaction', action, ...more } as PlanStatementInput);
  if (own) transaction('begin', { mode: 'deferred', ...(options.author !== undefined ? { author: options.author } : {}), ...(options.message !== undefined ? { message: options.message } : {}) });
  let out: { readonly rows: readonly (readonly unknown[])[]; readonly graph?: WriteCounts };
  try {
    out = (kept.prepared ? kept.prepared.result(bound as unknown as readonly never[]) : db.queryPlan(w.statement, bound)) as typeof out;
  } catch (e) {
    if (own) transaction('rollback');
    throw reworded(e);
  }
  if (own) transaction('commit');
  const version = tables.history && !db.inTransaction ? latestVersion(db) : undefined;
  return { columns: w.columns, rows: out.rows.map((r) => [...r]), counts: out.graph ?? emptyCounts(), tables: tablesAfter(db, tables, w.named), ...(version !== undefined ? { version } : {}) };
}

/**
 * smaltdb's errors for what a graph's rules refuse, as smaltcy's engine words them: a node that still has
 * relationships, and a relationship or a label for a node that is not there (one the statement has deleted: a row's
 * nodes are ones it matched or made).
 */
function reworded(e: unknown): unknown {
  const err = e as { code?: string; message?: string };
  if (err?.code !== 'SMALT_CONSTRAINT_FOREIGNKEY' || typeof err.message !== 'string') return e;
  const has = /can't delete node (-?\d+) of/.exec(err.message);
  if (has) return new SmaltcyError('SMALTCY_CONSTRAINT', `Cannot delete node ${has[1]}: it still has relationships (use DETACH DELETE)`);
  const gone = / = (-?\d+) is not a node of the graph$/.exec(err.message);
  return gone ? new SmaltcyError('SMALTCY_NOT_FOUND', `Node ${gone[1]} does not exist`) : e;
}

/**
 * The graph's tables after a statement that named labels or types the graph hadn't: with those a row needed, which
 * smaltdb added. The ones given, the same object, while none was.
 */
function tablesAfter(db: SmaltdbDatabase, tables: GraphTables, named: CompiledWrite['named']): GraphTables {
  // Whether smaltdb has the table: a statement no row of which reached the write made none.
  const there = (table: string): boolean => {
    try {
      db.queryPlan({ kind: 'query', plan: { op: 'limit', input: { op: 'scan', table, columns: [-1] }, count: lit(0) } } as PlanStatementInput);
      return true;
    } catch {
      return false;
    }
  };
  const labels = named.labels.filter(([, table]) => there(table));
  const types = named.types.filter(([, table]) => there(table));
  if (!labels.length && !types.length) return tables;
  return { ...tables, labelTables: new Map([...tables.labelTables, ...labels]), types: new Map([...tables.types, ...types]) };
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

const scan = (table: string, columns: readonly number[]): PlanOp => ({ op: 'scan', table, columns });
const filter = (input: PlanOp, pred: PlanExpr): PlanOp => ({ op: 'filter', input, pred });
const project = (input: PlanOp, exprs: readonly PlanExpr[]): PlanOp => ({ op: 'project', input, exprs });
