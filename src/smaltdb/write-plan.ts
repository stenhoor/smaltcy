/**
 * Cypher statements that write, compiled to one smaltdb plan (smaltdb ADR 0042, step 3): smaltdb runs the plan.
 *
 * The plan's writes are smaltdb's graph operations (`graphCreate`, `graphSet`, `graphDelete`, `graphMerge`). smaltdb
 * gives each its input's rows one at a time, each through every operation above it before the next, so a write sees
 * what earlier rows wrote; `eager` says where everything below must be done first. What the plan says, besides the
 * writes:
 *
 * - **Entities are read when they are needed.** A row holds a node's id and a relationship's type and rowid. An
 *   operation above a write that reads more than its row's values gets the properties of its row's nodes and
 *   relationships read from their tables first (`live`), and a write's own expression that reads them, or what the
 *   write made for the row, reads them when its row's turn comes (`whenRead`). Where nothing does, the plan reads
 *   nothing: smaltdb may then write all the rows of a write in one pass.
 * - **Results are read once the statement is done:** an `eager`, then the rows' nodes, relationships and paths as
 *   they are then.
 * - **New labels and types** are named here, with the tables smaltdb makes for them when a row first needs them, so
 *   what the plan reads after a write names those tables.
 * - **Cypher's own errors** (a relationship to NULL, a value that can't be a property) are expressions that raise
 *   when a row reaches them, as in a read.
 * - **After a DELETE,** a write that smaltcy's engine fails on for a node or relationship the statement has deleted
 *   raises its error ("Node 4 does not exist"): labels set or removed, properties replaced (`SET n = …`), and a node
 *   or relationship given as a property map. The plan looks whether it is still there when the row's turn comes, and
 *   only in a statement where a DELETE comes first. A relationship to a deleted node is smaltdb's error, which
 *   `runOnSmaltdb` words as smaltcy's.
 */
import type { plan, PlanStatementInput } from 'smaltdb/engine';
import { SmaltcyError } from '../errors.js';
import { forEachChild, slotsRead, type Expr } from '../plan/expr.js';
import { exprsOf, type GraphPlan, type Op, type Pattern, type RemoveItem, type SetItem } from '../plan/ops.js';
import { NODE_LABEL, type GraphTables } from './schema.js';
import {
  and, bindVars, call, caseWhen, colRef, Compiler, eachAggOf, eq, HOP, HOPS, isNull, lit, message, moveBinding, NULL, paramsRead, PROPS, raise,
  refuseWhenMet, typeNameExpr, Unsupported, type Binding, type CompiledQuery, type Frame, type Rel, type Val,
} from './compile.js';

type PlanOp = plan.PlanOp;
type PlanExpr = plan.PlanExpr;
type PlanType = plan.PlanType;
type NodeBinding = Extract<Binding, { k: 'node' }>;
type RelBinding = Extract<Binding, { k: 'rel' }>;

const refuse = (feature: string): never => {
  throw new Unsupported(feature);
};

const WRITES = new Set(['create', 'merge', 'set', 'remove', 'delete']);
/** Operations that read all their rows before passing any on. */
const BARRIERS = new Set(['eager', 'sort', 'aggregate', 'distinct']);

const scan = (table: string, columns: readonly number[]): PlanOp => ({ op: 'scan', table, columns });
const filter = (input: PlanOp, pred: PlanExpr): PlanOp => ({ op: 'filter', input, pred });
const project = (input: PlanOp, exprs: readonly PlanExpr[]): PlanOp => ({ op: 'project', input, exprs });
const eager = (input: PlanOp): PlanOp => ({ op: 'eager', input }) as unknown as PlanOp;
const scalar = (p: PlanOp, type: PlanType): PlanExpr => ({ k: 'subquery', mode: 'scalar', plan: p, type, collation: 'binary' });
const isNotNull = (arg: PlanExpr): PlanExpr => ({ k: 'isNull', arg, not: true });
const EMPTY: PlanExpr = call('map_of', [], PROPS);

/** The first id a `graphMerge` takes for the row its match reads: past the ids the compiler gives its `iterate`s. */
const MERGE_IDS = 1_000_000;

/** A node or relationship the plan's graph writes name. */
type Target = { node: PlanExpr } | { relationship: { type: PlanExpr; id: PlanExpr } };

/** smaltcy's names for what a value is, in its error messages. */
const KIND_NAME = { node: 'NODE', rel: 'RELATIONSHIP', rels: 'LIST', path: 'PATH', nodes: 'LIST' } as const;

/**
 * A write compiled to smaltdb: the statement, its result columns and parameters, and the labels and types it names
 * that the graph hasn't, each with the table smaltdb makes for it when a row first needs it.
 */
export interface CompiledWrite extends CompiledQuery {
  readonly named: { readonly labels: readonly (readonly [string, string])[]; readonly types: readonly (readonly [string, string])[] };
}

/** `<prefix><n>`, `n` one more than the highest among the tables named so. */
function nextTable(prefix: string, tables: ReadonlyMap<string, string>): string {
  let next = 0;
  for (const t of tables.values()) {
    const digits = t.startsWith(prefix) ? t.slice(prefix.length) : '';
    const n = digits !== '' && [...digits].every((c) => c >= '0' && c <= '9') ? Number(digits) : -1;
    if (n >= next) next = n + 1;
  }
  return `${prefix}${next}`;
}

