import { describe, expect, test } from 'vitest';
import type { Database } from 'smaltdb-src/engine/database.js';
import type { PlanStatementInput } from 'smaltdb/engine';
import { open } from '../src/index.js';
import { Unsupported } from '../src/smaltdb/compile.js';
import { runOnSmaltdb, type SmaltdbDatabase } from '../src/smaltdb/write.js';
import { social } from './helpers/graphs.js';
import { WRITE_CASES } from './helpers/write-cases.js';
import { Pair, start, stateIn, stateOf } from './helpers/write-pair.js';

/**
 * Cypher writes on smaltdb (ADR 0004; smaltdb ADR 0033, step 8): each statement runs on smaltcy's engine and, through
 * `runOnSmaltdb`, on the same graph in smaltdb. After each one both must give the same rows and counts (or both fail),
 * and the two graphs must be the same: nodes with their ids, labels in order and properties, relationships with their
 * ids, types, ends and properties.
 */

describe('the write cases on smaltdb', () => {
  test.each(WRITE_CASES)('%s', (_name, graph, steps) => {
    const p = start(graph);
    for (const s of steps) p.run(s.cypher, s.params);
  });
});

/**
 * A write that finds its rows by a parameter: the reads inside a write take the parameter as a literal of its kind
 * (compile.ts, `paramKind`), and one compared with a NULL is left out of the statement smaltdb is given.
 */
describe('writes that read a parameter of every kind', () => {
  const values: [string, unknown][] = [
    ["'Ada'", 'Ada'],
    ['1912', 1912],
    ['1912.5', 1912.5],
    ['NaN', NaN],
    ['a whole number past the largest held exactly', 1e300],
    ['true', true],
    ['null', null],
  ];
  test.each(values)('%s', (_name, x) => {
    const p = start('social');
    p.run('MATCH (n:Person) WHERE n.name = $x OR n.born = $x SET n.seen = 1 RETURN count(*) AS n', { x });
    p.run('MATCH (n:Person {born: $x}) SET n.exact = true RETURN count(*) AS n', { x });
    p.run('MATCH (n:Person) WHERE n.born < $x SET n.before = $x RETURN count(*) AS n', { x });
    p.run('MATCH (n:Person) WHERE n.name >= $x CREATE (n)-[:AFTER {x: $x}]->(:Mark) RETURN count(*) AS n', { x });
    p.run('MERGE (n:Person {name: $x}) RETURN count(*) AS n', { x });
    p.run('MATCH (n:Person) WHERE n.born = $x DETACH DELETE n', { x });
  });
});

