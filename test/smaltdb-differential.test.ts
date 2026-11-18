import { describe, expect, test } from 'vitest';
import { Database } from 'smaltdb-src/engine/database.js';
import { compile } from '../src/cypher/index.js';
import { dumpGraph } from '../src/engine/io.js';
import { open, type Graph } from '../src/index.js';
import { compileQuery, paramValues, Unsupported } from '../src/smaltdb/compile.js';
import { graphTablesFor, loadStatements, schemaStatements, type GraphData, type GraphTables } from '../src/smaltdb/schema.js';
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
  ['labels and keys', 'keys() (a smaltdb map keeps its keys sorted)'],
]);

/** A store's graph to load, with its relationship ids (`dumpGraph` gives relationships in id order, without them). */
function dataOf(g: Graph): GraphData {
  const data = dumpGraph(g.store);
  const ids: number[] = [];
  g.store.scanRels(null, (id) => void ids.push(id));
  return { ...data, relationships: data.relationships.map((r, i) => ({ ...r, id: ids[i]! })) };
}

/** A smaltcy graph and the same graph in a smaltdb database. */
function both(g: Graph): { g: Graph; db: Database; tables: GraphTables } {
  const data = dataOf(g);
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
    expect(READ_CASES.length - UNSUPPORTED.size).toBe(58);
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

/** Relationships: self-loops, parallel relationships of two types, an isolated node. */
const RELS = `CREATE (a:N {k: 'a'}), (b:N {k: 'b'}), (c:N:M {k: 'c'}), (d:M {k: 'd'}),
  (a)-[:R {w: 1}]->(b), (b)-[:R {w: 2}]->(c), (c)-[:R {w: 3}]->(a), (a)-[:R {w: 4}]->(a),
  (a)-[:S {w: 5, f: true}]->(b), (b)-[:S {w: 6}]->(b), (c)-[:R {w: 7}]->(b)`;

describe('relationships: both engines give the same rows', () => {
  const g = open();
  g.run(RELS);
  const { db, tables } = both(g);
  test.each([
    ['one hop out', "MATCH (x {k: 'a'})-[r]->(y) RETURN r.w AS w, y.k AS y ORDER BY w"],
    ['one hop in', "MATCH (x {k: 'b'})<-[r]-(y) RETURN r.w AS w, y.k AS y ORDER BY w"],
    ['either direction: a self-loop once', "MATCH (x {k: 'a'})-[r]-(y) RETURN r.w AS w, y.k AS y ORDER BY w"],
    ['self-loops, either direction', 'MATCH (x)-[r]-(x) RETURN x.k AS x, r.w AS w ORDER BY w'],
    ['self-loops, directed', 'MATCH (x)-[r]->(x) RETURN x.k AS x, r.w AS w ORDER BY w'],
    ['uniqueness: a path never uses a relationship twice', 'MATCH (x)-[r1]-(y)-[r2]-(z) RETURN x.k AS x, r1.w AS a, r2.w AS b, z.k AS z ORDER BY a, b, x, z'],
    ['uniqueness across the patterns of one MATCH', 'MATCH (x)-[r1:R]->(y), (u)-[r2:R]->(v) RETURN count(*) AS n'],
    ['no uniqueness across MATCH clauses', 'MATCH (x)-[r1:R]->(y) MATCH (u)-[r2:R]->(v) RETURN count(*) AS n'],
    ['uniqueness between types that may be the same', 'MATCH (x)-[r1]->(y)-[r2:S]->(z) RETURN r1.w AS a, r2.w AS b ORDER BY a, b'],
    ['type alternatives', 'MATCH (x)-[r:R|S]->(y) RETURN type(r) AS t, r.w AS w ORDER BY w'],
    ['a type the graph lacks', 'MATCH ()-[r:S|NOPE]->() RETURN r.w AS w ORDER BY w'],
    ['only a type the graph lacks', 'MATCH ()-[r:NOPE]->() RETURN count(*) AS n'],
    ['a relationship property map', 'MATCH (x)-[r {w: 2}]->(y) RETURN x.k AS x, y.k AS y'],
    ['a boolean in a relationship property map', 'MATCH ()-[r {f: true}]->() RETURN r.w AS w'],
    ['a cycle of three', 'MATCH (x)-[:R]->(y)-[:R]->(z)-[:R]->(x) RETURN x.k AS x, y.k AS y, z.k AS z ORDER BY x'],
    ['labels on both ends', 'MATCH (x:N)-[r]->(y:M) RETURN x.k AS x, r.w AS w ORDER BY w'],
    ['OPTIONAL MATCH with WHERE', 'MATCH (x:N) OPTIONAL MATCH (x)-[r:R]->(y) WHERE r.w > 2 RETURN x.k AS x, y.k AS y, r.w AS w ORDER BY x, w'],
    ['OPTIONAL MATCH, then count', 'MATCH (x) OPTIONAL MATCH (x)<-[r:S]-(y) RETURN x.k AS x, count(r) AS n ORDER BY x'],
    ['OPTIONAL MATCH between bound nodes', "MATCH (x {k: 'a'}), (y {k: 'c'}) OPTIONAL MATCH (x)-[r]-(y) RETURN r.w AS w ORDER BY w"],
    ['OPTIONAL MATCH of a chain', 'MATCH (x:M) OPTIONAL MATCH (x)-[:R]->(y)-[:R]->(z) RETURN x.k AS x, y.k AS y, z.k AS z ORDER BY x, y, z'],
    ['OPTIONAL MATCH on a NULL node', "OPTIONAL MATCH (x {k: 'none'}) OPTIONAL MATCH (x)-[r]->(y) RETURN x.k AS x, r.w AS w"],
    ['relationships compared, and NULL', 'MATCH (x)-[r1]->(y) OPTIONAL MATCH (y)-[r2]->(x) RETURN r1.w AS a, r2.w AS b, r2 IS NULL AS none, r1 = r2 AS same ORDER BY a, b'],
    ['id, startNode, endNode and properties', 'MATCH (x)-[r:S]->(y) RETURN id(r) AS id, startNode(r).k AS s, endNode(r).k AS e, properties(r) AS p ORDER BY id'],
    ['relationships and nodes in results', 'MATCH (x:M)<-[r]-(y) RETURN x, r, y ORDER BY r.w'],
    ['DISTINCT relationships', 'MATCH (x)-[r]-(y) WITH DISTINCT r RETURN count(*) AS n'],
    ['counts by type', 'MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS n, sum(r.w) AS s ORDER BY t'],
    ['degree', "MATCH (x) RETURN x.k AS x, degree(x) AS d, degree(x, 'out') AS o, degree(x, 'in', 'R') AS i ORDER BY x"],
    ['WITH, then a hop from the bound node', 'MATCH (x:N) WITH x ORDER BY x.k LIMIT 2 MATCH (x)-[r:R]->(y) RETURN x.k AS x, y.k AS y ORDER BY x, y'],
    ['variable length from zero', "MATCH (x {k: 'd'})-[*0..3]-(y) RETURN y.k AS y"],
    ['variable length with properties', 'MATCH (x)-[rs:R*1..3 {w: 2}]->(y) RETURN x.k AS x, y.k AS y, size(rs) AS n ORDER BY x, y'],
    ['variable length of a type the graph lacks', 'MATCH (x)-[:NOPE*0..1]->(y) RETURN x.k AS x, y.k AS y ORDER BY x'],
    ['a named path in results', "MATCH p = (x {k: 'c'})-[:R*1..2]->(y {k: 'a'}) RETURN p ORDER BY length(p)"],
    ['shortest path', "MATCH (x {k: 'c'}), (y {k: 'b'}), p = shortestPath((x)-[*]->(y)) RETURN length(p) AS len, [n IN nodes(p) | n.k] AS ks"],
    ['shortest path to the same node', "MATCH (x {k: 'a'}), p = shortestPath((x)-[*0..]->(x)) RETURN length(p) AS len"],
    ['collect of nodes', "MATCH (x:N) WITH collect(x) AS xs RETURN size(xs) AS n, [x IN xs | x.k] AS ks, xs"],
  ])('%s', (_name, cypher) => {
    expect(onSmaltdb(db, tables, cypher)).toEqual(g.query(cypher));
  });

  // Without ORDER BY (the compiler refuses ordering by a list): the same rows, in any order.
  const sorted = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).sort();
  test.each([
    ['variable length: trails', "MATCH (x {k: 'a'})-[rs:R*]->(y) RETURN y.k AS y, [r IN rs | r.w] AS ws"],
    ['variable length, either direction: a self-loop once', "MATCH (x {k: 'a'})-[rs*1..2]-(y) RETURN y.k AS y, [r IN rs | r.w] AS ws"],
    ['variable length from the far end', "MATCH (x)-[rs:R*2]->(y {k: 'b'}) RETURN x.k AS x, [r IN rs | r.w] AS ws"],
    ['variable length and a fixed hop: no relationship twice', "MATCH (x {k: 'a'})-[r:R]->(y)-[rs:R*1..2]->(z) RETURN r.w AS w, [q IN rs | q.w] AS ws"],
    ['a named path', "MATCH p = (x {k: 'c'})-[:R]->(y)-[:R]->(z) RETURN length(p) AS len, [n IN nodes(p) | n.k] AS ks, [r IN relationships(p) | type(r)] AS ts"],
    ['all shortest paths, either direction', "MATCH (x {k: 'a'}), (y {k: 'c'}), p = allShortestPaths((x)-[*]-(y)) RETURN length(p) AS len, [r IN relationships(p) | r.w] AS ws"],
  ])('%s (in any order)', (_name, cypher) => {
    const rows = g.query(cypher);
    expect(rows.length).toBeGreaterThan(0);
    expect(sorted(onSmaltdb(db, tables, cypher))).toEqual(sorted(rows));
  });

  test("a variable-length relationship's hops are not bound again by a later hop (Cypher's uniqueness)", () => {
    // smaltcy's own engine expands the variable-length relationship first here and doesn't count its hops as used, so
    // it also gives the rows whose r is one of rs; smaltdb gives the others, as Cypher does.
    const cypher = "MATCH (x {k: 'a'})-[rs:R*1..2]-(y)-[r:R]-(z) RETURN [q IN rs | q.w] AS ws, r.w AS w";
    const all = g.query(cypher) as { ws: number[]; w: number }[];
    const unique = all.filter((row) => !row.ws.includes(row.w));
    expect(unique.length).toBeLessThan(all.length);
    expect(sorted(onSmaltdb(db, tables, cypher))).toEqual(sorted(unique));
  });

  test('id(r) and relationships in results are refused when the graph was loaded without relationship ids', () => {
    const data = dumpGraph(g.store);
    const t = graphTablesFor(data);
    expect(t.relationshipIds).toBe(false);
    expect(() => compileQuery(compile('MATCH ()-[r]->() RETURN id(r) AS id').plan, t)).toThrow(Unsupported);
    expect(() => compileQuery(compile('MATCH ()-[r]->() RETURN r').plan, t)).toThrow(Unsupported);
    expect(graphTablesFor(dataOf(g)).relationshipIds).toBe(true);
  });
});