/**
 * A Cypher statement that writes, as one smaltdb statement. The plan is for parameters of the kinds given, as a
 * read's is (`CompileOptions.params`).
 */
export function compileWrite(gp: Extract<GraphPlan, { kind: 'query' }>, tables: GraphTables, params: Readonly<Record<string, unknown>> = {}): CompiledWrite {
  const w = new WriteCompiler(tables, params);
  const root = w.statement(gp);
  const statement = { kind: 'write', plan: root } as PlanStatementInput;
  return { statement, columns: gp.columns.map((col) => col.name), params: paramsRead(statement, w.c.paramNames), named: w.named() };
}

class WriteCompiler {
  readonly c: Compiler;
  private readonly labelTables: Map<string, string>;
  private readonly types: Map<string, string>;
  private readonly grown: GraphTables;
  private merges = 0;
  /** Whether a DELETE comes before the operation being compiled: its rows may name what the statement deleted. */
  private afterDelete = false;

  constructor(
    private readonly t0: GraphTables,
    private readonly params: Readonly<Record<string, unknown>>,
  ) {
    this.labelTables = new Map(t0.labelTables);
    this.types = new Map(t0.types);
    // One compiler for the statement, over tables that grow as its writes name labels and types: what is compiled
    // after a write reads the tables that write makes.
    this.grown = { ...t0, labelTables: this.labelTables, types: this.types };
    this.c = new Compiler(this.grown, params);
  }

  // The statement.

  statement(gp: Extract<GraphPlan, { kind: 'query' }>): PlanOp {
    const top = this.rel(gp.root, false, true);
    for (const col of gp.columns) {
      // smaltcy's engine gives a deleted node or relationship in a path or list as an empty one; smaltdb's lists drop it.
      const k = top.frame.slots.get(col.slot)?.k;
      if ((k === 'path' || k === 'rels' || k === 'nodes') && deletes(gp.root)) refuse(AFTER_DELETE_FEATURE);
    }
    // The results, read once everything is written: nodes, relationships and paths as they are at the end.
    const done: Rel = { plan: eager(top.plan), frame: top.frame };
    if (!gp.columns.length) return project(done.plan, []);
    const leaf = this.live(done, true);
    return project(
      leaf.plan,
      gp.columns.map((col) => {
        const b = leaf.frame.slots.get(col.slot) ?? refuse(`a result column (${col.name}) that isn't bound`);
        const v = this.c.valueOf(b);
        return v.k === 'value' ? v.e : this.c.resultValue(v).e;
      }),
    );
  }

  /**
   * An operation's rows. `above`: whether an operation above this one, before anything that reads all its input first,
   * writes. `quiet`: nothing above it, up to one that reads all its rows first, reads the graph, writes or stops early,
   * so a write here may write all its rows at once.
   */
  private rel(op: Op, above: boolean, quiet: boolean): Rel {
    // A part that writes nothing and reads what writes don't change (all of it first, or no graph) is one query: the
    // `eager` has smaltdb read all its rows before anything above it runs.
    if (!writes(op) && settled(op)) {
      const r = this.c.op(op);
      return { plan: eager(r.plan), frame: r.frame };
    }
    // A MATCH that writes nothing has an EAGER above it before any write (the binder's); one without would read for
    // each row what the writes above it wrote, which a join in a part of the plan that writes nothing does not say.
    if (op.op === 'match' && !writes(op)) return refuse('a MATCH that reads between the rows of a write');
    if (op.op !== 'delete' && op.op !== 'argument' && deletes(op) && readsDeleted(op)) refuse(AFTER_DELETE_FEATURE);
    const inputAbove = WRITES.has(op.op) || (above && op.op !== 'eager' && op.op !== 'sort' && op.op !== 'aggregate');
    const inputQuiet = BARRIERS.has(op.op) || (quiet && !touches(op));
    // Its rows are read before it writes, and nothing above it would tell them written one at a time from all at once.
    const batch = quiet && op.op !== 'argument' && op.op !== 'union' && settled((op as Op & { input: Op }).input);
    switch (op.op) {
      case 'argument':
        return op.slots.length ? refuse('a nested plan with writes') : this.c.op(op);
      case 'union':
        return refuse('UNION with writes');
      case 'filter': case 'project': case 'unwind': case 'match': case 'sort': case 'aggregate': case 'limit':
        return this.over(op, this.rel(op.input, inputAbove, inputQuiet));
      case 'distinct':
        // smaltcy's DISTINCT passes each row on as it comes: with writes on both sides, the order they run in matters.
        if (above) return refuse('DISTINCT between writes');
        return this.over(op, this.rel(op.input, inputAbove, inputQuiet));
      case 'eager': {
        const input = this.rel(op.input, inputAbove, inputQuiet);
        return { plan: eager(input.plan), frame: input.frame };
      }
      case 'create': {
        const input = this.rel(op.input, inputAbove, inputQuiet);
        this.afterDelete = deletes(op.input);
        return this.create(op.pattern, input, batch);
      }
      case 'merge': {
        const input = this.rel(op.input, inputAbove, inputQuiet);
        this.afterDelete = deletes(op.input);
        return this.merge(op, input, batch);
      }
      case 'set': case 'remove': {
        const input = this.rel(op.input, inputAbove, inputQuiet);
        this.afterDelete = deletes(op.input);
        const added: Added = [];
        const items = this.setItems(op.items, input.frame, op.op === 'remove', added);
        return { plan: { op: 'graphSet', graph: this.t0.graph, input: input.plan, items, ...(added.length ? { tables: added } : {}) } as unknown as PlanOp, frame: input.frame };
      }
      case 'delete': {
        const input = this.rel(op.input, inputAbove, inputQuiet);
        const targets = op.targets.map((t) => this.deleteTarget(t, input.frame));
        return { plan: { op: 'graphDelete', graph: this.t0.graph, input: input.plan, targets, detach: op.detach } as unknown as PlanOp, frame: input.frame };
      }
    }
  }

