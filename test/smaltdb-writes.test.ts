import { describe, expect, test } from 'vitest';
import type { Database } from 'smaltdb-src/engine/database.js';
import { compile } from '../src/cypher/index.js';
import { open, type Graph } from '../src/index.js';
import { Unsupported } from '../src/smaltdb/compile.js';
import type { GraphTables } from '../src/smaltdb/schema.js';
import { runOnSmaltdb } from '../src/smaltdb/write.js';
import { social } from './helpers/graphs.js';
import { both, dataOf } from './helpers/smaltdb.js';
import { WRITE_CASES } from './helpers/write-cases.js';

/**
 * Cypher writes on smaltdb (ADR 0004; smaltdb ADR 0033, step 8): each statement runs on smaltcy's engine and, through
 * `runOnSmaltdb`, on the same graph in smaltdb. After each one both must give the same rows and counts (or both fail),
 * and the two graphs must be the same: nodes with their ids, labels in order and properties, relationships with their
 * ids, types, ends and properties.
 */

interface State {
  nodes: { id: number; labels: string[]; properties: Record<string, unknown> }[];
  relationships: { id: number; type: string; start: number; end: number; properties: Record<string, unknown> }[];
}

const byId = <T extends { id: number }>(xs: T[]) => xs.sort((a, b) => a.id - b.id);

/** smaltcy's graph. */
function stateOf(g: Graph): State {
  const data = dataOf(g);
  return {
    nodes: byId(data.nodes.map((n) => ({ id: n.id as number, labels: [...(n.labels ?? [])], properties: { ...n.properties } }))),
    relationships: byId(data.relationships.map((r) => ({ id: r.id!, type: r.type, start: r.start as number, end: r.end as number, properties: { ...r.properties } }))),
  };
}

/** The graph in smaltdb, read back from its tables. */
function stateIn(db: Database, t: GraphTables): State {
  const rows = (table: string, columns: number[]) => db.queryPlan({ kind: 'query', plan: { op: 'scan', table, columns } }).rows as unknown[][];
  const labels = new Map<number, string[]>();
  for (const [, node, label] of rows(t.labels, [-1, 0, 1]).sort((a, b) => (a[0] as number) - (b[0] as number))) {
    labels.set(node as number, [...(labels.get(node as number) ?? []), label as string]);
  }
  return {
    nodes: byId(rows(t.nodes, [0, 1]).map(([id, props]) => ({ id: id as number, labels: labels.get(id as number) ?? [], properties: props as Record<string, unknown> }))),
    relationships: byId(
      [...t.types].flatMap(([type, table]) =>
        rows(table, [-1, 0, 1, 2]).map(([id, start, end, props]) => ({ id: id as number, type, start: start as number, end: end as number, properties: props as Record<string, unknown> })),
      ),
    ),
  };
}

/** A graph on both engines, kept in step. */
class Pair {
  readonly g: Graph;
  readonly db: Database;
  tables: GraphTables;

  constructor(g: Graph) {
    const b = both(g);
    this.g = g;
    this.db = b.db;
    this.tables = b.tables;
  }

  /** Runs a statement on both: the same rows and counts, or both fail and smaltdb's graph is as it was; then the same graphs. */
  run(cypher: string, params: Readonly<Record<string, unknown>> = {}): void {
    let mine: ReturnType<Graph['run']> | undefined;
    let mineError: unknown;
    try {
      mine = this.g.run(cypher, params);
    } catch (e) {
      mineError = e;
    }
    const before = stateIn(this.db, this.tables);
    let theirs: ReturnType<typeof runOnSmaltdb> | undefined;
    let theirsError: unknown;
    try {
      theirs = runOnSmaltdb(this.db, compile(cypher).plan, this.tables, { params });
      this.tables = theirs.tables;
    } catch (e) {
      theirsError = e;
    }
    if (theirsError instanceof Unsupported) throw theirsError;
    if (mineError !== undefined) {
      expect(theirsError, `${cypher}: fails on smaltcy (${String(mineError)}), not on smaltdb`).toBeDefined();
      expect(stateIn(this.db, this.tables), `${cypher}: rolled back`).toEqual(before);
    } else {
      if (theirsError !== undefined) throw theirsError;
      expect(theirs!.columns, cypher).toEqual(mine!.columns);
      expect(theirs!.rows, cypher).toEqual(mine!.rows);
      expect(theirs!.counts, cypher).toEqual(mine!.counts);
    }
    expect(stateIn(this.db, this.tables), `${cypher}: the graph`).toEqual(stateOf(this.g));
  }
}

const start = (graph: 'empty' | 'social') => new Pair(graph === 'social' ? social() : open());

describe('the write cases on smaltdb', () => {
  test.each(WRITE_CASES)('%s', (_name, graph, steps) => {
    const p = start(graph);
    for (const s of steps) p.run(s.cypher, s.params);
  });
});

/** More statements in sequence, compared on both engines after each. */
const SEQUENCES: readonly [string, 'empty' | 'social', readonly string[]][] = [
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
  ['a label that differs from the graph’s only in case', 'CREATE (:person)', 'the label person beside Person (a smaltdb property graph finds them ignoring case)'],
  ['a type that differs from the graph’s only in case', "MATCH (p:Person {name: 'Ada'}) CREATE (p)-[:knows]->(p)", 'the relationship type knows beside KNOWS (a smaltdb property graph finds them ignoring case)'],
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
      runOnSmaltdb(p.db, compile(cypher).plan, p.tables, { params: PARAMS });
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
  test('a failing statement rolls back its rows, its new labels and types, and the tables it was given are unchanged', () => {
    const p = start('social');
    const graph = () => p.db.catalog.graph('graph')!;
    const labels = graph().nodes.map((n) => n.label);
    const types = graph().edges.map((e) => e.type);
    const before = stateIn(p.db, p.tables);
    const tables = p.tables;
    const cypher = "CREATE (:Brand {x: 1})-[:MADE]->(:Thing) WITH 1 AS x MATCH (q:Person {name: 'Ada'}) DELETE q";
    expect(() => runOnSmaltdb(p.db, compile(cypher).plan, p.tables)).toThrow(/DETACH/);
    expect(stateIn(p.db, p.tables)).toEqual(before);
    expect(graph().nodes.map((n) => n.label)).toEqual(labels);
    expect(graph().edges.map((e) => e.type)).toEqual(types);
    expect(tables.labelTables.has('Brand')).toBe(false);
    expect(p.db.inTransaction).toBe(false);
  });

  test("inside the caller's transaction: the statement's savepoint, then the caller's commit or rollback", () => {
    const p = start('empty');
    p.db.queryPlan({ kind: 'transaction', action: 'begin', mode: 'deferred' });
    const r = runOnSmaltdb(p.db, compile('CREATE (:A {k: 1})').plan, p.tables);
    expect(() => runOnSmaltdb(p.db, compile('CREATE (:A {k: 2}) WITH 1 AS x RETURN 1 / 0 AS boom').plan, r.tables)).toThrow();
    expect(p.db.inTransaction).toBe(true);
    expect(stateIn(p.db, r.tables).nodes.map((n) => n.properties)).toEqual([{ k: 1 }]);
    p.db.queryPlan({ kind: 'transaction', action: 'rollback' });
    expect(stateIn(p.db, p.tables).nodes).toEqual([]);
  });

  test('a statement that only reads is one query', () => {
    const p = start('social');
    const r = runOnSmaltdb(p.db, compile("MATCH (n:Person {name: 'Ada'}) RETURN n.born AS b").plan, p.tables);
    expect(r.rows).toEqual([[1815]]);
    expect(r.tables).toBe(p.tables);
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