/** More statements in sequence, compared on both engines after each. */
const SEQUENCES: readonly [string, 'empty' | 'social', readonly string[]][] = [
  // A write whose rows are read before it, with nothing after it in its clause that reads the graph, runs all its rows
  // at once (write.ts, "Writes in batches"): these compare that with smaltcy's engine, row by row.
  ['writes in batches: CREATE', 'social', [
    "UNWIND [1, 2, 3] AS i CREATE q = (:A {i: i, t: i > 1, l: [i, 'x']})-[:R {i: i}]->(:B:C) RETURN q",
    "MATCH (p:Person) WITH p ORDER BY p.name CREATE (p)-[r:WROTE {by: p.name}]->(b:Book {by: p.name, n: size(p.name)})<-[:ABOUT]-(p) RETURN count(*) AS n",
    'MATCH (a:A), (b:B) WHERE a.i = 2 CREATE (a)-[:S]->(b), (b)-[:S]->(a) RETURN count(*) AS n',
    "MATCH (p:Person) OPTIONAL MATCH (p)-[:NOPE]->(q) CREATE (p)-[:R]->(q) RETURN count(*) AS n",
    'UNWIND [] AS i CREATE (:Never {i: i}) RETURN count(*) AS n',
  ]],
  ['writes in batches: SET and REMOVE', 'social', [
    "MATCH (p:Person) SET p.k = p.name + '!' RETURN count(*) AS n",
    'MATCH (p:Person) SET p.born = null RETURN count(*) AS n',
    'MATCH (p:Person) SET p.k = p.k RETURN count(*) AS n',
    'MATCH ()-[r:KNOWS]->() SET r.w = [1, true] RETURN count(*) AS n',
    'MATCH ()-[r:KNOWS]->() REMOVE r.w, r.since RETURN count(*) AS n',
    // A city two people live in: a target in two rows, so the rows run one by one.
    'MATCH (p:Person)-[:LIVES_IN]->(c) SET c.v = 1 RETURN count(*) AS n',
    'MATCH (p:Person)-[:LIVES_IN]->(c) REMOVE c:City RETURN count(*) AS n',
    "MATCH (p:Person) SET p:Tagged:Person, p:Tagged RETURN count(*) AS n",
    'MATCH (p:Tagged) WHERE p.k STARTS WITH \'A\' REMOVE p:Tagged, p:Nope RETURN count(*) AS n',
    'MATCH (n) RETURN labels(n) AS l, properties(n) AS p ORDER BY id(n)',
  ]],
  ['writes in batches: MERGE', 'social', [
    'UNWIND [1, 2, 1, 3, 2] AS i MERGE (n:M {i: i}) RETURN n',
    "CREATE (:M {i: 3}), (:M {i: 4, x: true})",
    'UNWIND [3, 4, 5, 5, 6] AS i MERGE (n:M {i: i}) RETURN n',
    "UNWIND ['Ada', 'Nobody', 'Nobody', 'Grace'] AS name MERGE (p:Person {name: name}) RETURN p",
    'UNWIND [1, 2, 3] AS i MERGE (n:Solo) RETURN n',
    'UNWIND [1, null, 1] AS i MERGE (n:M {i: i, j: 1}) RETURN n',
    'UNWIND [] AS i MERGE (n:M {i: i}) RETURN count(*) AS n',
    'MATCH (n:M) RETURN n.i AS i, n.j AS j, n.x AS x ORDER BY id(n)',
  ]],
  ['writes in batches: DELETE', 'social', [
    "MATCH (a:Person {name: 'Ada'}) CREATE (a)-[:SELF]->(a)",
    'MATCH (a)-[r:KNOWS]-(b) DELETE r RETURN count(*) AS n',
    'MATCH p = (:Person)-[:LIVES_IN]->(:City) WITH p LIMIT 2 DETACH DELETE p RETURN count(*) AS n',
    "MATCH (a:Person {name: 'Ada'}) DETACH DELETE a RETURN count(*) AS n",
    'MATCH (c:City) DELETE c RETURN count(*) AS n',
    'MATCH (n) DETACH DELETE n RETURN count(*) AS n',
  ]],
  ['created nodes, relationships and paths in results', 'empty', [
    "CREATE p = (a:X {k: 1, f: true, l: [1, 'a', false]})-[r:T {w: 2.5, b: false}]->(b:Y:Z) RETURN p, r, a, b, id(a) AS ia, id(r) AS ir",
    'CREATE (n) RETURN n, labels(n) AS l, properties(n) AS p',
    'MATCH (a:X), (b:Y) CREATE (b)-[r:U]->(a), (a)-[s:T]->(a) RETURN type(r) AS t, id(s) AS s, startNode(r).k AS k',
  ]],
  ['properties of every kind keep their kind', 'empty', [
    "CREATE (:K {i: 1, r: 1.5, s: 'x', t: true, f: false, li: [1, 2], ls: ['a'], lb: [true, false], lm: [1, 'a', true], le: []})",
    'MATCH (n:K) RETURN n.t = true AS t, n.f = false AS f, n.t = 1 AS t1, n.lb AS lb, n.lm AS lm, n.le AS le, n.r * 2 AS r2',
    'MATCH (n:K) SET n.t = NOT n.t, n.lb = [x IN n.lb | NOT x], n.i = n.i + 1 RETURN n.t AS t, n.lb AS lb, n.i AS i',
  ]],
  ['SET and REMOVE on nodes and relationships', 'social', [
    "MATCH (a:Person {name: 'Ada'})-[r:KNOWS]->(b) SET r.since = r.since + 1, r.note = 'first', b.friend = true RETURN r.since AS s, b.friend AS f",
    "MATCH ()-[r:KNOWS {note: 'first'}]->() REMOVE r.note, r.missing RETURN properties(r) AS p",
    "MATCH (a:Person {name: 'Ada'}), (b:Person {name: 'Alan'}) SET b = a RETURN properties(b) AS p",
    "MATCH (b:Person {name: 'Ada'}) SET b = {} RETURN properties(b) AS p",
    "MATCH (b:Person {name: 'Grace'}) SET b += {born: null, rank: 'Rear Admiral', ships: ['a', 'b']} RETURN properties(b) AS p",
    "MATCH ()-[r:LIVES_IN]->() SET r += {since: 1900} RETURN count(*) AS n",
    "MATCH (p:Person) WHERE p.born > 1920 SET p:Young:Modern, p:Person REMOVE p:Admiral RETURN p.name AS n, labels(p) AS l ORDER BY n",
    'MATCH (p:Modern) REMOVE p:Modern, p:Nope RETURN labels(p) AS l',
    "MATCH (p:Person {name: 'Grace'}) REMOVE p:Admiral SET p:Admiral RETURN labels(p) AS l",
  ]],
  ['SET on NULL is a no-op', 'social', [
    "OPTIONAL MATCH (p:Nobody) SET p.x = 1, p:Y REMOVE p.z, p:W SET p += {a: 1} RETURN p",
    "MATCH (p:Person {name: 'Ada'}) OPTIONAL MATCH (p)-[r:NOPE]->() SET r.x = 1 RETURN p.name AS n, r",
  ]],
  ['writes see earlier rows: SET reads what the rows before it set', 'social', [
    "MATCH (c:City {name: 'London'}) SET c.n = 0",
    "MATCH (p:Person)-[:LIVES_IN]->(c:City {name: 'London'}) WITH p, c ORDER BY p.name SET c.n = c.n + 1 RETURN p.name AS p, c.n AS n",
    "UNWIND [1, 2, 3] AS i CREATE (n:Cnt {i: i}) WITH n SET n.seen = size([(m:Cnt) | 1]) RETURN n.i AS i, n.seen AS s",
    "MATCH (a:Person) WITH a ORDER BY a.name CREATE (c:Copy {of: a.name}) SET a.copies = coalesce(a.copies, 0) + 1 RETURN c.of AS of, a.copies AS n",
  ]],
  ['results show entities as they are at the end of the statement', 'social', [
    "MATCH (c:City {name: 'London'}) UNWIND [1, 2, 3] AS i SET c.last = i RETURN i, c.last AS now, c",
  ]],
  ['LIMIT stops the writes that feed it', 'empty', [
    'UNWIND range(1, 5) AS i CREATE (n:L {i: i}) RETURN n.i AS i LIMIT 2',
    'UNWIND range(1, 5) AS i CREATE (n:L {i: i}) RETURN n.i AS i SKIP 1 LIMIT 2',
    'UNWIND range(1, 5) AS i CREATE (n:L {i: i}) RETURN n.i AS i LIMIT 0',
    'MATCH (n:L) RETURN count(*) AS c',
  ]],
  ['ORDER BY and aggregates after writes', 'empty', [
    'UNWIND [3, 1, 2] AS i CREATE (n:O {i: i}) RETURN n.i AS i ORDER BY i DESC',
    'UNWIND [3, 1, 2] AS i CREATE (n:P {i: i}) WITH count(n) AS c, sum(n.i) AS s CREATE (:Sum {c: c, s: s}) RETURN c, s',
    'MATCH (n) WITH n.i AS i, count(*) AS c WHERE i IS NOT NULL RETURN i, c ORDER BY i',
    'UNWIND [1, 1, 2] AS i CREATE (n:Q {i: i}) RETURN DISTINCT n.i AS i',
    'CREATE (a:Z {k: 1}) WITH a MATCH (b:Z) RETURN a.k AS a, count(b) AS n',
    'UNWIND [1, 2] AS x WITH x WHERE NOT EXISTS { MATCH (:Once) } CREATE (:Once {x: x})',
    'MATCH (o:Once) RETURN o.x AS x',
  ]],
  ['DELETE: paths, lists and nodes deleted twice', 'social', [
    "MATCH (n:Person {name: 'Barbara'}) DETACH DELETE n SET n.x = 1 REMOVE n.name RETURN n, n.name AS name",
    "MATCH (:Person {name: 'Grace'})-[r:LIVES_IN]->() DELETE r SET r.x = 1 RETURN r, r.x AS x, id(r) AS id, r IS NULL AS n",
    "MATCH p = (:Person {name: 'Ada'})-[:KNOWS]->(:Person) DETACH DELETE p",
    "MATCH (c:City) WITH collect(c) AS cs DETACH DELETE cs RETURN size(cs) AS n",
    "MATCH (a:Person {name: 'Grace'}), (b:Person {name: 'Grace'}) DETACH DELETE a, b",
    "MATCH (:Person {name: 'Alan'})-[rs:KNOWS*1..2]->(x) WITH rs ORDER BY size(rs) DESC LIMIT 1 DELETE rs RETURN size(rs) AS n",
    "MATCH (a:Person)-[r]->(b) DELETE r, r RETURN count(*) AS n",
    'MATCH (n) DELETE n',
    'MATCH (n) RETURN count(*) AS n',
  ]],
  ['DETACH DELETE of self-loops and parallel relationships', 'empty', [
    'CREATE (a:N {k: 1})-[:R]->(a), (a)-[:R]->(b:N {k: 2}), (a)-[:S]->(b), (b)-[:R]->(a)',
    'MATCH (a:N {k: 1}) DETACH DELETE a RETURN a',
    'MATCH (n) RETURN n',
  ]],
  ['MERGE: patterns, ON CREATE and ON MATCH', 'social', [
    "MERGE (c:City {name: 'Paris'}) ON CREATE SET c.new = true ON MATCH SET c.new = false RETURN c.name AS n, c.new AS new",
    "MERGE (c:City {name: 'Paris'}) ON CREATE SET c.new = true ON MATCH SET c.new = false RETURN c.name AS n, c.new AS new",
    "MATCH (p:Person {name: 'Ada'}) MERGE (p)-[r:LIVES_IN]->(c:City {name: 'Paris'}) ON CREATE SET r.since = 1830 RETURN c.name AS c, r.since AS s",
    "MATCH (p:Person {name: 'Ada'}) MERGE (p)-[r:LIVES_IN]->(c:City) ON MATCH SET r.checked = true RETURN c.name AS c, r.checked AS k ORDER BY c",
    "MATCH (p:Person) MERGE (p)-[:FAN_OF]->(:Team {name: p.name + ' FC'}) RETURN count(*) AS n",
    "MERGE p = (a:Q {k: 1})-[:R]->(b:Q {k: 2}) RETURN length(p) AS l, a.k AS a, b.k AS b",
    "MERGE p = (a:Q {k: 1})-[:R]->(b:Q {k: 2}) RETURN length(p) AS l, a.k AS a, b.k AS b",
    "MATCH (a:Person {name: 'Alan'}), (b:Person {name: 'Ada'}) MERGE (a)-[r:KNOWS]-(b) RETURN id(r) AS id, startNode(r).name AS s",
    "MATCH (a:Person {name: 'Barbara'}), (b:Person {name: 'Ada'}) MERGE (a)-[r:KNOWS]-(b) RETURN startNode(r).name AS s, endNode(r).name AS e",
  ]],
  ['parameters', 'empty', [
    "CREATE (n:P $props) SET n.flags = $flags, n.when = $when RETURN n",
    'MATCH (n:P) SET n += $more RETURN properties(n) AS p',
    'MATCH (n:P) SET n = $props RETURN properties(n) AS p',
  ]],
  ['new labels and types, added as they are first written', 'social', [
    "MATCH (p:Person {name: 'Ada'}) CREATE (p)-[:WROTE]->(:Note {text: 'G'}) SET p:Author",
    'MATCH (a:Author)-[:WROTE]->(n:Note) RETURN a.name AS a, n.text AS t',
    "MATCH (n:Note) DETACH DELETE n",
    'MATCH (n:Note) RETURN count(*) AS c',
  ]],
  ['labels and types that differ only in case from the graph’s: two of each', 'social', [
    "CREATE (:person {name: 'lower'}), (:PERSON {name: 'upper'})",
    "MATCH (p:Person {name: 'Ada'}), (q:person) CREATE (p)-[:knows {w: 1}]->(q), (q)-[:Knows {w: 2}]->(p), (p)-[:KNOWS {w: 3}]->(p)",
    'MATCH (n:Person) RETURN n.name AS n ORDER BY n',
    'MATCH (n:person) RETURN n.name AS n, labels(n) AS l',
    'MATCH (n:PERSON) RETURN n.name AS n, labels(n) AS l',
    'MATCH (a)-[r:knows]->(b) RETURN a.name AS a, type(r) AS t, b.name AS b',
    'MATCH (a)-[r:KNOWS]->(b) RETURN a.name AS a, r.w AS w, b.name AS b ORDER BY a, b',
    'MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS c ORDER BY t',
    "MATCH (n:Person {name: 'Grace'}) SET n:person, n:PERSON RETURN labels(n) AS l",
    "MATCH (n:person {name: 'Grace'}) REMOVE n:Person RETURN labels(n) AS l",
    'MATCH (n:person) RETURN n.name AS n ORDER BY n',
    "MERGE (a:person {name: 'lower'})-[r:KNOWS]->(b:Person {name: 'Ada'}) RETURN type(r) AS t",
    "MERGE (a:Person {name: 'lower'}) RETURN labels(a) AS l",
    'MATCH ()-[r:knows]->() DELETE r',
    'MATCH (n:PERSON) DETACH DELETE n',
    'MATCH (n) RETURN n.name AS n, labels(n) AS l ORDER BY n',
  ]],
  ['a new graph with labels and types spelled two ways', 'empty', [
    'CREATE (a:A {k: 1})-[:R]->(b:a {k: 2})-[:r]->(c:A:a {k: 3})',
    'MATCH (x:A)-[:R]->(y:a) RETURN x.k AS x, y.k AS y',
    'MATCH (x:a)-[:r]->(y:A) RETURN x.k AS x, y.k AS y',
    'MATCH (x:a)-[:R]->(y) RETURN x.k AS x',
    'MATCH (n:A:a) SET n:`Smaltcy:Node` RETURN labels(n) AS l',
    'MATCH (n:`Smaltcy:Node`) RETURN n.k AS k',
  ]],
];