  /**
   * An operation above a write, over that write's rows. One that reads more than its row's values reads the row's
   * nodes and relationships as they are when the row reaches it.
   */
  private over(op: Op & { input: Op }, input: Rel): Rel {
    const plain = op.op !== 'match' && exprsOf(op).every(plainExpr);
    this.c.given.set(op.input, plain ? input : this.live(input));
    return this.c.op(op);
  }

  // Rows whose entities are read from their tables.

  /**
   * `r`'s rows with each node's and relationship's properties read from its table (a row holds what they were when it
   * was made, or nothing). With `results`, what a result gives for one the statement deleted.
   */
  private live(r: Rel, results = false): Rel {
    const frame = r.frame;
    if (![...frame.slots.values()].some((b) => b.k === 'node' || b.k === 'rel')) return r;
    const exprs = frame.types.map((t, i) => colRef(i, t));
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
    return { plan: project(r.plan, exprs), frame };
  }

  /** A node's properties, read from the node table (NULL when it's gone). */
  private nodeProps(id: PlanExpr): PlanExpr {
    const outer = { ...(id as Extract<PlanExpr, { k: 'col' }>), depth: 1 };
    return scalar(project(filter(scan(this.grown.nodes, [0, 1]), eq(colRef(0, 'int'), outer)), [colRef(1, PROPS)]), PROPS);
  }

  /** A relationship's properties, read from its type's edge table (NULL when it's gone). */
  private relProps(type: PlanExpr, rowid: PlanExpr): PlanExpr {
    const outer = { ...(rowid as Extract<PlanExpr, { k: 'col' }>), depth: 1 };
    const whens = [...this.types].map(([name, table]) => [eq(type, lit(name, 'text')), scalar(project(filter(scan(table, [-1, 2]), eq(colRef(0, 'int'), outer)), [colRef(1, PROPS)]), PROPS)] as const);
    return whens.length ? caseWhen(whens, NULL, PROPS) : NULL;
  }

  /** A node's id, read from the node table: NULL when the node is gone. `id` is a column of the row. */
  private nodeAt(id: PlanExpr): PlanExpr {
    if (id.k !== 'col') return refuse('a write that names a computed node after a DELETE');
    const outer = { ...id, depth: id.depth + 1 };
    return scalar(project(filter(scan(this.grown.nodes, [0]), eq(colRef(0, 'int'), outer)), [colRef(0, 'int')]), 'int');
  }

  /** A relationship's rowid, read from its type's edge table: NULL when the relationship is gone. */
  private relAt(type: PlanExpr, rowid: PlanExpr): PlanExpr {
    if (rowid.k !== 'col') return refuse('a write that names a computed relationship after a DELETE');
    const outer = { ...rowid, depth: rowid.depth + 1 };
    const whens = [...this.types].map(([name, table]) => [eq(type, lit(name, 'text')), scalar(project(filter(scan(table, [-1]), eq(colRef(0, 'int'), outer)), [colRef(0, 'int')]), 'int')] as const);
    return whens.length ? caseWhen(whens, lit(null, 'int'), 'int') : lit(null, 'int');
  }

  /**
   * `then` for a node or relationship that is there (`at`: its id read from its table), NULL for none (`id` is
   * NULL), and smaltcy's error for one the statement has deleted, as its stores raise it.
   */
  private thereOr(id: PlanExpr, at: PlanExpr, what: 'Node' | 'Relationship', then: PlanExpr, type: PlanType): PlanExpr {
    const gone = raise('SMALTCY_NOT_FOUND', message(`${what} `, call('cast_text', [id], 'text'), ' does not exist'), type);
    return caseWhen([[isNull(id), lit(null, type)], [isNull(at), gone]], then, type);
  }

  /**
   * `e`, an expression over a row of `frame`, as a write reads it. `row` gives the frame's columns from the write's
   * own row, one subquery out (a write's row is its input's columns, then the ids of what it has made so far).
   * Without `row` the frame's columns are the write's row. An expression that reads only columns the two share, and
   * no entity's properties and no nested plan, is read as it is; any other is read from the frame's row as it is when
   * the write's row has its turn, with every node's and relationship's properties read from their tables.
   */
  private whenRead(e: PlanExpr, type: PlanType, frame: Frame, row?: { shared: number; columns: readonly PlanExpr[] }): PlanExpr {
    const shared = row?.shared ?? frame.types.length;
    if (!readsBeyond(e, shared, liveProps(frame))) return e;
    const columns = row?.columns ?? frame.types.map((t, i) => colRef(i, t, 1));
    const leaf: Rel = { plan: { op: 'values', rows: [[...columns]], types: frame.types.map((t) => (t === 'null' ? 'any' : t)) }, frame };
    return scalar(project(this.live(leaf).plan, [e]), type === 'null' ? 'any' : type);
  }

