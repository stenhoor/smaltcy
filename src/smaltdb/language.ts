/**
 * PROTOTYPE (not for merge as it is): Cypher as a language registered with smaltdb (smaltdb ADR 0042, section 4).
 * smaltdb's entry points that take text take it by its name (`db.query(text, params, { language: 'cypher' })`), and
 * smaltdb keeps what a statement binds to: by its text, by its shape (its values taken out) and by the kinds of its
 * parameters' values.
 */
import { compile } from '../cypher/index.js';
import type { QueryPlan } from '../plan/ops.js';
import { compileQuery, paramKind } from './compile.js';
import { NODE_LABEL, type GraphTables } from './schema.js';
import { HOLE, holedPlan, statementShape } from './shape.js';
import { compileWrite, writes } from './write-plan.js';
import { indexStatement } from './write.js';

type Params = readonly unknown[] | Readonly<Record<string, unknown>> | undefined;
type Ctx = { catalog: { graphs(): unknown[]; graph(name: string): unknown } };

/** A graph of smaltdb's catalog as the compiler takes one: the database's only graph, or the one named. */
export function tablesOf(ctx: Ctx, graph: string | undefined): GraphTables {
  const all = ctx.catalog.graphs() as { name: string; nodes: { label: string; table: string }[]; edges: { type: string; table: string }[]; labels?: { table: string }; history?: 'versions' | 'log' }[];
  const g = graph === undefined ? (all.length === 1 ? all[0] : undefined) : all.find((x) => x.name.toLowerCase() === graph.toLowerCase());
  if (!g) throw new Error(graph === undefined ? `Cypher needs a property graph: the database has ${all.length}` : `no property graph ${graph}`);
  return {
    graph: g.name,
    nodes: g.nodes.find((n) => n.label === NODE_LABEL)!.table,
    labels: g.labels!.table,
    labelTables: new Map(g.nodes.filter((n) => n.label !== NODE_LABEL).map((n) => [n.label, n.table])),
    types: new Map(g.edges.map((e) => [e.type, e.table])),
    relationshipIds: true,
    ...(g.history ? { history: g.history } : {}),
  };
}

/** A statement with its parameters numbered as smaltdb gives them: `at[i]` for the compiled statement's parameter `i`. */
function renumber(x: unknown, at: readonly number[]): unknown {
  if (x === null || typeof x !== 'object' || x instanceof Uint8Array) return x;
  if (Array.isArray(x)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < x.length; i++) {
      const w = renumber(x[i], at);
      if (w !== x[i]) (out ??= x.slice())[i] = w;
    }
    return out ?? x;
  }
  const o = x as Record<string, unknown>;
  if (o.k === 'param' && typeof o.index === 'number') return at[o.index] === o.index ? x : { ...o, index: at[o.index] };
  let out: Record<string, unknown> | undefined;
  for (const k in o) {
    const w = renumber(o[k], at);
    if (w !== o[k]) (out ??= { ...o })[k] = w;
  }
  return out ?? x;
}

const NO_NAMES: ReadonlyMap<string, number> = new Map();

/**
 * A Cypher statement that reads or writes the graph, as smaltdb takes a language's statement. It is its own shape
 * (`hash`, `values`, `same`): what is left of it with its strings and numbers taken out, found by its tokens.
 */
class CypherStatement {
  readonly paramCount: number;
  readonly paramNames: ReadonlyMap<string, number>;
  /** Set where the statement has a shape: itself. A statement the compiler needs written out as it is has none. */
  readonly shape: CypherStatement | undefined;
  /** Set where the statement has parameters: it binds for the kinds of their values. */
  readonly variant: ((params: Params) => string) | undefined;