const PARAMS = { props: { name: 'P', n: 1, ok: true, tags: ['a', 'b'] }, flags: [true, false, true], when: 1.5, more: { n: 2, ok: null, x: false } };

describe('more writes: both engines give the same rows, counts and graph', () => {
  test.each(SEQUENCES)('%s', (_name, graph, statements) => {
    const p = start(graph);
    for (const s of statements) p.run(s, PARAMS);
  });
});

/** Statements that fail on smaltcy's engine, some after writing: they fail on smaltdb too, which they leave as it was. */
const FAILING: readonly [string, string][] = [
  ['DELETE of a node with relationships, after a CREATE', "CREATE (:Brand {x: 1})-[:MADE]->(:Thing) WITH 1 AS x MATCH (p:Person {name: 'Ada'}) DELETE p"],
  ['DELETE of a node with relationships, after writes on earlier rows', "UNWIND [1, 2] AS i CREATE (:Tmp) WITH i WHERE i = 2 MATCH (p:Person {name: 'Ada'}) DELETE p"],
  ['a relationship to NULL', 'OPTIONAL MATCH (x:Nobody) CREATE (:New)-[:R]->(x)'],
  ['an error after a SET', "MATCH (p:Person {name: 'Ada'}) SET p.x = 1 WITH p RETURN 1 / 0 AS boom"],
  ['a map as a property', "MATCH (p:Person {name: 'Ada'}) SET p.m = {a: 1}"],
  ['a list of lists as a property', "MATCH (p:Person {name: 'Ada'}) SET p.l = [[1]]"],
  ['SET a property of a string', "MATCH (p:Person {name: 'Ada'}) WITH p.name AS n SET n.x = 1"],
  ['SET a label on a string', "MATCH (p:Person {name: 'Ada'}) WITH p.name AS n SET n:X"],
  ['DELETE a string', "MATCH (p:Person {name: 'Ada'}) WITH p.name AS n DELETE n"],
  ['SET properties to a number', "MATCH (p:Person {name: 'Ada'}) SET p = 1"],
];