  // Expressions.

  /**
   * A value a write is given over a row of `frame`: a property's value, a property map, a target. A parameter given
   * as the whole value keeps its kind: a list or a map is one (a read refuses them), and a boolean is a boolean in a
   * map of properties, where smaltdb reads a parameter as the number it is bound as.
   */
  private expr(x: Expr, frame: Frame): Val {
    if (x.k === 'param') {
      if (!(x.name in this.params)) throw new SmaltcyError('SMALTCY_PARAM', `Missing parameter $${x.name}`);
      const v = this.params[x.name];
      const param = (t: PlanType): PlanExpr => {
        let i = this.c.paramNames.indexOf(x.name);
        if (i < 0) i = this.c.paramNames.push(x.name) - 1;
        return { k: 'param', index: i, type: t };
      };
      if (typeof v === 'boolean') return { k: 'value', e: eq(param('bool'), lit(true)), t: 'bool' };
      if (v !== null && typeof v === 'object') {
        const t: PlanType = Array.isArray(v) ? 'list<any>' : PROPS;
        return { k: 'value', e: param(t), t };
      }
    }
    return this.c.expr(x, frame);
  }

  /**
   * A value a store can hold, as smaltcy's `toPropertyValue` checks it: no maps, and lists of plain values only. NULL
   * stays NULL. Its type is the value's own, so a boolean or a list is stored as one.
   */
  private propertyValue(v: Val, what: string): Typed {
    return bound(this.checked(v, what));
  }

  /** `propertyValue`, its checks of a list's elements not yet bound (`bindVars`): for one made inside another's check. */
  private checked(v: Val, what: string): Typed {
    if (v.k !== 'value') return { e: raise('SMALTCY_TYPE', `${what}: a property can't be a ${KIND_NAME[v.k]}`), t: 'any' };
    const map = raise('SMALTCY_TYPE', `${what}: a property can't be a MAP`);
    const list = raise('SMALTCY_TYPE', `${what}: a property list holds only strings, numbers and booleans`);
    const t = v.t;
    if (t.startsWith('map<')) return { e: caseWhen([[isNull(v.e), NULL]], map, 'any'), t: 'any' };
    if (t.startsWith('list<')) {
      const elem = t.slice(5, -1);
      if (elem === 'any') return { e: caseWhen([[holdsNested({ e: v.e, t }), list]], v.e, t), t };
      if (elem.startsWith('list<') || elem.startsWith('map<') || elem.startsWith('struct<')) return { e: caseWhen([[call('cmp_gt', [call('list_len', [call('list_drop_nulls', [v.e], t)], 'int'), lit(0)], 'bool'), list]], v.e, t), t };
      return { e: v.e, t };
    }
    if (t !== 'any') return { e: v.e, t };
    // Only the value knows: a map is refused, a list is checked as one.
    const kind = call('any_type', [v.e], 'text');
    const starts = (prefix: string) => call('starts_with', [kind, lit(prefix)], 'bool');
    return {
      e: caseWhen(
        [
          [isNull(v.e), NULL],
          [starts('map<'), map],
          [and(starts('list<'), holdsNested({ e: call('any_list', [v.e], 'list<any>'), t: 'list<any>' })), list],
        ],
        v.e,
        'any',
      ),
      t: 'any',
    };
  }

  /**
   * A property map: a map literal's entries each checked as a property (NULLs set no key, which smaltdb's writes
   * drop), a node's or relationship's properties, or a map value's entries.
   */
  private propertyMap(x: Expr, frame: Frame, what: string): Typed {
    if (x.k === 'map') {
      const values = this.entryValues(x, frame, what);
      // The map's type as smaltdb gives it: its values' one type, or `any` where they differ (a map of nothing: `any`).
      const known = [...new Set(values.map((v) => v.t).filter((t) => t !== 'null'))];
      const t: PlanType = `map<text, ${known.length === 1 ? known[0]! : 'any'}>`;
      return { e: call('map_of', x.entries.flatMap(([k], i) => [lit(k), values[i]!.e]), t), t };
    }
    const v = this.expr(x, frame);
    // A node's or a relationship's properties: smaltcy's error for one the statement has deleted.
    if (v.k === 'node') return { e: this.afterDelete ? this.thereOr(v.id, this.nodeAt(v.id), 'Node', v.props, PROPS) : v.props, t: PROPS };
    if (v.k === 'rel') return { e: this.afterDelete ? this.thereOr(v.rowid, this.relAt(v.type, v.rowid), 'Relationship', v.props, PROPS) : v.props, t: PROPS };
    const notMap = (name: PlanExpr | string) => raise('SMALTCY_TYPE', message(`${what}: properties must be a map, not `, name), PROPS);
    if (v.k !== 'value') return { e: notMap(KIND_NAME[v.k]), t: PROPS };
    if (v.t === 'null') return { e: NULL, t: 'null' };
    if (v.t.startsWith('map<')) return { e: this.checkedMap(v.e, v.t, what), t: v.t };
    if (v.t !== 'any') return { e: caseWhen([[isNull(v.e), NULL]], notMap(typeNameExpr(v)), PROPS), t: PROPS };
    const isMap = call('starts_with', [call('any_type', [v.e], 'text'), lit('map<')], 'bool');
    return { e: caseWhen([[isNull(v.e), NULL], [isMap, this.checkedMap(call('any_map', [v.e], PROPS), PROPS, what)]], notMap(typeNameExpr(v)), PROPS), t: PROPS };
  }

