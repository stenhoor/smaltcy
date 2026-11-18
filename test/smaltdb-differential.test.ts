import { describe, expect, test } from 'vitest';
import { Database } from 'smaltdb-src/engine/database.js';
import { compile } from '../src/cypher/index.js';
import { dumpGraph } from '../src/engine/io.js';
import { open, type Graph } from '../src/index.js';
import { compileQuery, paramValues, Unsupported } from '../src/smaltdb/compile.js';
import { graphTablesFor, loadStatements, schemaStatements, type GraphTables } from '../src/smaltdb/schema.js';
import { social } from './helpers/graphs.js';
import { READ_CASES, READ_PARAMS } from './helpers/read-cases.js';

/**
 * Cypher on smaltdb (ADR 0004; smaltdb ADR 0033, step 8): Cypher compiled by smaltcy's compiler, then to a smaltdb plan,
 * and run on the same graph loaded into smaltdb. Each query must give the rows smaltcy's own engine gives, or be refused
 * as not supported yet.
 */

/**
 * The read cases the compiler refuses, with what it names. The list can only shrink: a case on it that compiles fails,
 * and so does a case off it that gives other rows.
 */
const UNSUPPORTED = new Map<string, string>([
  ['one hop out', 'relationship patterns'],
  ['one hop in', 'relationship patterns'],
  ['either direction', 'relationship patterns'],
  ['relationship property', 'relationship patterns'],
  ['type()', 'relationship patterns'],
  ['type alternatives', 'relationship patterns'],
  ['two hops', 'relationship patterns'],
  ['triangle', 'relationship patterns'],
  ['shared neighbour', 'relationship patterns'],
  ['variable length', 'relationship patterns'],
  ['variable length bounds', 'relationship patterns'],
  ['variable length zero', 'relationship patterns'],
  ['variable length paths count', 'relationship patterns'],
  ['relationship list', 'relationship patterns'],
  ['variable length with props', 'relationship patterns'],
  ['named path', 'relationship patterns'],
  ['shortest path', 'relationship patterns'],
  ['all shortest paths', 'relationship patterns'],
  ['all shortest paths, several', 'relationship patterns'],
  ['all shortest paths, one route', 'relationship patterns'],
  ['no shortest path', 'relationship patterns'],
  ['optional match', 'OPTIONAL MATCH'],
  ['optional match where', 'OPTIONAL MATCH'],
  ['count group', 'relationship patterns'],
  ['collect distinct', 'relationship patterns'],
  ['count on empty', 'collect() of nodes'],
  ['with and where', 'relationship patterns'],
  ['distinct', 'relationship patterns'],
  ['pattern predicate', 'EXISTS and pattern predicates'],
  ['exists subquery', 'EXISTS and pattern predicates'],
  ['pattern comprehension', 'pattern comprehensions'],
  ['labels and keys', 'keys() (a smaltdb map keeps its keys sorted)'],
  ['degree', 'the function degree()'],
]);

/** A smaltcy graph and the same graph in a smaltdb database. */
function both(g: Graph): { g: Graph; db: Database; tables: GraphTables } {
  const data = dumpGraph(g.store);
  const tables = graphTablesFor(data);
  const db = Database.openMemory();
  for (const st of [...schemaStatements(tables), ...loadStatements(data, tables)]) db.queryPlan(st);
  return { g, db, tables };
}

/** Runs a Cypher query on smaltdb: its rows as objects keyed by column, as `Graph.query` gives them. */
function onSmaltdb(db: Database, tables: GraphTables, cypher: string, params: Record<string, unknown> = {}) {
  const q = compileQuery(compile(cypher).plan, tables, { params });
  const r = db.queryPlan(q.statement, paramValues(q, params) as never);
  return r.rows.map((row) => Object.fromEntries(q.columns.map((c, i) => [c, row[i]])));
}