  constructor(
    readonly text: string,
    /** Its plan; let go once smaltdb has found a statement of its shape, which is then the one that is bound. */
    private gp: QueryPlan | null,
    private readonly graph: string | undefined,
    readonly hash: number,
    /** Its shape's tokens; let go with the plan. */
    public tokens: readonly unknown[] | null,
    readonly values: readonly unknown[],
    private readonly names: readonly string[],
    private readonly pinned: readonly string[],
    asWritten: boolean,
  ) {
    this.paramCount = names.length;
    this.paramNames = names.length === 0 ? NO_NAMES : new Map(names.map((name, i) => [`$${name}`, i + 1]));
    // The compiler needs some values written out (`degree()`'s direction and type): such a statement keeps its values.
    this.shape = values.length > 0 && !asWritten ? this : undefined;
    this.variant = names.length > 0 ? this.kinds : undefined;
  }

  same(other: { tokens?: readonly unknown[] | null }): boolean {
    const mine = this.tokens;
    const theirs = other.tokens;
    if (mine === null || theirs === undefined || theirs === null || theirs.length !== mine.length) return false;
    for (let i = 0; i < mine.length; i++) if (theirs[i] !== mine[i]) return false;
    // smaltdb runs what `other` bound to for this statement: it is not bound, and nothing is found by it.
    this.gp = null;
    this.tokens = null;
    return true;
  }

  private valueOf(params: Params, i: number): unknown {
    if (params === undefined) return undefined;
    if (Array.isArray(params)) return params[i];
    const named = params as Record<string, unknown>;
    const name = this.names[i]!;
    return name in named ? named[name] : named[`$${name}`];
  }

  /**
   * A parameter is compared as a value of its kind: the statement binds for the kinds of its values, and for the
   * values themselves where they are part of what it means (SKIP and LIMIT).
   */
  private kinds(params: Params): string {
    const names = this.names;
    let key = '';
    for (let i = 0; i < names.length; i++) {
      const v = this.valueOf(params, i);
      key += this.pinned.length > 0 && this.pinned.includes(names[i]!) ? `${paramKind(v)}=${String(v)};` : `${paramKind(v)};`;
    }
    return key;
  }

  bind(ctx: Ctx, params: Params): unknown {
    const names = this.names;
    const tables = tablesOf(ctx, this.graph);
    // Bound after all (smaltdb no longer had the statement of its shape): its plan is made again from its text.
    const gp = (this.gp ??= compile(this.text).plan as QueryPlan);
    const all: Record<string, unknown> = {};
    if (params !== undefined) names.forEach((name, i) => (all[name] = this.valueOf(params, i)));
    const shaped = this.shape !== undefined;
    if (shaped) this.values.forEach((v, i) => (all[HOLE + i] = v));
    // The plan with a parameter where each value was: made here, for the first statement of a shape alone.
    const plan = shaped ? holedPlan(gp) : gp;
    const isWrite = writes(gp.root);
    const c = isWrite ? compileWrite(plan as never, tables, all) : compileQuery(plan, tables, { params: all });
    // The compiled statement numbers its parameters as it reads them: smaltdb gives the statement's own first, in
    // the order of their names here, then the values taken out.
    const at = c.params.map((name) => (name.startsWith(HOLE) ? names.length + Number(name.slice(HOLE.length)) : names.indexOf(name)));
    // A write's result columns are named here: smaltdb types them from the plan.
    const named = isWrite && c.columns.length > 0 ? { ...(c.statement as object), returning: c.columns.map((name) => ({ name })) } : c.statement;
    return renumber(named, at);
  }
}

function statement(text: string, graph: string | undefined): unknown {
  const gp = compile(text).plan;
  if (gp.kind !== 'query') return { text, paramCount: 0, paramNames: NO_NAMES, bind: (ctx: Ctx) => indexStatement(gp, tablesOf(ctx, graph)) };
  const s = statementShape(gp as QueryPlan);
  return new CypherStatement(text, gp as QueryPlan, graph, s.hash, s.tokens, s.values, s.params, s.pinned, s.asWritten);
}

/** Cypher, to register with smaltdb (`registerLanguage`). `graph`: the property graph its statements read and write. */
export function cypherLanguage(graph?: string) {
  return {
    name: 'cypher',
    plans: 'data' as const,
    parseOne: (text: string) => statement(text, graph),
    parse: (text: string) => [statement(text, graph)],
    // Cypher's booleans stay what smaltdb binds them as (1 and 0, read as `bool` where the statement was bound for one).
  };
}