  /** A map literal's values, each checked as a property. */
  private entryValues(x: Extract<Expr, { k: 'map' }>, frame: Frame, what: string): Typed[] {
    // An entry that is a parameter holding a list or a map is refused, as the compiler refuses one in any expression.
    const entry = (e: Expr): Val => (e.k === 'param' && typeof this.params[e.name] !== 'boolean' ? this.c.expr(e, frame) : this.expr(e, frame));
    return x.entries.map(([, e]) => this.propertyValue(entry(e), what));
  }

  /** A map value as properties: each of its values checked as a property. */
  private checkedMap(m: PlanExpr, t: PlanType, what: string): PlanExpr {
    const elem = (t.slice(10, -1) === 'null' ? 'any' : t.slice(10, -1)) as PlanType;
    if (elem !== 'any' && !elem.startsWith('list<') && !elem.startsWith('map<')) return m;
    const values: Typed = { e: call('map_values', [m], `list<${elem}>`), t: `list<${elem}>` };
    const count = (pred: PlanExpr) => ({ fn: 'count', args: [], star: true, distinct: false, filter: pred, collation: 'binary' as const, type: 'int' as const });
    // Each value is checked as a property is: the check raises, or gives the value.
    const all = bindVars(eachAggOf(values, (el) => [count(isNotNull(this.checked({ k: 'value', e: el.e, t: el.t }, what).e))], (agg) => call('cmp_ge', [agg(0), lit(0)], 'bool'), 'bool'));
    return caseWhen([[all, m]], m, t);
  }

  // CREATE and MERGE.

  /**
   * A label a write may give a node: named for the graph, with the table smaltdb makes for it when a row first needs
   * it, if the graph hasn't it yet. Tables are numbered past the highest there is: a label a statement named and no
   * row needed leaves its number unused.
   */
  private label(l: string, added: Added): void {
    if (this.labelTables.has(l)) return;
    if (l === NODE_LABEL) refuse(`the label ${NODE_LABEL}, which is reserved`);
    const table = nextTable(`${this.t0.graph}_l`, this.labelTables);
    this.labelTables.set(l, table);
    added.push({ label: l, table });
  }

  private type(t: string, added: Added): void {
    if (this.types.has(t)) return;
    const table = nextTable(`${this.t0.graph}_t`, this.types);
    this.types.set(t, table);
    added.push({ type: t, table });
  }

  /** The labels and types the statement named that the graph hadn't, with their tables. */
  named(): { labels: [string, string][]; types: [string, string][] } {
    return { labels: [...this.labelTables].filter(([l]) => !this.t0.labelTables.has(l)), types: [...this.types].filter(([t]) => !this.t0.types.has(t)) };
  }