describe('failing writes: an error on both engines, and smaltdb rolled back', () => {
  test.each(FAILING)('%s', (_name, cypher) => {
    const p = start('social');
    expect(() => social().run(cypher)).toThrow();
    // Pair.run checks that smaltdb fails too, and that its graph is as it was.
    p.run(cypher);
  });
});

const AFTER_DELETE = 'labels(), properties(), type(), startNode(), endNode(), nodes() and relationships() after a DELETE, and paths and lists of nodes or relationships in its results';

/** Writes smaltdb can't hold as smaltcy does, refused before anything is written: the list can only shrink. */
const UNSUPPORTED: readonly [string, string, string][] = [
  ['the reserved label', 'CREATE (:`smaltcy:node`)', `the label smaltcy:node, which is reserved`],
  ['MERGE with a parameter map', 'MERGE (n:Person $props)', 'a pattern property map given as a parameter'],
  ['type() after DELETE', "MATCH (:Person {name: 'Grace'})-[r:LIVES_IN]->() DELETE r RETURN type(r) AS t", 'AFTER_DELETE'],
  ['labels() after DELETE', "MATCH (n:Person {name: 'Edsger'}) DETACH DELETE n WITH n RETURN labels(n) AS l", 'AFTER_DELETE'],
  ['a path in the results of a DELETE', "MATCH p = (:Person {name: 'Edsger'})-->() DETACH DELETE p RETURN p", 'AFTER_DELETE'],
  ['DISTINCT between writes', 'UNWIND [1, 1, 2] AS x CREATE (:D {x: x}) WITH DISTINCT x CREATE (:E {x: x})', 'DISTINCT between writes'],
];