describe('the read cases on smaltdb', () => {
  const { db, tables } = both(social());
  test.each(READ_CASES)('%s', (name, cypher, expected) => {
    const feature = UNSUPPORTED.get(name);
    if (feature !== undefined) {
      let error: unknown;
      try {
        onSmaltdb(db, tables, cypher, READ_PARAMS);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Unsupported);
      expect((error as Unsupported).feature).toBe(feature);
      return;
    }
    expect(onSmaltdb(db, tables, cypher, READ_PARAMS)).toEqual(expected);
  });

  test('how many run', () => {
    expect(READ_CASES.length - UNSUPPORTED.size).toBe(26);
    for (const name of UNSUPPORTED.keys()) expect(READ_CASES.some(([n]) => n === name), name).toBe(true);
  });
});

/** Properties of every kind, where smaltdb's meaning and Cypher's differ (smaltdb ADR 0033, section 5.4). */
const MIXED = `CREATE (:T {k: 'int', v: 1}), (:T {k: 'float', v: 1.5}), (:T {k: 'str', v: 'a'}), (:T {k: 'true', v: true}),
  (:T {k: 'false', v: false}), (:T {k: 'list', v: [1, 2]}), (:T {k: 'none'}), (:T {k: 'zero', v: 0}), (:T {k: 'ten', v: 10}),
  (:T {k: 'str2', v: 'B'})`;

describe("Cypher's meaning, where smaltdb's differs: both engines give the same rows", () => {
  const g = open();
  g.run(MIXED);
  const { db, tables } = both(g);
  test.each([
    ['values of every kind come back as they went in', 'MATCH (n:T) RETURN n.k AS k, n.v AS v ORDER BY k'],
    ['comparisons across kinds: false for =, NULL for <', "MATCH (n:T) RETURN n.k AS k, n.v = 1 AS eq1, n.v = true AS eqt, n.v < 2 AS lt2, n.v >= 'a' AS gea ORDER BY k"],
    ['ORDER BY: strings, booleans, numbers, then NULL', "MATCH (n:T) WHERE n.k <> 'list' RETURN n.k AS k ORDER BY n.v, k"],
    ['ORDER BY DESC: NULL first', "MATCH (n:T) WHERE n.k <> 'list' RETURN n.k AS k ORDER BY n.v DESC, k"],
    ['min and max across kinds', "MATCH (n:T) WHERE n.k <> 'list' RETURN min(n.v) AS lo, max(n.v) AS hi"],
    ['aggregates of numbers', "MATCH (n:T) WHERE n.k IN ['int', 'float', 'zero', 'ten'] RETURN min(n.v) AS lo, max(n.v) AS hi, sum(n.v) AS s, avg(n.v) AS a"],
    ['collect leaves NULLs out', 'MATCH (n:T) RETURN collect(n.v) AS vs'],
    ['count DISTINCT keeps true apart from 1', 'MATCH (n:T) RETURN count(DISTINCT n.v) AS c'],
    ['aggregates of no rows: sum 0, collect []', 'MATCH (n:Nobody) RETURN sum(n.v) AS s, avg(n.v) AS a, min(n.v) AS lo, collect(n.v) AS c'],
    ['integer and float arithmetic', 'RETURN 7 / 2 AS a, 7.0 / 2 AS b, -7 / 2 AS c, 7 % 3 AS d, -7 % 3 AS e, 2 * 3 + 1 AS f, 1.5 + 1 AS g'],
    ['booleans and NULLs', "RETURN true = 1 AS a, 1 = 1.0 AS b, 'a' < 'b' AS c, 1 < 'a' AS d, null = null AS e, true < false AS f, true AND null AS g, false AND null AS h, true XOR false AS i, true XOR null AS j"],
    ['NaN equals nothing', 'RETURN 0.0 / 0 = 0.0 / 0 AS nan, 1.0 / 0 AS inf'],
    ['lists and maps of mixed kinds', "RETURN [1, 'a', true] AS l, {a: 1, b: true} AS m, [true, false] AS bs"],
    ['size of strings and lists', "MATCH (n:T) WHERE n.k IN ['str', 'list', 'str2'] RETURN n.k AS k, size(n.v) AS s ORDER BY k"],
    ['IN a list of mixed kinds', "MATCH (n:T) RETURN n.k AS k, n.v IN [1, 'a', true] AS i ORDER BY k"],
    ['DISTINCT across kinds', "UNWIND [1, 1.0, 2, true, 'a', 'a', null] AS x RETURN DISTINCT x"],
    ['string functions only on strings', "MATCH (n:T) WHERE n.k IN ['str', 'str2'] RETURN toUpper(n.v) AS u, toLower(n.v) AS l, n.v STARTS WITH 'a' AS s ORDER BY u"],
    ['CASE compares as = does', "MATCH (n:T) RETURN n.k AS k, CASE n.v WHEN 1 THEN 'one' WHEN true THEN 'yes' ELSE 'other' END AS c ORDER BY k"],
    ['list comprehensions and quantifiers over a property', "MATCH (n:T) WHERE n.k = 'list' RETURN [x IN n.v WHERE x > 1 | x * 10] AS l, any(x IN n.v WHERE x = 2) AS a, all(x IN n.v WHERE x > 1) AS b"],
    ['quantifiers with NULLs', 'RETURN single(x IN [1, null, 2] WHERE x = 1) AS s, none(x IN [] WHERE x = 1) AS n, all(x IN [1, null] WHERE x > 0) AS a'],
    ['+ joins strings', "MATCH (n:T) WHERE n.k IN ['str', 'str2'] RETURN n.v + n.v AS c ORDER BY c"],
    ['coalesce across kinds', "MATCH (n:T) RETURN n.k AS k, coalesce(n.v, 'missing') AS c ORDER BY k"],
  ])('%s', (_name, cypher) => {
    expect(onSmaltdb(db, tables, cypher)).toEqual(g.query(cypher));
  });

  // Errors in Cypher, where smaltdb would give a value. The messages differ: smaltdb's start with `smaltcy:`.
  test.each([
    ['division by zero', 'RETURN 1 / 0 AS x'],
    ['a predicate that is not a boolean', 'MATCH (n:T) WHERE n.v RETURN n.k AS k'],
    ['adding a boolean', 'MATCH (n:T) RETURN n.k AS k, n.v + 1 AS p ORDER BY k'],
    ['sum of a string', 'MATCH (n:T) RETURN sum(n.v) AS s'],
  ])('both engines refuse %s', (_name, cypher) => {
    expect(() => g.query(cypher)).toThrow();
    expect(() => onSmaltdb(db, tables, cypher)).toThrow(/smaltcy: /);
  });

  test('lists in ORDER BY are refused when they are met (smaltdb orders them by their bytes)', () => {
    expect(() => onSmaltdb(db, tables, 'MATCH (n:T) RETURN n.v ORDER BY n.v')).toThrow(/smaltcy: ordering lists and maps/);
  });
});