  /**
   * What a pattern makes for a row of `input`: its nodes that aren't bound and its relationships, as smaltdb's
   * `graphCreate` and `graphMerge` take them, and the columns of `out` (the row with the pattern's nodes,
   * relationships and paths in it) read from the write's own row. `early`: the properties read the input's rows as
   * they were read, which is how they are while the write runs (it is given all its rows first, and nothing above it
   * writes between them).
   */
  private made(p: Pattern, inFrame: Frame, out: Frame, early: boolean, added: Added): { nodes: unknown[]; relationships: unknown[]; shape: PlanExpr[]; invalid: PlanExpr | null } {
    const w = inFrame.types.length;
    const nodeOf = (slot: number) => out.slots.get(slot) as NodeBinding;
    // The pattern's nodes that are made, each once, in order.
    const created: Pattern['nodes'][number][] = [];
    for (const n of p.nodes) {
      const bound = inFrame.slots.get(n.slot);
      if (bound) {
        if (bound.k !== 'node') refuse('CREATE with a node held in a value');
        continue;
      }
      if (!created.some((c) => c.slot === n.slot)) created.push(n);
    }
    // A relationship that can't be made: an error once a row has its nodes, as smaltcy's engine raises it.
    let invalid: PlanExpr | null = null;
    const rels = p.rels.filter((r) => {
      const why = r.types.length !== 1 ? 'A relationship to create needs exactly one type' : r.dir === 'both' ? 'A relationship to create needs a direction' : r.min !== undefined ? "Can't create a variable-length relationship" : null;
      if (why !== null) invalid ??= raise('SMALTCY_SEMANTIC', why, 'bool');
      return why === null;
    });
    for (const n of created) for (const l of n.labels) this.label(l, added);
    for (const r of rels) this.type(r.types[0]!, added);
    const made = created.length + rels.length;
    // A node's id in the write's own row (`depth` 0), or one subquery out of it (`depth` 1): the input's column for
    // one that was bound, the column the write adds for one it makes, NULL until it is made.
    const nodeId = (slot: number, upTo: number, depth: number): PlanExpr => {
      const bound = inFrame.slots.get(slot) as NodeBinding | undefined;
      if (bound) return colRef(bound.id, 'int', depth);
      const k = created.findIndex((c) => c.slot === slot);
      return k < upTo ? colRef(w + k, 'int', depth) : lit(null, 'int');
    };
    const names = [...this.types.keys()];
    /** The columns of `out`, read from the write's row when the first `upTo` of what it makes are made. */
    const columns = (upTo: number, depth: number): PlanExpr[] => {
      const cols: PlanExpr[] = out.types.map((t, i) => (i < w ? colRef(i, t, depth) : lit(null, t === 'null' ? 'any' : t)));
      for (const n of created) cols[nodeOf(n.slot).id] = nodeId(n.slot, upTo, depth);
      const hops = new Map<number, PlanExpr>();
      p.rels.forEach((r) => {
        const b = out.slots.get(r.slot) as RelBinding | undefined;
        const j = rels.indexOf(r);
        if (!b || j < 0 || created.length + j >= upTo) return;
        const a = nodeId(p.nodes[r.from]!.slot, upTo, depth);
        const z = nodeId(p.nodes[r.to]!.slot, upTo, depth);
        const rowid = colRef(w + created.length + j, 'int', depth);
        cols[b.type] = lit(r.types[0]!, 'text');
        cols[b.rowid] = rowid;
        cols[b.start] = r.dir === 'out' ? a : z;
        cols[b.end] = r.dir === 'out' ? z : a;
        hops.set(r.slot, call('struct_of', [lit(names.indexOf(r.types[0]!)), rowid, a, z], HOP));
      });
      for (const path of p.paths ?? []) {
        const b = out.slots.get(path.slot);
        if (b?.k !== 'path' || upTo < made || path.rels.some((j) => !hops.has(p.rels[j]!.slot))) continue;
        cols[b.hops] = call('list_of', path.rels.map((j) => hops.get(p.rels[j]!.slot)!), HOPS);
      }
      return cols;
    };
    // Properties read the row as it is when their node or relationship is made: what was made before is in it.
    const props = (x: Expr | undefined, upTo: number): PlanExpr | undefined => {
      if (!x) return undefined;
      const m = this.propertyMap(x, out, 'CREATE');
      // Read as the input gave them where that is how they still are, and they read nothing the write makes.
      if (early && !readsBeyond(m.e, w, new Set())) return m.e;
      return this.whenRead(m.e, m.t, out, { shared: w, columns: columns(upTo, 1) });
    };
    const end = (slot: number): unknown => {
      const bound = inFrame.slots.get(slot) as NodeBinding | undefined;
      if (!bound) return { node: created.findIndex((c) => c.slot === slot) };
      const id = colRef(bound.id, 'int');
      return { id: caseWhen([[isNull(id), raise('SMALTCY_TYPE', "Can't create a relationship to NULL", 'int')]], id, 'int') };
    };
    const nodes = created.map((n, k) => {
      const m = props(n.props, k);
      return { labels: [...n.labels], ...(m ? { props: m } : {}) };
    });
    const relationships = rels.map((r, j) => {
      const [a, z] = [end(p.nodes[r.from]!.slot), end(p.nodes[r.to]!.slot)];
      const m = props(r.props, created.length + j);
      return { type: r.types[0]!, start: r.dir === 'out' ? a : z, end: r.dir === 'out' ? z : a, ...(m ? { props: m } : {}) };
    });
    return { nodes, relationships, shape: columns(made, 0), invalid };
  }

  /** Whether a CREATE's properties read no nested plan and nothing the pattern makes. */
  private readsOnlyInput(p: Pattern, inFrame: Frame): boolean {
    const props = [...p.nodes.filter((n) => !inFrame.slots.has(n.slot)), ...p.rels].flatMap((x) => (x.props ? [x.props] : []));
    return props.every((x) => !readsGraph(x) && [...slotsRead(x)].every((slot) => inFrame.slots.has(slot)));
  }

  private create(p: Pattern, input: Rel, batch: boolean): Rel {
    // The row with the pattern in it: its new nodes, relationships and paths after the input's columns.
    const types = [...input.frame.types];
    const slots = new Map(input.frame.slots);
    for (const n of p.nodes) {
      if (slots.has(n.slot)) continue;
      slots.set(n.slot, { k: 'node', id: types.length, props: types.length + 1 });
      types.push('int', PROPS);
    }
    for (const r of p.rels) {
      const at = types.length;
      slots.set(r.slot, { k: 'rel', type: at, rowid: at + 1, start: at + 2, end: at + 3, props: at + 4 });
      types.push('text', 'int', 'int', 'int', PROPS);
    }
    for (const path of p.paths ?? []) {
      const first = slots.get(p.nodes[path.nodes[0]!]!.slot) as NodeBinding;
      slots.set(path.slot, { k: 'path', start: first.id, hops: types.length });
      types.push(HOPS);
    }
    const frame: Frame = { types, slots };
    const added: Added = [];
    const m = this.made(p, input.frame, frame, batch && this.readsOnlyInput(p, input.frame), added);
    const op = { op: 'graphCreate', graph: this.t0.graph, input: input.plan, nodes: m.nodes, relationships: m.relationships, ...(added.length ? { tables: added } : {}) } as unknown as PlanOp;
    const shaped = project(op, m.shape);
    return { plan: m.invalid ? filter(shaped, m.invalid) : shaped, frame };
  }

