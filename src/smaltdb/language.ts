/**
 * Cypher as a language registered with smaltdb (ADR 0004, "A language of smaltdb"; smaltdb's ADR 0015, and ADR 0042,
 * section 4). Registered (`registerLanguage(cypherLanguage())`, from `smaltdb/language`), smaltdb's entry points that
 * take a statement's text take Cypher: `db.query(text, params, { language: 'cypher' })`.
 *
 * Nothing here runs a statement or keeps one: smaltdb does both. It keeps what a statement bound to
 *
 * - **by its text:** a text it has seen is not parsed again;
 * - **by its shape** (shape.ts): a statement that differs from one it has seen in its strings and numbers runs what
 *   that one bound to, with its own values, and is not bound;
 * - **by the kinds of its parameters' values** (its variant): the compiler compares a parameter as a value of its
 *   kind, so a statement binds once for each kind its parameters come in.
 *
 * A statement binds to plan data (`plans: 'data'`), which the compiler builds (compile.ts, write-plan.ts) for the
 * graph's tables as smaltdb's catalog has them when it binds. smaltdb binds a statement again when the schema changes,
 * so a statement kept from before a label, a type or an index was added reads the graph as it is.
 *
 * Refused (`Unsupported`): `EXPLAIN`, which smaltdb answers for its own plans; and `AT VERSION` and `AT TIME`. The
 * version such a statement reads is found before it is compiled (write.ts, `runOnSmaltdb`, which runs it), and a
 * statement given to smaltdb as text has nothing to find it with.
 */
import type { BindContext, LanguageStatement, PlanStatementInput, SmaltLanguage, SqlValue, StatementParams, StatementShape } from 'smaltdb/language';
import { compile } from '../cypher/index.js';
import type { GraphPlan, QueryPlan } from '../plan/ops.js';
import { compileQuery, paramKind, Unsupported } from './compile.js';
import { graphTablesIn, LANGUAGE } from './schema.js';
import { HOLE, holedPlan, MAX_HOLES, statementShape } from './shape.js';
import { compileWrite, writes } from './write-plan.js';
import { indexStatement } from './write.js';

const NO_NAMES: ReadonlyMap<string, number> = new Map();

/** A plan with the parameters the compiler numbered as it read them numbered as smaltdb gives them: `at[i]` for `i`. */
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

/**
 * A Cypher statement that reads or writes the graph, as smaltdb takes a language's statement. It is its own shape
 * (`hash`, `values`, `same`): what is left of it with its strings and numbers taken out.
 */
class CypherStatement implements LanguageStatement, StatementShape {
  readonly paramCount: number;
  readonly paramNames: ReadonlyMap<string, number>;
  /** Itself, where the statement has a shape: one the compiler needs written as it is, or with no value to take out, has none. */
  readonly shape?: StatementShape;
  /** Set where the statement has parameters: it binds for the kinds of their values. */
  readonly variant?: (params: StatementParams | undefined) => string;

  constructor(
    readonly text: string,
    private readonly plan: QueryPlan,
    private readonly graph: string | undefined,
    readonly hash: number,
    /** Its shape's tokens. */
    readonly tokens: readonly unknown[],
    readonly values: readonly SqlValue[],
    /** Its parameters, by name: smaltdb gives them in this order, then the values taken out. */
    private readonly names: readonly string[],
    /** Those of its parameters whose values are part of what it compiles to (a SKIP's or a LIMIT's count). */
    private readonly pinned: readonly string[],
    asWritten: boolean,
  ) {
    this.paramCount = names.length;
    this.paramNames = names.length === 0 ? NO_NAMES : new Map(names.map((name, i) => [`$${name}`, i + 1]));
    if (values.length > 0 && values.length <= MAX_HOLES && !asWritten) this.shape = this;
    if (names.length > 0) this.variant = this.kinds;
  }

  same(other: LanguageStatement): boolean {
    const mine = this.tokens;
    const theirs = (other as Partial<CypherStatement>).tokens;
    if (theirs === undefined || theirs.length !== mine.length) return false;
    for (let i = 0; i < mine.length; i++) if (theirs[i] !== mine[i]) return false;
    return true;
  }