describe('the graph in smaltdb', () => {
  test('nodes, labels in order, and relationships by type', () => {
    const { db, tables } = both(social());
    expect(db.queryPlan({ kind: 'query', plan: { op: 'scan', table: tables.nodes, columns: [0] } }).rows).toHaveLength(7);
    expect(onSmaltdb(db, tables, "MATCH (p {name: 'Grace'}) RETURN labels(p) AS l, id(p) AS id")).toEqual([{ l: ['Person', 'Admiral'], id: 2 }]);
    const knows = tables.types.get('KNOWS')!;
    expect(db.queryPlan({ kind: 'query', plan: { op: 'scan', table: knows, columns: [0, 1, 2] } }).rows[0]).toEqual([0, 1, { since: 1833 }]);
    expect(db.catalog.graph('graph')!.nodes.map((n) => n.label)).toEqual(['smaltcy:node', 'Person', 'Admiral', 'City']);
  });

  test('a label spelled two ways, or the reserved label, is refused', () => {
    const g = open();
    g.run('CREATE (:Person), (:person)');
    expect(() => graphTablesFor(dumpGraph(g.store))).toThrow(/differ only in case/);
    const h = open();
    h.run('CREATE (:`smaltcy:node`)');
    expect(() => graphTablesFor(dumpGraph(h.store))).toThrow(/reserved/);
  });

  test('parameters are typed by their values', () => {
    const { db, tables } = both(social());
    expect(onSmaltdb(db, tables, 'MATCH (p:Person) WHERE p.born > $y AND $flag RETURN count(*) AS n', { y: 1925, flag: true })).toEqual([{ n: 2 }]);
    expect(() => compileQuery(compile('RETURN $nope AS x').plan, tables)).toThrow(Unsupported);
  });
});