  /**
   * MERGE, as smaltcy's engine runs it: for each row, every match of the whole pattern (each through ON MATCH), or,
   * when there is none, the pattern made (its unbound nodes and its relationships), through ON CREATE.
   */
  private merge(op: Extract<Op, { op: 'merge' }>, input: Rel, batch: boolean): Rel {
    const p = op.pattern;
    const w = input.frame.types.length;
    const added: Added = [];
    // The labels and types first: the match then reads the tables smaltdb makes for the new ones.
    for (const n of p.nodes) if (!input.frame.slots.has(n.slot)) for (const l of n.labels) this.label(l, added);
    for (const r of p.rels) if (r.types.length === 1 && r.dir !== 'both' && r.min === undefined) this.type(r.types[0]!, added);
    const id = MERGE_IDS + this.merges++;
    // The match reads the row as smaltdb gives it to it (`working`): its columns, its entities as they are then, and
    // after them the row's number, which each match gives back so that smaltdb knows whose it is.
    const numbered: Frame = { types: [...input.frame.types, 'int'], slots: input.frame.slots };
    const row: Rel = { plan: { op: 'working', id, types: numbered.types.map((t) => (t === 'null' ? 'any' : t)) } as PlanOp, frame: numbered };
    const match: Extract<Op, { op: 'match' }> = { op: 'match', input: op.input, pattern: p, optional: false };
    this.c.given.set(op.input, this.live(row));
    const found = this.c.op(match);
    this.c.given.delete(op.input);
    // The row with what the match adds: the match's columns without the number.
    const frame: Frame = {
      types: [...found.frame.types.slice(0, w), ...found.frame.types.slice(w + 1)],
      slots: new Map([...found.frame.slots].map(([slot, b]) => [slot, moveBinding(b, (col) => (col > w ? col - 1 : col))])),
    };
    const plain = !op.onCreate.length && !op.onMatch.length && this.readsOnlyInput(p, input.frame);
    const m = this.made(p, input.frame, frame, batch && plain, added);
    const merge = {
      op: 'graphMerge',
      graph: this.t0.graph,
      id,
      input: input.plan,
      // The row's number, then the columns the match adds to the row.
      match: project(found.plan, [colRef(w, 'int'), ...found.frame.types.slice(w + 1).map((t, i) => colRef(w + 1 + i, t))]),
      nodes: m.nodes,
      relationships: m.relationships,
      created: m.shape.slice(w),
      onMatch: this.setItems(op.onMatch, frame, false, added),
      onCreate: this.setItems(op.onCreate, frame, false, added),
      ...(added.length ? { tables: added } : {}),
      ...(batch && plain ? this.mergeKey(p, input.frame) : {}),
    } as unknown as PlanOp;
    return { plan: m.invalid ? filter(merge, m.invalid) : merge, frame };
  }

  /**
   * What lets smaltdb match all the rows of a MERGE at once (its `key`), where there is such a thing: one node, not
   * bound before, its properties a map of values that read only the row. Two rows with the same values match the same
   * nodes, and a row matches the node an earlier row made exactly when it has that row's values (a property that is
   * NULL matches nothing, and smaltdb matches the rows one by one when a key has one).
   */
  private mergeKey(p: Pattern, inFrame: Frame): { key?: PlanExpr[] } {
    const n = p.nodes[0]!;
    if (p.rels.length || p.nodes.length !== 1 || (p.paths ?? []).length || inFrame.slots.has(n.slot)) return {};
    if (!n.props) return { key: [] };
    return n.props.k === 'map' ? { key: this.entryValues(n.props, inFrame, 'MERGE').map((v) => v.e) } : {};
  }

  // SET, REMOVE and DELETE.

  /** What an item's or a DELETE's target names: a node, a relationship, or for anything else an error unless it is NULL. */
  private target(x: Expr, frame: Frame, cant: string): { v: Val; ref: Target } {
    const v = this.expr(x, frame);
    if (v.k === 'node') return { v, ref: { node: this.whenRead(v.id, 'int', frame) } };
    if (v.k === 'rel') return { v, ref: { relationship: { type: this.whenRead(v.type, 'text', frame), id: this.whenRead(v.rowid, 'int', frame) } } };
    const name = v.k === 'value' ? typeNameExpr(v) : KIND_NAME[v.k];
    const test = v.k === 'value' ? v.e : v.k === 'nodes' ? v.ids : v.hops;
    return { v, ref: { node: this.whenRead(caseWhen([[isNull(test), lit(null, 'int')]], raise('SMALTCY_TYPE', message(`${cant} `, name), 'int'), 'int'), 'int', frame) } };
  }