describe('writes refused on smaltdb', () => {
  test.each(UNSUPPORTED)('%s', (_name, cypher, feature) => {
    const p = start('social');
    // smaltcy runs them, but for a function of a deleted node or relationship, which it fails on.
    if (/\(\) after DELETE/.test(_name)) expect(() => social().run(cypher, PARAMS)).toThrow(/does not exist/);
    else expect(() => social().run(cypher, PARAMS)).not.toThrow();
    const before = stateIn(p.db, p.tables);
    const labels = p.db.catalog.graph('graph')!.nodes.map((n) => n.label);
    let error: unknown;
    try {
      runOnSmaltdb(p.db, cypher, { params: PARAMS });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Unsupported);
    expect((error as Unsupported).feature).toBe(feature === 'AFTER_DELETE' ? AFTER_DELETE : feature);
    expect(stateIn(p.db, p.tables)).toEqual(before);
    expect(p.db.catalog.graph('graph')!.nodes.map((n) => n.label)).toEqual(labels);
  });
});

describe('transactions on smaltdb', () => {
  test('a failing statement rolls back its rows and its new labels and types', () => {
    const p = start('social');
    const graph = () => p.db.catalog.graph('graph')!;
    const labels = graph().nodes.map((n) => n.label);
    const types = graph().edges.map((e) => e.type);
    const before = stateIn(p.db, p.tables);
    const cypher = "CREATE (:Brand {x: 1})-[:MADE]->(:Thing) WITH 1 AS x MATCH (q:Person {name: 'Ada'}) DELETE q";
    expect(() => runOnSmaltdb(p.db, cypher)).toThrow(/DETACH/);
    expect(stateIn(p.db, p.tables)).toEqual(before);
    expect(graph().nodes.map((n) => n.label)).toEqual(labels);
    expect(graph().edges.map((e) => e.type)).toEqual(types);
    expect(p.tables.labelTables.has('Brand')).toBe(false);
    expect(p.db.inTransaction).toBe(false);
  });

  test("inside the caller's transaction: the statement's savepoint, then the caller's commit or rollback", () => {
    const p = start('empty');
    p.db.queryPlan({ kind: 'transaction', action: 'begin', mode: 'deferred' });
    runOnSmaltdb(p.db, 'CREATE (:A {k: 1})');
    expect(() => runOnSmaltdb(p.db, 'CREATE (:A {k: 2}) WITH 1 AS x RETURN 1 / 0 AS boom')).toThrow();
    expect(p.db.inTransaction).toBe(true);
    expect(stateIn(p.db, p.tables).nodes.map((n) => n.properties)).toEqual([{ k: 1 }]);
    p.db.queryPlan({ kind: 'transaction', action: 'rollback' });
    expect(stateIn(p.db, p.tables).nodes).toEqual([]);
  });

  test('a statement that only reads is one query', () => {
    const p = start('social');
    const r = runOnSmaltdb(p.db, "MATCH (n:Person {name: 'Ada'}) RETURN n.born AS b");
    expect(r.rows).toEqual([[1815]]);
    expect(r.counts).toEqual({ nodesCreated: 0, nodesDeleted: 0, relationshipsCreated: 0, relationshipsDeleted: 0, propertiesSet: 0, labelsAdded: 0, labelsRemoved: 0 });
  });
});

