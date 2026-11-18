/**
 * smaltcy's graph plans compiled to smaltdb plans (ADR 0004; smaltdb ADR 0033, step 8), beside smaltcy's own engine.
 * The compiler keeps Cypher's meaning where smaltdb's differs (smaltdb ADR 0033, decision 13): comparisons across
 * kinds, booleans apart from integers, checking division, NULLs last in ORDER BY, Cypher's order of kinds.
 *
 * What it can't compile yet it refuses with an `Unsupported` error that names it, never a plan that would give a
 * different answer. Where only the values a query reads show that it can't keep Cypher's meaning (a list compared with
 * `<`, a string added to a list), the plan raises an error when it meets them: a smaltdb error whose message starts
 * with `smaltcy:`.
 *
 * Plans are built as plain data: smaltdb is not a runtime dependency of smaltcy yet, so this module imports its types
 * only. A node in a row is two columns, its id and its `props` map; any other value is one column with a static type.
 */
import type { plan, PlanColumn, PlanStatementInput } from 'smaltdb/engine';
import { SmaltcyError } from '../errors.js';
import type { Expr } from '../plan/expr.js';
import type { AggCall, GraphPlan, Op, Pattern, Projection, SortKey } from '../plan/ops.js';
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
}

/** Compiles a graph plan (a query that reads) to a smaltdb query statement. */
export function compileQuery(gp: GraphPlan, tables: GraphTables, options: CompileOptions = {}): CompiledQuery {
  if (gp.kind !== 'query') return unsupported('index plans');
  if (gp.asOf) unsupported('AT VERSION and AT TIME');
  const c = new Compiler(tables, options.params ?? {});
  const { plan: root, frame } = c.op(gp.root);
  const exprs: PlanExpr[] = [];
  const columns: PlanColumn[] = [];
  for (const col of gp.columns) {
    const b = frame.slots.get(col.slot);
    if (!b) unsupported(`a result column (${col.name}) that isn't bound`);
    if (b!.k === 'node') unsupported('nodes in results');
    const v = b as ValueBinding;
    exprs.push(colRef(v.col, v.type));
    columns.push({ name: col.name, type: v.type });
  }
  return {
    statement: { kind: 'query', plan: { op: 'project', input: root, exprs }, columns },
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
type Binding = ValueBinding | NodeBinding;

/** The columns of a plan's rows, and the slots they hold. */
interface Frame {
  readonly types: readonly PlanType[];
  readonly slots: ReadonlyMap<number, Binding>;
}

interface Rel {
  readonly plan: PlanOp;
  readonly frame: Frame;
}

/** An expression's value: a typed value, or a node (its id and props). */
type Val = { readonly k: 'value'; readonly e: PlanExpr; readonly t: PlanType } | { readonly k: 'node'; readonly id: PlanExpr; readonly props: PlanExpr };

const PROPS: PlanType = 'map<text, any>';

// Expression builders: plain data, as smaltdb's `plan` builders make them.

const colRef = (index: number, type: PlanType, depth = 0): PlanExpr => ({ k: 'col', input: 0, index, depth, type, collation: 'binary' });
function lit(value: unknown, type?: PlanType): PlanExpr {
  if (typeof value === 'boolean') return { k: 'lit', value: value ? 1 : 0, type: 'bool' };
  const t = type ?? (value === null ? 'null' : typeof value === 'number' ? (Number.isSafeInteger(value) ? 'int' : 'real') : typeof value === 'string' ? 'text' : unsupported(`a literal ${JSON.stringify(value)}`));
  return { k: 'lit', value: value as never, type: t };
}
/** A literal and its type. */
function literal(v: unknown): Val {
  const e = lit(v);
  return { k: 'value', e, t: (e as { type: PlanType }).type };
}
const call = (fn: string, args: readonly PlanExpr[], type: PlanType): PlanExpr => ({ k: 'call', fn, args, type });
const and = (...args: PlanExpr[]): PlanExpr => (args.length === 1 ? args[0]! : { k: 'and', args });
const or = (...args: PlanExpr[]): PlanExpr => (args.length === 1 ? args[0]! : { k: 'or', args });
const not = (arg: PlanExpr): PlanExpr => ({ k: 'not', arg });
const isNull = (arg: PlanExpr): PlanExpr => ({ k: 'isNull', arg, not: false });
const isNotNull = (arg: PlanExpr): PlanExpr => ({ k: 'isNull', arg, not: true });
const caseWhen = (whens: readonly (readonly [PlanExpr, PlanExpr])[], otherwise: PlanExpr, type: PlanType): PlanExpr => ({ k: 'case', whens: whens.map(([when, then]) => ({ when, then })), else: otherwise, type });
const eq = (a: PlanExpr, b: PlanExpr) => call('cmp_eq', [a, b], 'bool');
const NULL = lit(null);
const TRUE = lit(true);
const FALSE = lit(false);
const INFINITY: PlanExpr = { k: 'lit', value: Infinity, type: 'real' };

/**
 * An error raised when a row reaches it: what a plan does with values whose Cypher meaning it can't keep yet. smaltdb
 * has no function that raises a message, so this is a strict conversion of the message to an integer, which fails
 * with it (SMALT_MISMATCH: `cannot convert text "smaltcy: …" to an integer`).
 */
const raise = (message: string): PlanExpr => call('cast_integer_strict', [lit(`smaltcy: ${message}`)], 'int');

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

class Compiler {
  readonly paramNames: string[] = [];
  /** The list elements in scope (`[x IN list …]`, `any(x IN list …)`), innermost last: what their slots read. */
  private readonly elements: { readonly slot: number; readonly type: PlanType }[] = [];

  constructor(
    private readonly t: GraphTables,
    private readonly params: Readonly<Record<string, unknown>>,
  ) {}

  // Operations.

  op(op: Op): Rel {
    switch (op.op) {
      case 'argument':
        if (op.slots.length) unsupported('nested plans (EXISTS, pattern comprehensions)');
        return { plan: { op: 'values', rows: [[]], types: [] }, frame: { types: [], slots: new Map() } };
      case 'eager':
        return this.op(op.input);
      case 'match':
        return this.match(op);
      case 'filter': {
        const r = this.op(op.input);
        return { plan: { op: 'filter', input: r.plan, pred: this.predicate(op.pred, r.frame, 'WHERE') }, frame: r.frame };
      }
      case 'project':
        return this.project(this.op(op.input), op.items, op.discard);
      case 'aggregate':
        return this.aggregate(this.op(op.input), op.keys, op.aggs);
      case 'distinct': {
        const r = this.op(op.input);
        const on = op.slots.map((s) => this.keyColumn(r.frame, s));
        return { plan: { op: 'distinct', input: r.plan, collations: r.frame.types.map(() => 'binary'), on, keep: 'first', ordered: 'first' }, frame: r.frame };
      }
      case 'sort': {
        // The keys are computed into columns first, and dropped after: smaltdb's planner (at the pinned commit) fails
        // on a sort key that is an expression rather than a column.
        const r = this.op(op.input);
        const keys = op.keys.flatMap((k) => this.sortKeys(k, r.frame));
        const cols = r.frame.types.map((t, i) => colRef(i, t));
        const width = cols.length;
        const input: PlanOp = { op: 'project', input: r.plan, exprs: [...cols, ...keys.map((k) => k.expr)] };
        const sorted: PlanOp = { op: 'sort', input, keys: keys.map((k, i) => ({ ...k, expr: colRef(width + i, 'any') })) };
        return { plan: { op: 'project', input: sorted, exprs: cols }, frame: r.frame };
      }
      case 'limit': {
        const r = this.op(op.input);
        const count = op.count ? this.count(op.count, 'LIMIT') : lit(-1);
        return { plan: { op: 'limit', input: r.plan, count, ...(op.skip ? { offset: this.count(op.skip, 'SKIP') } : {}) }, frame: r.frame };
      }
      case 'unwind':
        return this.unwind(this.op(op.input), op.list, op.slot);
      case 'union':
        return this.union(op);
      case 'create': case 'merge': case 'set': case 'remove': case 'delete':
        return unsupported(`writes (${op.op.toUpperCase()})`);
    }
  }

  /** Every match of a pattern of nodes, for each input row: the input joined with the node table, in order. */
  private match(op: Extract<Op, { op: 'match' }>): Rel {
    if (op.optional) unsupported('OPTIONAL MATCH');
    const p: Pattern = op.pattern;
    if (p.rels.length) unsupported('relationship patterns');
    if (p.paths?.length) unsupported('named paths');
    let { plan, frame } = this.op(op.input);
    const conds: PlanExpr[] = [];
    for (const n of p.nodes) {
      const bound = frame.slots.get(n.slot);
      if (bound && bound.k !== 'node') unsupported('a node pattern on a variable that holds a value');
      const b = bound as NodeBinding | undefined;
      if (!b) {
        // A new node: every node with the labels (semi-joins on the label index, in the node table's order).
        let src: PlanOp = { op: 'scan', table: this.t.nodes, columns: [0, 1] };
        for (const l of n.labels) {
          const entries: PlanOp = { op: 'filter', input: { op: 'scan', table: this.t.labels, columns: [0, 1] }, pred: eq({ k: 'col', input: 0, index: 1, depth: 0, type: 'text', collation: 'binary' }, lit(l)) };
          src = { op: 'join', kind: 'semi', inputs: [src, entries], on: eq({ k: 'col', input: 0, index: 0, depth: 0, type: 'int', collation: 'binary' }, { k: 'col', input: 1, index: 0, depth: 0, type: 'int', collation: 'binary' }), ordered: true };
        }
        plan = { op: 'join', kind: 'cross', inputs: [plan, src], ordered: true };
        const id = frame.types.length;
        const slots = new Map(frame.slots).set(n.slot, { k: 'node', id, props: id + 1 });
        frame = { types: [...frame.types, 'int', PROPS], slots };
      } else if (n.labels.length) {
        conds.push(this.hasLabels(colRef(b.id, 'int'), n.labels));
      }
      if (n.props) conds.push(this.propsMatch(n.slot, n.props, frame));
    }
    if (op.where) conds.push(this.predicate(op.where, frame, 'WHERE'));
    if (conds.length) plan = { op: 'filter', input: plan, pred: and(...conds) };
    return { plan, frame };
  }

  /** A pattern's property map: each key equals its value (Cypher's `=`, true). */
  private propsMatch(slot: number, props: Expr, frame: Frame): PlanExpr {
    if (props.k !== 'map') return unsupported('a pattern property map given as a parameter');
    const node = frame.slots.get(slot) as NodeBinding;
    const conds = props.entries.map(([key, x]) => this.equals({ k: 'value', e: call('map_get', [colRef(node.props, PROPS), lit(key)], 'any'), t: 'any' }, this.expr(x, frame)));
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
      } else {
        slots.set(slot, { k: 'value', col: exprs.length, type: v.t });
        exprs.push(v.e);
        types.push(v.t);
      }
    }
    return { plan: { op: 'project', input: r.plan, exprs }, frame: { types, slots } };
  }

  private aggregate(r: Rel, keys: readonly Projection[], aggs: readonly AggCall[]): Rel {
    const keyExprs: { expr: PlanExpr; collation: 'binary' }[] = [];
    const carry: PlanExpr[] = [];
    const types: PlanType[] = [];
    const slots = new Map<number, Binding>();
    const carried: { slot: number; props: PlanExpr }[] = [];
    for (const k of keys) {
      const v = this.expr(k.expr, r.frame);
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
    const post: { slot: number; e: (col: number) => PlanExpr; t: PlanType }[] = [];
    const calls: plan.AggCall[] = [];
    for (const a of aggs) {
      const { call: c, post: fix, type } = this.aggCall(a, r.frame);
      const col = keyExprs.length + calls.length;
      calls.push(c);
      types.push(c.type);
      if (fix) post.push({ slot: a.slot, e: fix, t: type });
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
    let out: Rel = { plan: { op: 'aggregate', input: r.plan, keys: keyExprs, aggs: calls, carry, ordered: 'first' }, frame: { types, slots } };
    if (post.length) {
      // Results that need a step after the aggregate (collect's NULLs dropped, sum's 0 for no rows).
      const exprs = out.frame.types.map((t, i) => colRef(i, t));
      const ts = [...out.frame.types];
      const s = new Map(out.frame.slots);
      for (const p of post) {
        const b = s.get(p.slot) as ValueBinding;
        exprs[b.col] = p.e(b.col);
        ts[b.col] = p.t;
        s.set(p.slot, { k: 'value', col: b.col, type: p.t });
      }
      out = { plan: { op: 'project', input: out.plan, exprs }, frame: { types: ts, slots: s } };
    }
    return out;
  }

  /** An aggregate call, and the step after the aggregate its result needs (reading its column). */
  private aggCall(a: AggCall, frame: Frame): { call: plan.AggCall; post?: (col: number) => PlanExpr; type: PlanType } {
    const agg = (fn: string, args: readonly PlanExpr[], type: PlanType, star = false): plan.AggCall => ({ fn, args, star, distinct: a.distinct, collation: 'binary', type });
    if (a.fn === 'count' && a.args.length === 0) return { call: agg('count', [], 'int', true), type: 'int' };
    if (a.args.length !== 1) return unsupported(`${a.fn}() with ${a.args.length} arguments`);
    const v = this.expr(a.args[0]!, frame);
    if (a.fn === 'count') return { call: agg('count', [v.k === 'node' ? v.id : v.e], 'int'), type: 'int' };
    if (v.k === 'node') return unsupported(`${a.fn}() of nodes`);
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
        if (k !== undefined) return unsupported(`${a.fn}() of a ${v.t}`);
        // Mixed kinds: Cypher's order of kinds first (strings, booleans, numbers), then the value; NULLs skipped.
        const kind = caseWhen([[and(eq(kindExpr(v), lit(K_NUMBER)), isNaNExpr(v.e)), lit(K_NAN)]], this.orderKind(v), 'int');
        return { call: agg(a.fn === 'min' ? 'first' : 'last', [v.e, kind, v.e], 'any'), type: 'any' };
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
    return caseWhen([[isNull(v.e), NULL], [eq(kindExpr(v), lit(K_NUMBER)), v.e]], raise(`${what} takes numbers`), 'any');
  }

  /**
   * Values grouped or deduplicated: smaltdb compares lists and maps by their bytes, where Cypher compares their
   * elements (`[1] = [1.0]`), so they are refused when the type says they are lists or maps.
   */
  private groupable(t: PlanType, what: string): void {
    const k = staticKind(t);
    if (k === K_LIST || k === K_MAP || k === K_OTHER) unsupported(`${what} a ${t}`);
  }

  /** A column a slot is compared by in DISTINCT: a node's id. */
  private keyColumn(frame: Frame, slot: number): number {
    const b = frame.slots.get(slot) ?? unsupported('DISTINCT over an unbound slot');
    if (b.k === 'node') return b.id;
    this.groupable(b.type, 'DISTINCT over');
    return b.col;
  }

  /** ORDER BY in Cypher's order: kinds in order (strings, booleans, numbers, NaN, then NULL), then values. */
  private sortKeys(k: SortKey, frame: Frame): plan.SortKey[] {
    const v = this.expr(k.expr, frame);
    // Cypher's NULLs come last ascending and first descending: the order reversed.
    const key = (expr: PlanExpr): plan.SortKey => ({ expr, desc: k.desc, nullsFirst: k.desc, collation: 'binary' });
    if (v.k === 'node') return [key(v.id)];
    const kind = staticKind(v.t);
    if (kind === K_NUMBER) return mayBeNaN(v.t) ? [key(caseWhen([[isNull(v.e), NULL], [isNaNExpr(v.e), lit(1)]], lit(0), 'int')), key(v.e)] : [key(v.e)];
    if (kind === K_STRING || kind === K_BOOL || kind === K_NULL) return [key(v.e)];
    if (kind !== undefined) return unsupported(`ORDER BY a ${v.t}`);
    const order = caseWhen([[and(eq(kindExpr(v), lit(K_NUMBER)), isNaNExpr(v.e)), lit(K_NAN)]], this.orderKind(v), 'int');
    return [key(order), key(v.e)];
  }

  /** The kind's place in Cypher's order, NULL for NULL; lists and maps raise (smaltdb orders them by their bytes). */
  private orderKind(v: { e: PlanExpr; t: PlanType }): PlanExpr {
    const k = kindExpr(v);
    return caseWhen(
      [
        [eq(k, lit(K_NULL)), NULL],
        [call('in_list', [k, lit(K_LIST), lit(K_MAP), lit(K_OTHER)], 'bool'), raise('ordering lists and maps')],
      ],
      k,
      'int',
    );
  }

  /** SKIP and LIMIT: a non-negative whole number, a literal or a parameter. */
  private count(x: Expr, what: string): PlanExpr {
    const value = x.k === 'lit' ? x.v : x.k === 'param' ? this.params[x.name] : unsupported(`${what} that isn't a literal or a parameter`);
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new SmaltcyError('SMALTCY_TYPE', `${what} must be a non-negative integer`);
    return (this.expr(x, { types: [], slots: new Map() }) as { e: PlanExpr }).e;
  }

  private unwind(r: Rel, list: Expr, slot: number): Rel {
    const v = this.expr(list, r.frame);
    if (v.k === 'node') return unsupported('UNWIND of a node');
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

  private union(op: Extract<Op, { op: 'union' }>): Rel {
    const branches = op.inputs.map((i) => this.op(i));
    const types: PlanType[] = [];
    op.slots.forEach((s, i) => {
      const bs = branches.map((b) => b.frame.slots.get(s) ?? unsupported('a UNION branch without a column'));
      if (bs.some((b) => b.k === 'node')) unsupported('nodes in results');
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
      plan = { op: 'distinct', input: plan, collations, ordered: 'first' };
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
    if (v.k === 'node') return unsupported(`${what} given a node`);
    const k = staticKind(v.t);
    if (k === K_BOOL || k === K_NULL) return v.e;
    if (k !== undefined) return unsupported(`${what} given a ${v.t}`);
    return caseWhen([[isNull(v.e), NULL], [eq(kindExpr(v), lit(K_BOOL)), call('any_bool', [v.e], 'bool')]], raise(`${what} must be a boolean`), 'bool');
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
          const type = this.elements[el]!.type;
          return value({ k: 'element', part: 'value', depth: this.elements.length - 1 - el, type }, type);
        }
        const b = frame.slots.get(x.i) ?? unsupported(`a slot that isn't bound (${x.i})`);
        if (b.k === 'node') return { k: 'node', id: colRef(b.id, 'int'), props: colRef(b.props, PROPS) };
        return value(colRef(b.col, b.type), b.type);
      }
      case 'prop': {
        const of = this.expr(x.of, frame);
        if (of.k === 'node') return value(call('map_get', [of.props, lit(x.key)], 'any'), 'any');
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
        if (vals.some(([, v]) => v.k === 'node')) unsupported('nodes in maps');
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
        const e = v.k === 'node' ? v.id : v.e;
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
        if (i.k === 'node') return unsupported('a node as an index');
        if (of.k === 'node') {
          if (i.t !== 'text') return unsupported('a node indexed by a value that may not be a string');
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
        const { list, elem } = this.listOf(x.list, frame, 'a list comprehension');
        let out: Val = { k: 'value', e: list, t: `list<${elem}>` };
        if (x.where) {
          const pred = this.inElement(x.slot, elem, () => this.predicate(x.where!, frame, 'WHERE'));
          out = { k: 'value', e: { k: 'each', mode: 'filter', list: out.e, body: pred, type: out.t }, t: out.t };
        }
        if (x.map) {
          const body = this.inElement(x.slot, elem, () => this.expr(x.map!, frame));
          if (body.k === 'node') return unsupported('a list comprehension giving nodes');
          if (staticKind(body.t) === K_OTHER) return unsupported(`a list comprehension giving a ${body.t}`);
          const t: PlanType = `list<${body.t === 'null' ? 'any' : body.t}>`;
          out = { k: 'value', e: { k: 'each', mode: 'map', list: out.e, body: body.e, type: t }, t };
        }
        return out;
      }
      case 'quantifier':
        return value(this.quantifier(x, frame), 'bool');
      case 'exists': return unsupported('EXISTS and pattern predicates');
      case 'collectSub': return unsupported('pattern comprehensions');
    }
  }

  /** A list to iterate over, and its elements' type: a list, or NULL. */
  private listOf(x: Expr, frame: Frame, what: string): { list: PlanExpr; elem: PlanType } {
    const v = this.expr(x, frame);
    if (v.k === 'node') return unsupported(`${what} over a node`);
    const k = staticKind(v.t);
    if (k === K_LIST) return { list: v.e, elem: v.t.slice(5, -1) as PlanType };
    if (k === K_NULL) return { list: { k: 'lit', value: null, type: 'list<any>' }, elem: 'any' };
    if (k !== undefined) return unsupported(`${what} over a ${v.t}`);
    // Known only when it runs: a list under any, NULL, or Cypher's type error.
    return { list: caseWhen([[isNull(v.e), NULL], [eq(kindExpr(v), lit(K_LIST)), call('any_list', [v.e], 'list<any>')]], call('list_of', [raise(`${what} takes a list`)], 'list<any>'), 'list<any>'), elem: 'any' };
  }

  /** Compiles `f` with `slot` reading the element of the innermost `each`. */
  private inElement<T>(slot: number, type: PlanType, f: () => T): T {
    this.elements.push({ slot, type });
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
    const { list, elem } = this.listOf(x.list, frame, `${x.q}()`);
    const pred = this.inElement(x.slot, elem, () => this.predicate(x.where, frame, `${x.q}()`));
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
    if (items.some((v) => v.k === 'node')) unsupported('lists of nodes');
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
    if (results.some((v) => v.k === 'node')) unsupported('CASE giving nodes');
    const t = commonType(results.map((v) => (v as { t: PlanType }).t)) ?? unsupported('CASE whose results are booleans or lists and values of other types');
    return { k: 'value', e: caseWhen(whens.map(([c, v]) => [c, (v as { e: PlanExpr }).e]), (otherwise as { e: PlanExpr }).e, t), t };
  }

  // Cypher's comparisons.

  /** `a = b`: NULL when either is NULL, false across kinds, numbers by value (NaN equals nothing). */
  private equals(a: Val, b: Val): PlanExpr {
    if (a.k === 'node' || b.k === 'node') {
      if (a.k === 'node' && b.k === 'node') return eq(a.id, b.id);
      return unsupported('comparing a node with a value');
    }
    return this.compareBy(a, b, 'equality', (x, y, kind) => {
      if (kind === K_NUMBER) return mayBeNaN(x.t) || mayBeNaN(y.t) ? and(eq(x.e, y.e), not(isNaNExpr(x.e))) : eq(x.e, y.e);
      if (kind === K_BOOL) return eq(asBoolValue(x), asBoolValue(y));
      return eq(x.e, y.e);
    }, FALSE);
  }

  /** `<` and the others: NULL across kinds and for NaN; strings by code unit order is smaltdb's UTF-8 byte order. */
  private ordering(fn: string, a: Val, b: Val): PlanExpr {
    if (a.k === 'node' || b.k === 'node') return unsupported('ordering comparisons of nodes');
    return this.compareBy(a, b, 'ordering', (x, y, kind) => {
      const c = (p: PlanExpr, q: PlanExpr) => call(fn, [p, q], 'bool');
      if (kind === K_NUMBER) return mayBeNaN(x.t) || mayBeNaN(y.t) ? caseWhen([[or(isNaNExpr(x.e), isNaNExpr(y.e)), NULL]], c(x.e, y.e), 'bool') : c(x.e, y.e);
      if (kind === K_BOOL) return c(asBoolValue(x), asBoolValue(y));
      return c(x.e, y.e);
    }, NULL);
  }

  /**
   * A comparison of two values by their kinds: `same` for two numbers, strings or booleans, `across` for values of
   * different kinds. Lists and maps, which smaltdb compares by their bytes, raise.
   */
  private compareBy(
    a: { e: PlanExpr; t: PlanType },
    b: { e: PlanExpr; t: PlanType },
    what: string,
    same: (a: { e: PlanExpr; t: PlanType }, b: { e: PlanExpr; t: PlanType }, kind: number) => PlanExpr,
    across: PlanExpr,
  ): PlanExpr {
    const ka = staticKind(a.t);
    const kb = staticKind(b.t);
    const comparable = (k: number) => k === K_NUMBER || k === K_STRING || k === K_BOOL;
    for (const k of [ka, kb]) if (k === K_LIST || k === K_MAP) unsupported(`${what} of lists and maps`);
    if (ka === K_NULL || kb === K_NULL) return NULL;
    if (ka !== undefined && kb !== undefined) {
      if (ka === kb && comparable(ka)) return same(a, b, ka);
      return caseWhen([[or(isNull(a.e), isNull(b.e)), NULL]], ka === kb ? NULL : across, 'bool');
    }
    // A kind is known only when the value is: compare by kind at run time.
    const kindA = ka !== undefined ? lit(ka) : kindExpr(a);
    const kindB = kb !== undefined ? lit(kb) : kindExpr(b);
    const kinds = [K_NUMBER, K_STRING, K_BOOL].filter((k) => (ka === undefined || ka === k) && (kb === undefined || kb === k));
    return caseWhen(
      [
        [or(isNull(a.e), isNull(b.e)), NULL],
        [not(eq(kindA, kindB)), across],
        [call('in_list', [kindA, lit(K_LIST), lit(K_MAP)], 'bool'), raise(`${what} of lists and maps`)],
        ...kinds.map((k) => [eq(kindA, lit(k)), same(a, b, k)] as const),
      ],
      NULL,
      'bool',
    );
  }

  // Functions.

  private call(fn: string, args: readonly Expr[], frame: Frame): Val {
    const value = (e: PlanExpr, t: PlanType): Val => ({ k: 'value', e, t });
    const vals = () => args.map((a) => this.expr(a, frame));
    const values = () => vals().map((v) => (v.k === 'node' ? unsupported(`${fn}() of a node`) : v));
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
        return value(call('neg', [this.number(a!, '-')], isNumberType(a!.t) ? a!.t : 'any'), isNumberType(a!.t) ? a!.t : 'any');
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
        if (a!.k !== 'node') return unsupported('id() of a value that is not a node');
        return value(a!.id, 'int');
      }
      case 'labels': {
        const [a] = vals();
        if (a!.k !== 'node') return unsupported('labels() of a value that is not a node');
        return value(this.labelsOf(a!.id), 'list<text>');
      }
      case 'properties': {
        const [a] = vals();
        if (a!.k !== 'node') return unsupported('properties() of a value that is not a node');
        return value(a!.props, PROPS);
      }
      case 'keys':
        // A map keeps its keys sorted; smaltcy's keys() gives a node's in the order they were set.
        return unsupported('keys() (a smaltdb map keeps its keys sorted)');
      case 'size': {
        const [a] = values() as { e: PlanExpr; t: PlanType }[];
        const k = staticKind(a!.t);
        if (k === K_STRING) return value(call('length', [a!.e], 'int'), 'int');
        if (k === K_LIST) return value(call('list_len', [a!.e], 'int'), 'int');
        if (k === K_NULL) return value(NULL, 'null');
        if (k === undefined) {
          return value(
            caseWhen(
              [
                [isNull(a!.e), NULL],
                [eq(kindExpr(a!), lit(K_STRING)), call('length', [a!.e], 'int')],
                [eq(kindExpr(a!), lit(K_LIST)), call('list_len', [call('any_list', [a!.e], 'list<any>')], 'int')],
              ],
              raise('size() takes a string or a list'),
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
      default:
        return unsupported(`the function ${fn}()`);
    }
  }

  /** A value that must be a number: anything else (but NULL) is Cypher's type error. */
  private number(v: { e: PlanExpr; t: PlanType }, what: string): PlanExpr {
    const k = staticKind(v.t);
    if (k === K_NUMBER || k === K_NULL) return v.e;
    if (k !== undefined) return unsupported(`${what} of a ${v.t}`);
    return caseWhen([[isNull(v.e), NULL], [eq(kindExpr(v), lit(K_NUMBER)), v.e]], raise(`${what} takes numbers`), 'any');
  }

  /** A value that must be a string. */
  private string(v: { e: PlanExpr; t: PlanType }, what: string): PlanExpr {
    const k = staticKind(v.t);
    if (k === K_STRING || k === K_NULL) return v.e;
    if (k !== undefined) return unsupported(`${what} of a ${v.t}`);
    return caseWhen([[isNull(v.e), NULL], [eq(kindExpr(v), lit(K_STRING)), v.e]], raise(`${what} takes strings`), 'any');
  }

  /**
   * Arithmetic with Cypher's meaning: integers stay integers (64-bit: overflow is an error, smaltdb's checked
   * operations), division of two integers truncates and by zero is an error, `+` joins two strings.
   */
  private arithmetic(fn: string, [a, b]: { e: PlanExpr; t: PlanType }[]): Val {
    const ka = staticKind(a!.t);
    const kb = staticKind(b!.t);
    if (ka === K_NULL || kb === K_NULL) return { k: 'value', e: NULL, t: 'null' };
    if (fn === 'add' && ka === K_STRING && kb === K_STRING) return { k: 'value', e: call('text_concat', [a!.e, b!.e], 'text'), t: 'text' };
    const known = ka !== undefined && kb !== undefined;
    if (known && (ka !== K_NUMBER || kb !== K_NUMBER)) return unsupported(`${fn} of a ${a!.t} and a ${b!.t}`);
    const t: PlanType = known ? (a!.t === b!.t ? a!.t : 'num') : 'any';
    const numeric = (x: PlanExpr, y: PlanExpr): PlanExpr => {
      const bothInt = (p: PlanExpr, q: PlanExpr): PlanExpr =>
        known ? (a!.t === 'int' && b!.t === 'int' ? TRUE : a!.t === 'real' || b!.t === 'real' ? FALSE : intTest(p, q)) : intTest(p, q);
      const intTest = (p: PlanExpr, q: PlanExpr) => and(eq(call('any_type', [p], 'text'), lit('int')), eq(call('any_type', [q], 'text'), lit('int')));
      const zeroCheck = (op: string): PlanExpr =>
        caseWhen([[and(bothInt(x, y), eq(y, lit(0))), raise('division by zero')], [bothInt(x, y), call(op, [x, y], 'int')]], fn === 'mod' ? raise('% of floats') : call('div_float', [x, y], 'real'), t === 'int' ? 'int' : t);
      switch (fn) {
        case 'add': return call('add_checked', [x, y], t);
        case 'sub': return call('sub_checked', [x, y], t);
        case 'mul': return call('mul_checked', [x, y], t);
        case 'div_float': return call('div_float', [x, y], 'real');
        case 'div': return zeroCheck('div_trunc');
        default: return zeroCheck('mod_trunc');
      }
    };
    const rt: PlanType = fn === 'div_float' ? 'real' : t;
    if (known) return { k: 'value', e: numeric(a!.e, b!.e), t: rt };
    // Known only at run time: numbers, or for + two strings; NULL gives NULL.
    const kindA = ka !== undefined ? lit(ka) : kindExpr(a!);
    const kindB = kb !== undefined ? lit(kb) : kindExpr(b!);
    const whens: [PlanExpr, PlanExpr][] = [
      [or(isNull(a!.e), isNull(b!.e)), NULL],
      [and(eq(kindA, lit(K_NUMBER)), eq(kindB, lit(K_NUMBER))), numeric(a!.e, b!.e)],
    ];
    if (fn === 'add') whens.push([and(eq(kindA, lit(K_STRING)), eq(kindB, lit(K_STRING))), call('text_concat', [a!.e, b!.e], 'text')]);
    return { k: 'value', e: caseWhen(whens, raise(`${fn} of these values`), 'any'), t: 'any' };
  }
}