/** EXISTS, pattern predicates and pattern comprehensions: nested plans, correlated with the row they are run from. */
describe('nested plans: both engines give the same rows', () => {
  const g = open();
  g.run(RELS);
  const { db, tables } = both(g);
  test.each([
    ['EXISTS on a node', 'MATCH (x) WHERE EXISTS { MATCH (x)-[:S]->() } RETURN x.k AS x ORDER BY x'],
    ['a negated pattern predicate', 'MATCH (x) WHERE NOT (x)-->() RETURN x.k AS x ORDER BY x'],
    ['a pattern predicate between bound nodes', 'MATCH (x), (y) WHERE x.k < y.k AND (x)-[:R]-(y) RETURN x.k AS x, y.k AS y ORDER BY x, y'],
    ['a pattern predicate with labels and properties', "MATCH (x) WHERE (x)-[{w: 2}]->(:N:M {k: 'c'}) RETURN x.k AS x"],
    ['EXISTS with a WHERE that reads an outer relationship', 'MATCH (x)-[r]->(y) WHERE EXISTS { MATCH (y)-[s]->(z) WHERE s.w > r.w } RETURN r.w AS w ORDER BY w'],
    ['NOT EXISTS, correlated on both ends of a relationship', 'MATCH (x)-[r:R]->(y) WHERE NOT EXISTS { MATCH (y)-[:R]->(x) } RETURN r.w AS w ORDER BY w'],
    ['EXISTS and a pattern predicate as values', 'MATCH (x) RETURN x.k AS x, EXISTS { MATCH (x)<-[:S]-() } AS e, (x)-[:R]->(x) AS loop ORDER BY x'],
    ['EXISTS with a variable-length relationship', 'MATCH (x) WHERE EXISTS { MATCH (x)-[:R*2]->(x) } RETURN x.k AS x ORDER BY x'],
    ['EXISTS inside EXISTS', 'MATCH (x) WHERE EXISTS { MATCH (x)-->(y) WHERE EXISTS { MATCH (y)-[:S]->(y) } } RETURN x.k AS x ORDER BY x'],
    ['EXISTS in an OPTIONAL MATCH', 'MATCH (x:N) OPTIONAL MATCH (x)-[r]->(y) WHERE (y)-[:S]->() RETURN x.k AS x, r.w AS w ORDER BY x, w'],
    ['EXISTS of a NULL node', "OPTIONAL MATCH (x {k: 'none'}) RETURN EXISTS { MATCH (x)-->() } AS e, [(x)-->(y) | y.k] AS ys"],
    ['EXISTS after WITH', 'MATCH (x) WITH x.k AS k, x WHERE (x)-[:S]-() RETURN k ORDER BY k'],
    ['a pattern comprehension in WHERE', 'MATCH (x) WHERE size([(x)-->(y) | y]) > 1 RETURN x.k AS x ORDER BY x'],
    ['a pattern comprehension in ORDER BY', 'MATCH (x) RETURN x.k AS k ORDER BY size([(x)-->() | 1]) DESC, k'],
    ['a pattern comprehension in an aggregate', 'MATCH (x) RETURN sum(size([(x)-->() | 1])) AS n, collect(EXISTS { MATCH (x)-[:S]->() }) AS es'],
  ])('%s', (_name, cypher) => {
    expect(onSmaltdb(db, tables, cypher)).toEqual(g.query(cypher));
  });

  // A pattern comprehension's list is in the order its pattern matches, which Cypher leaves open as it does a MATCH's:
  // smaltdb's goes by type, then by relationship; smaltcy's store by relationship id. The same elements, in any order.
  // (Elements compared by their JSON with keys sorted: a smaltdb map keeps its keys sorted.)
  const canon = (x: unknown): string =>
    JSON.stringify(x, (_k, v: unknown) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([p], [q]) => (p < q ? -1 : 1))) : v));
  const sortedLists = (rows: Record<string, unknown>[]) =>
    rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Array.isArray(v) ? v.map(canon).sort() : v])));
  test.each([
    ['a pattern comprehension', 'MATCH (x) RETURN x.k AS x, [(x)-[r]->(y) | r.w] AS ws ORDER BY x'],
    ['a pattern comprehension with WHERE', 'MATCH (x) RETURN x.k AS x, [(x)-[r]->(y) WHERE r.w > 2 | y.k] AS ys ORDER BY x'],
    ['a pattern comprehension reading an outer relationship', 'MATCH (x)-[r]->(y) RETURN r.w AS w, [(y)-[q]->(z) WHERE q.w > r.w | q.w] AS later ORDER BY w'],
    ['a pattern comprehension giving nodes', 'MATCH (x:N) RETURN x.k AS x, [(x)<-[:R]-(y) | y] AS ys ORDER BY x'],
    ['a pattern comprehension giving lists and NULLs', "MATCH (x {k: 'c'}) RETURN [(x)-->(y) | labels(y)] AS ls, [(x)-->(y) | y.nope] AS ns"],
    ['a pattern comprehension of a chain', "MATCH (x {k: 'a'}) RETURN [(x)-[:R]->(y)-[:R]->(z) | z.k] AS zs"],
    ['a pattern comprehension in either direction', 'MATCH (x) RETURN x.k AS x, [(x)-[r]-(y) | r.w] AS ws ORDER BY x'],
    ['a pattern comprehension of a variable-length relationship', 'MATCH (x) RETURN x.k AS x, [(x)-[:R*1..2]->(y) | y.k] AS ys ORDER BY x'],
  ])('%s (its lists in any order)', (_name, cypher) => {
    const rows = g.query(cypher) as Record<string, unknown>[];
    expect(rows.some((r) => Object.values(r).some((v) => Array.isArray(v) && v.length > 1))).toBe(true);
    expect(sortedLists(onSmaltdb(db, tables, cypher))).toEqual(sortedLists(rows));
  });

  test('refused: nested plans inside list comprehensions, and pattern comprehensions giving relationships', () => {
    // smaltdb's nested plans don't read an `each`'s elements.
    expect(() => onSmaltdb(db, tables, "MATCH (x) RETURN [k IN ['a', 'b'] | size([(x)-->(y) WHERE y.k = k | 1])] AS n")).toThrow(Unsupported);
    expect(() => onSmaltdb(db, tables, 'MATCH (x) RETURN [(x)-[r]->() | r] AS rs')).toThrow(Unsupported);
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

  test('a graph without relationships: no edge tables, no rows', () => {
    const { g, db, tables } = both((() => { const h = open(); h.run('CREATE (:A {k: 1})'); return h; })());
    expect(tables.types.size).toBe(0);
    for (const cypher of ['MATCH p = (x)-[*0..1]->(y) RETURN p', 'MATCH (x)-->(y) RETURN count(*) AS n', 'MATCH (x) RETURN [(x)--(y) | y.k] AS ys, (x)--() AS e']) {
      expect(onSmaltdb(db, tables, cypher)).toEqual(g.query(cypher));
    }
  });

  test('parameters are typed by their values', () => {
    const { db, tables } = both(social());
    expect(onSmaltdb(db, tables, 'MATCH (p:Person) WHERE p.born > $y AND $flag RETURN count(*) AS n', { y: 1925, flag: true })).toEqual([{ n: 2 }]);
    expect(() => compileQuery(compile('RETURN $nope AS x').plan, tables)).toThrow(Unsupported);
  });
});