describe('new ids on smaltdb', () => {
  /** A database that keeps what it is given: the texts of Cypher statements, and the statements given as plans. */
  function recording(db: Database): { db: SmaltdbDatabase; texts: string[]; statements: PlanStatementInput[] } {
    const texts: string[] = [];
    const statements: PlanStatementInput[] = [];
    return {
      db: {
        query: (text, params, options) => {
          texts.push(text);
          return db.query(text, params, options);
        },
        queryPlan: (stmt, params) => {
          statements.push(stmt);
          return db.queryPlan(stmt, params as never);
        },
        get inTransaction() {
          return db.inTransaction;
        },
        get catalog() {
          return db.catalog;
        },
      },
      texts,
      statements,
    };
  }
  test('smaltdb numbers what a CREATE makes, as smaltcy does: the statement is all it is given', () => {
    const p = start('social');
    const r = recording(p.db);
    const cypher = "CREATE (a:Person {name: 'New'})-[:KNOWS]->(b:City {name: 'Newer'}) RETURN id(a) AS a, id(b) AS b";
    const created = runOnSmaltdb(r.db, cypher);
    const mine = p.g.run(cypher);
    expect(created.rows).toEqual(mine.rows);
    expect(stateIn(p.db, p.tables)).toEqual(stateOf(p.g));
    // The statement's text and nothing else: no statement reads a table for its largest id.
    expect(r.texts).toEqual([cypher]);
    expect(r.statements).toEqual([]);
  });

  test('which ids a statement that fails had taken can differ (ADR 0004, known differences)', () => {
    const next = (p: Pair, cypher: string) => [p.g.run(cypher).rows, runOnSmaltdb(p.db, cypher).rows];
    const fails = (p: Pair, cypher: string, message: string) => {
      expect(() => p.g.run(cypher), cypher).toThrow(message);
      expect(() => runOnSmaltdb(p.db, cypher), cypher).toThrow(message);
    };
    // smaltcy makes a write's rows one at a time: the two before the one that fails took their ids. smaltdb computes
    // every row's values before it writes any of them, and took none.
    const rows = start('social');
    fails(rows, 'UNWIND [1, 2, 0] AS i CREATE (:N {v: 10 / i})', 'Division by zero');
    expect(next(rows, 'CREATE (x:After) RETURN id(x) AS x')).toEqual([[[9]], [[7]]]);
    // A relationship to a node the statement deleted: smaltdb took the relationship's id before its rule refused the
    // row, smaltcy's store looks at the ends first.
    const gone = start('social');
    fails(gone, "MATCH (n:Person {name: 'Ada'}) DETACH DELETE n WITH n MATCH (m:Person {name: 'Alan'}) CREATE (m)-[:R]->(n)", 'Node 0 does not exist');
    expect(next(gone, "MATCH (a:Person {name: 'Alan'}), (b:Person {name: 'Grace'}) CREATE (a)-[r:AFTER]->(b) RETURN id(r) AS r")).toEqual([[[9]], [[10]]]);
    // On either, no id is given twice.
    for (const p of [rows, gone]) {
      const ids = (cypher: string) => (runOnSmaltdb(p.db, cypher).rows as number[][]).map((r) => r[0]!);
      for (const all of [ids('MATCH (n) RETURN id(n) AS id'), ids('MATCH ()-[r]->() RETURN id(r) AS id')]) expect(new Set(all).size).toBe(all.length);
    }
  });

  test('a graph with no node and no relationship: the first ids, as on smaltcy', () => {
    const p = new Pair(open());
    p.run('CREATE (a:A {i: 1})-[:R]->(b:B {i: 2}) RETURN id(a) AS a, id(b) AS b');
    p.run('MATCH (a:A) CREATE (a)-[:R {n: 1}]->(:B {i: 3})-[:S]->(a)');
    p.run('MATCH ()-[r]->() RETURN id(r) AS r ORDER BY r');
    p.run('MATCH (n) RETURN id(n) AS n ORDER BY n');
  });
});