  private setItems(items: readonly (SetItem | RemoveItem)[], frame: Frame, remove: boolean, added: Added): unknown[] {
    return items.map((it) => {
      if (it.kind === 'labels') {
        const { v, ref } = this.target(it.target, frame, remove ? "Can't remove labels from a" : "Can't set labels on a");
        if (v.k === 'rel') {
          // A relationship has no labels: an error for one that is there.
          const id = (ref as { relationship: { id: PlanExpr } }).relationship.id;
          return { node: caseWhen([[isNull(id), lit(null, 'int')]], raise('SMALTCY_TYPE', `${remove ? "Can't remove labels from a" : "Can't set labels on a"} RELATIONSHIP`, 'int'), 'int'), kind: 'labels', add: [], remove: [] };
        }
        if (v.k !== 'node') return { ...ref, kind: 'labels', add: [], remove: [] };
        if (!remove) for (const l of it.labels) this.label(l, added);
        // smaltcy's stores fail on a label of a node that is gone.
        const node = this.afterDelete ? { node: this.whenRead(this.thereOr(v.id, this.nodeAt(v.id), 'Node', v.id, 'int'), 'int', frame) } : ref;
        return { ...node, kind: 'labels', add: remove ? [] : [...it.labels], remove: remove ? [...it.labels] : [] };
      }
      const { v: on, ref } = this.target(it.target, frame, "Can't set a property on a");
      if (it.kind === 'prop') {
        // REMOVE, and SET to NULL, take the key away.
        if (!('value' in it)) return { ...ref, kind: 'property', key: it.key, value: NULL };
        const v = this.propertyValue(this.expr(it.value, frame), 'SET');
        return { ...ref, kind: 'property', key: it.key, value: this.whenRead(v.e, v.t, frame) };
      }
      const m = this.propertyMap(it.value, frame, 'SET');
      // Replacing the properties reads the ones there are: smaltcy's stores fail on a node or relationship that is gone.
      let target: Target = ref;
      if (this.afterDelete && !it.merge && on.k === 'node') target = { node: this.whenRead(this.thereOr(on.id, this.nodeAt(on.id), 'Node', on.id, 'int'), 'int', frame) };
      if (this.afterDelete && !it.merge && on.k === 'rel') {
        target = { relationship: { type: this.whenRead(on.type, 'text', frame), id: this.whenRead(this.thereOr(on.rowid, this.relAt(on.type, on.rowid), 'Relationship', on.rowid, 'int'), 'int', frame) } };
      }
      return { ...target, kind: 'properties', value: this.whenRead(m.e, m.t, frame), merge: it.merge };
    });
  }

  private deleteTarget(x: Expr, frame: Frame): unknown {
    const v = this.expr(x, frame);
    switch (v.k) {
      case 'node': return { node: this.whenRead(v.id, 'int', frame) };
      case 'rel': return { relationship: { type: this.whenRead(v.type, 'text', frame), id: this.whenRead(v.rowid, 'int', frame) } };
      case 'rels': return { hops: this.whenRead(v.hops, HOPS, frame) };
      case 'nodes': return { nodes: this.whenRead(v.ids, 'list<int>', frame) };
      case 'path': return { path: { start: this.whenRead(v.start, 'int', frame), hops: this.whenRead(v.hops, HOPS, frame) } };
      case 'value': {
        // NULL deletes nothing; a list is refused; anything else is an error.
        const cant = raise('SMALTCY_TYPE', message("Can't delete a ", typeNameExpr(v)), 'int');
        const list = refuseWhenMet('DELETE of a list', 'int');
        const kind = call('any_type', [v.e], 'text');
        const other = v.t.startsWith('list<') ? list : v.t === 'any' ? caseWhen([[call('starts_with', [kind, lit('list<')], 'bool'), list]], cant, 'int') : cant;
        return { node: this.whenRead(caseWhen([[isNull(v.e), lit(null, 'int')]], other, 'int'), 'int', frame) };
      }
    }
  }
}

/** The tables named for the labels and types a write adds, in the order they are added. */
type Added = ({ label: string; table: string } | { type: string; table: string })[];

/** The columns of a frame that hold a node's or a relationship's properties. */
function liveProps(frame: Frame): Set<number> {
  const live = new Set<number>();
  for (const b of frame.slots.values()) if (b.k === 'node' || b.k === 'rel') live.add(b.props);
  return live;
}

/**
 * Whether an expression over a row reads a column at or past `shared`, one of `props`, or a nested plan (which reads
 * the graph, and the whole row through its leaf).
 */
function readsBeyond(e: unknown, shared: number, props: ReadonlySet<number>): boolean {
  if (e === null || typeof e !== 'object' || e instanceof Uint8Array) return false;
  if (Array.isArray(e)) return e.some((x) => readsBeyond(x, shared, props));
  const o = e as Record<string, unknown>;
  if (o.k === 'subquery' || o.k === 'inSubquery') return true;
  if (o.k === 'col') return o.depth === 0 && ((o.index as number) >= shared || props.has(o.index as number));
  return Object.values(o).some((x) => readsBeyond(x, shared, props));
}

type Typed = { readonly e: PlanExpr; readonly t: PlanType };

/** An expression with the variables of its `each` expressions bound (`bindVars`): once, when it is whole. */
const bound = (v: Typed): Typed => ({ e: bindVars(v.e), t: v.t });

/** Whether a list holds a list or a map: what a property list can't. Its `each` is not bound yet. */
function holdsNested(list: Typed): PlanExpr {
  const count = (pred: PlanExpr) => ({ fn: 'count', args: [], star: true, distinct: false, filter: pred, collation: 'binary' as const, type: 'int' as const });
  return eachAggOf(
    list,
    (el) => {
      const kind = call('any_type', [el.e], 'text');
      return [count(and(isNotNull(el.e), call('in_list', [call('substr', [kind, lit(1), lit(4)], 'text'), lit('list'), lit('map<')], 'bool')))];
    },
    (agg) => call('cmp_gt', [agg(0), lit(0)], 'bool'),
    'bool',
  );
}

/** Whether a plan writes (its operations, not the nested plans of its expressions, which only read). */
export function writes(op: Op): boolean {
  if (WRITES.has(op.op)) return true;
  if (op.op === 'argument') return false;
  if (op.op === 'union') return op.inputs.some(writes);
  return writes(op.input);
}

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
