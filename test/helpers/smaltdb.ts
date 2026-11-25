/**
 * smaltcy's graphs in smaltdb, for the tests that run Cypher on both engines (test/smaltdb-differential.test.ts,
 * test/smaltdb-writes.test.ts).
 */
import { Database, type DatabaseOptions } from 'smaltdb-src/engine/database.js';
import { registerLanguage, type LanguageStatement } from 'smaltdb-src/engine/plan/language.js';
import { dumpGraph } from '../../src/engine/io.js';
import type { Graph } from '../../src/index.js';
import { cypherLanguage } from '../../src/smaltdb/language.js';
import { graphTablesFor, graphTablesIn, loadStatements, schemaStatements, type GraphData, type GraphTables } from '../../src/smaltdb/schema.js';

// Cypher, registered with smaltdb as an application registers it, for every test that gives smaltdb a statement's
// text. The tests count what smaltdb has the language bind: it keeps what a statement bound to (by its text, its shape
// and the kinds of its parameters' values), so a statement it has kept one for binds nothing.
let bound = 0;
const cypher = cypherLanguage();
const counted = (st: LanguageStatement): LanguageStatement => {
  const bind = st.bind;
  st.bind = function (this: LanguageStatement, ctx, params) {
    bound++;
    return bind.call(this, ctx, params);
  };
  return st;
};

// A statement told from its text (src/smaltdb/template.ts) must be the one a parse of the text gives. Every statement
// of every test is checked: the same language without templates parses the text, and the two must have one shape, the
// same values taken out and the same parameters.
const parsing = cypherLanguage(undefined, { templates: false });
interface Shaped {
  readonly hash?: number;
  readonly tokens?: readonly unknown[];
  readonly values?: readonly unknown[];
  readonly paramCount: number;
  readonly shape?: unknown;
}
const checked = (text: string, st: LanguageStatement): LanguageStatement => {
  const got = st as unknown as Shaped;
  const want = parsing.parseOne!(text) as unknown as Shaped;
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean =>
    a === undefined || b === undefined ? a === b : a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  if (got.hash !== want.hash || got.paramCount !== want.paramCount || (got.shape === undefined) !== (want.shape === undefined) || !same(got.tokens, want.tokens) || !same(got.values, want.values)) {
    throw new Error(`The statement told from this text is not the one its parse gives: ${text}`);
  }
  return st;
};
registerLanguage({ ...cypher, parseOne: (text) => counted(checked(text, cypher.parseOne!(text))), parse: (text) => cypher.parse!(text).map((st) => counted(checked(text, st))) });

/** How many times smaltdb has had a Cypher statement bound, in every database: tests read the difference. */
export const binds = (): number => bound;

/** The graph's tables in a database as its catalog has them now: with the labels and types statements added. */
export const tablesIn = (db: Database): GraphTables => graphTablesIn(db.catalog);

/** A store's graph to load, with its relationship ids (`dumpGraph` gives relationships in id order, without them). */
export function dataOf(g: Graph): GraphData {
  const data = dumpGraph(g.store);
  const ids: number[] = [];
  g.store.scanRels(null, (id) => void ids.push(id));
  return { ...data, relationships: data.relationships.map((r, i) => ({ ...r, id: ids[i]! })) };
}

/** A smaltcy graph and the same graph in a smaltdb database. */
export function both(g: Graph, options?: DatabaseOptions): { g: Graph; db: Database; tables: GraphTables } {
  const data = dataOf(g);
  const tables = graphTablesFor(data);
  const db = Database.openMemory(options);
  for (const st of [...schemaStatements(tables), ...loadStatements(data, tables)]) db.queryPlan(st);
  return { g, db, tables };
}