describe('indexes on smaltdb', () => {
  /** The graph's indexes in smaltdb's catalog: name and table. */
  const indexes = (db: Database) =>
    (db.queryPlan({ kind: 'query', plan: { op: 'scan', table: 'sqlite_schema', columns: [0, 1, 2] } }).rows as string[][])
      .filter(([type, name]) => type === 'index' && name!.startsWith('graph_ix_'))
      .map(([, name, table]) => [name, table]);
  const hex = (x: string) => Buffer.from(x).toString('hex');

  test('an index is an expression index on the node table, and results stay the same', () => {
    const p = start('social');
    p.run('CREATE INDEX FOR (p:Person) ON (p.name)');
    p.run('CREATE INDEX FOR (p:Person) ON (p.name)');
    // Cypher's labels differ by case; smaltdb's names don't, so each has its own index.
    p.run('CREATE INDEX FOR (p:person) ON (p.name)');
    expect(indexes(p.db)).toEqual([[`graph_ix_${hex('Person')}_${hex('name')}`, 'graph_node'], [`graph_ix_${hex('person')}_${hex('name')}`, 'graph_node']]);
    for (const cypher of [
      "MATCH (p:Person {name: 'Grace'}) RETURN p.born AS b",
      "MATCH (p:Person {name: 'Grace'}) SET p.name = 'Grace H'",
      "MATCH (p:Person {name: 'Grace'}) RETURN p.born AS b",
      "MATCH (p:Person) WHERE p.name = 'Grace H' RETURN p.born AS b",
      "CREATE (:City {name: 'Ada'})",
      "MATCH (p:Person {name: 'Ada'}) RETURN count(p) AS n",
      'DROP INDEX ON :Person(name)',
      'DROP INDEX ON :Person(name)',
    ]) p.run(cypher);
    expect(indexes(p.db)).toEqual([[`graph_ix_${hex('person')}_${hex('name')}`, 'graph_node']]);
  });
});

/**
 * A write to a node or relationship the statement has deleted. smaltcy's stores fail on some ("Node 0 does not
 * exist"): a label set or removed, properties replaced, a relationship from or to the node, and a node or relationship
 * given as a map of properties. Others are no-ops: a property set, removed or merged in, a second DELETE.
 */