  /** A parameter's value among those given, by position or by its name (`name` or `$name`); undefined where none is. */
  private given(params: StatementParams | undefined, i: number): unknown {
    if (params === undefined) return undefined;
    if (Array.isArray(params)) return params[i];
    const named = params as Readonly<Record<string, unknown>>;
    const name = this.names[i]!;
    const v = named[name];
    return v !== undefined ? v : named[`$${name}`];
  }

  /**
   * A parameter is compared as a value of its kind, so the statement binds for the kinds of its parameters' values:
   * and for the values themselves where they are part of what it compiles to. A parameter that is not given is a kind
   * of its own, so the statement is bound for it, which fails as smaltcy's engine does.
   */
  private kinds(params: StatementParams | undefined): string {
    const names = this.names;
    const pinned = this.pinned;
    let key = '';
    for (let i = 0; i < names.length; i++) {
      const v = this.given(params, i);
      if (v === undefined) key += '?;';
      else if (pinned.length > 0 && pinned.includes(names[i]!)) key += `${paramKind(v)}=${String(v)};`;
      else key += `${paramKind(v)};`;
    }
    return key;
  }

  bind(ctx: BindContext, params?: StatementParams): PlanStatementInput {
    const names = this.names;
    const tables = graphTablesIn(ctx.catalog, this.graph);
    // A parameter that is not given is left out: the compiler fails on it as smaltcy's engine does.
    const all: Record<string, unknown> = {};
    for (let i = 0; i < names.length; i++) {
      const v = this.given(params, i);
      if (v !== undefined) all[names[i]!] = v;
    }
    const shaped = this.shape !== undefined;
    if (shaped) for (let i = 0; i < this.values.length; i++) all[HOLE + i] = this.values[i];
    // With a parameter where each value was: what every statement of the shape runs, each with its own values.
    const plan = shaped ? holedPlan(this.plan) : this.plan;
    const isWrite = writes(plan.root);
    const c = isWrite ? compileWrite(plan, tables, all) : compileQuery(plan, tables, { params: all });
    // The compiler numbers a statement's parameters as it reads them. smaltdb gives the statement's own first, in the
    // order of `names`, then the values taken out.
    const at = c.params.map((name) => (name.startsWith(HOLE) ? names.length + Number(name.slice(HOLE.length)) : names.indexOf(name)));
    // What a write gives back is named here; smaltdb types it from the plan.
    const statement = isWrite && c.columns.length > 0 ? { ...c.statement, returning: c.columns.map((name) => ({ name })) } : c.statement;
    return renumber(statement, at) as PlanStatementInput;
  }
}

/** `CREATE INDEX` and `DROP INDEX`: a schema statement of smaltdb's, with no parameters. */
function indexChange(text: string, gp: Extract<GraphPlan, { kind: 'createIndex' | 'dropIndex' }>, graph: string | undefined): LanguageStatement {
  return { text, paramCount: 0, paramNames: NO_NAMES, bind: (ctx) => indexStatement(gp, graphTablesIn(ctx.catalog, graph)) };
}

function statement(text: string, graph: string | undefined): LanguageStatement {
  const { plan: gp, explain } = compile(text);
  if (explain) throw new Unsupported('EXPLAIN (smaltdb explains the plan a statement binds to)');
  if (gp.kind !== 'query') return indexChange(text, gp, graph);
  if (gp.asOf) throw new Unsupported('AT VERSION and AT TIME in a statement given to smaltdb as text (runOnSmaltdb finds the version to read, then runs it)');
  const s = statementShape(gp);
  return new CypherStatement(text, gp, graph, s.hash, s.tokens, s.values, s.params, s.pinned, s.asWritten);
}

/**
 * Cypher, to register with smaltdb (`registerLanguage`, from `smaltdb/language`). `graph`: the property graph its
 * statements read and write, by name; without it, the database's only graph made for Cypher (schema.ts,
 * `schemaStatements`).
 */
export function cypherLanguage(graph?: string): SmaltLanguage {
  return {
    name: LANGUAGE,
    plans: 'data',
    parseOne: (text) => statement(text, graph),
    // A Cypher text is one statement.
    parse: (text) => [statement(text, graph)],
  };
}