describe('a write to what the statement deleted', () => {
  const ADA = "MATCH (n:Person {name: 'Ada'}) DETACH DELETE n";
  const KNOWS = "MATCH (:Person {name: 'Ada'})-[r:KNOWS]->(m) DELETE r";
  const AFTER = 'CREATE (x:After)-[r:AFTER]->(y:After) RETURN id(x) AS x, id(r) AS r, id(y) AS y';
  // A relationship from or to the node that went: smaltdb has taken the relationship's id by the time its rule
  // refuses it, smaltcy's store has not (ADR 0004, known differences), so only new nodes are compared after these.
  const TO_GONE: readonly string[] = [
    `${ADA} CREATE (n)-[:R]->(:X)`,
    `${ADA} WITH n MATCH (m:Person {name: 'Alan'}) CREATE (m)-[:R]->(n)`,
    `${ADA} MERGE (n)-[:R]->(n)`,
    "MATCH (a:Person {name: 'Ada'}), (b:Person {name: 'Alan'}) DETACH DELETE a MERGE (a)-[:R]->(b)",
  ];
  const FAILS: readonly string[] = [
    `${ADA} SET n:Gone`,
    `${ADA} SET n:Person`,
    `${ADA} REMOVE n:Person`,
    `${ADA} REMOVE n:Nope`,
    `${ADA} SET n = {x: 1}`,
    `${ADA} SET n = {}`,
    `${KNOWS} SET r = {x: 1}`,
    `${ADA} WITH n MATCH (m:Person {name: 'Alan'}) SET m = n`,
    `${ADA} WITH n MATCH (m:Person {name: 'Alan'}) SET m += n`,
    `${KNOWS} SET m = r`,
    `${KNOWS} SET m += r`,
    ...TO_GONE,
    `${ADA} WITH n MERGE (m:Zed {k: 1}) ON CREATE SET n:Gone`,
    `${ADA} WITH n MERGE (m:Zed {k: 1}) ON CREATE SET n = {x: 1}`,
    // The first row fails, after its node went.
    'MATCH (n:Person) WITH n ORDER BY n.name LIMIT 2 DETACH DELETE n REMOVE n:Person',
    // What is there is written, then the row's deleted relationship is read as a map.
    "MATCH (a:Person {name: 'Ada'})-[r:KNOWS]->(b) DELETE r SET a:Changed, b = {name: 'B'}, a += r",
  ];
  test.each(FAILS)('fails as on smaltcy, and is undone: %s', (cypher) => {
    // It fails: on a graph of its own, so that both engines of the pair run it as often.
    expect(() => social().run(cypher), cypher).toThrow(/^(Node|Relationship) \d+ does not exist$/);
    const p = start('social');
    // The same error on both, and smaltdb's graph as it was (`Pair.run`); the second time by the statement kept.
    for (let i = 0; i < 2; i++) p.run(cypher);
    // The ids the statement took before it failed are not given again, on either.
    p.run(TO_GONE.includes(cypher) ? 'CREATE (x:After) RETURN id(x) AS x' : AFTER);
  });

  const RUNS: readonly string[] = [
    `${ADA} SET n.x = 1`,
    `${ADA} SET n += {x: 1}`,
    `${ADA} REMOVE n.born`,
    `${ADA} DETACH DELETE n`,
    `${KNOWS} SET r.x = 1`,
    `${KNOWS} SET r += {x: 1}`,
    `${KNOWS} REMOVE r.since`,
    `${ADA} WITH n MATCH (m:Person {name: 'Alan'}) SET m.gone = n.name`,
    // After a DELETE, what is still there is written as ever.
    "MATCH (a:Person {name: 'Ada'})-[r:KNOWS]->(b) DELETE r SET a:Changed, b = {name: 'B'} REMOVE b:Person",
    "MATCH (a:Person {name: 'Ada'})-[r:KNOWS]->(b) DELETE r CREATE (a)-[:R {w: r.since}]->(b)",
    "MATCH (a:Person {name: 'Ada'})-[r:KNOWS]->(b) DELETE r WITH a, b MATCH (a)-[q]->(c) SET q = {w: 1}, c = a RETURN count(*) AS c",
    // A NULL is no node: nothing is written for it, and it is no error.
    "OPTIONAL MATCH (z:Nope) WITH z MATCH (a:Person {name: 'Ada'})-[r:KNOWS]->(b) DELETE r SET z:L, z = {a: 1}, b += z",
  ];
  test.each(RUNS)('runs as on smaltcy: %s', (cypher) => {
    const p = start('social');
    p.run(cypher);
    p.run(AFTER);
    p.run('MATCH (n) RETURN labels(n) AS l, properties(n) AS p ORDER BY id(n)');
  });
});
