import { describe, expect, test } from 'vitest';
import type { Database } from 'smaltdb-src/engine/database.js';
import { compile } from '../src/cypher/index.js';
import { open } from '../src/index.js';
import { Unsupported } from '../src/smaltdb/compile.js';
import { keptShapes } from '../src/smaltdb/shape.js';
import { runOnSmaltdb, type SmaltdbDatabase } from '../src/smaltdb/write.js';
import { WRITE_CASES } from './helpers/write-cases.js';
import { type Pair, start as startPair, stateIn, stateOf } from './helpers/write-pair.js';

/**
 * Writes kept by their shape (src/smaltdb/write.ts, `Runner.site`; ADR 0004, "Writes"). The statements the runner
 * makes for a Cypher write are kept for the write's shape, with the rows it holds and its own values (ids, the rows it
 * writes) as their parameters, and the next write of the shape runs them. Whichever statements a write runs, it must
 * give the rows and counts smaltcy's engine gives and leave the same graph: `Pair.run` checks that after each one.
 */

/** A graph on both engines, with smaltcy's numbering of new ids: these tests delete, and fail, and then create. */
const start = (graph: 'empty' | 'social', through?: (db: Database) => SmaltdbDatabase): Pair => startPair(graph, through, true);

/** A smaltdb database that counts the statements it is asked to prepare. */
function counting(counter: { n: number }): (db: Database) => SmaltdbDatabase {
  return (db) => ({
    queryPlan: (stmt, params) => db.queryPlan(stmt, params as never),
    preparePlan: (stmt) => {
      counter.n++;
      return db.preparePlan(stmt);
    },
    get inTransaction() {
      return db.inTransaction;
    },
  });
}

/** A smaltdb database that counts the statements it runs: those given as plans and those it prepared. */
function countingRuns(counter: { n: number }): (db: Database) => SmaltdbDatabase {
  return (db) => ({
    queryPlan: (stmt, params) => {
      counter.n++;
      return db.queryPlan(stmt, params as never);
    },
    preparePlan: (stmt) => {
      const prepared = db.preparePlan(stmt);
      return { result: (params) => (counter.n++, prepared.result(params)) };
    },
    get inTransaction() {
      return db.inTransaction;
    },
  });
}

/** A smaltdb database that prepares nothing: every statement goes by its plan. */
const unprepared = (db: Database): SmaltdbDatabase => ({
  queryPlan: (stmt, params) => db.queryPlan(stmt, params as never),
  get inTransaction() {
    return db.inTransaction;
  },
});

describe('the write cases, run again on the graph they leave: by the statements kept for them', () => {
  test.each(WRITE_CASES)('%s', (_name, graph, steps) => {
    const p = start(graph);
    // The second time each statement's shape is known, unless the graph has other labels and types by then.
    for (let round = 0; round < 3; round++) for (const s of steps) p.run(s.cypher, s.params);
  });

  test.each(WRITE_CASES)('%s, on a database that prepares nothing', (_name, graph, steps) => {
    const p = start(graph, unprepared);
    for (let round = 0; round < 2; round++) for (const s of steps) p.run(s.cypher, s.params);
  });
});

/** Writes of one shape each: `text(i)` differs from the next only in its values. `first` runs once before them. */
const SHAPES: readonly [string, 'empty' | 'social', { first?: readonly string[]; text: (i: number) => string | readonly string[]; params?: (i: number) => Record<string, unknown> }][] = [
  ['create a node', 'empty', { first: ['CREATE (:N {i: -1})'], text: (i) => `CREATE (:N {i: ${i}, name: 'n${i}', half: ${i / 2}})` }],
  ['create a node from parameters', 'empty', { first: ['CREATE (:N {i: -1})'], text: () => 'CREATE (n:N {i: $i, name: $name, flag: $flag}) RETURN n.i AS i, n.flag AS flag', params: (i) => ({ i, name: `n${i}`, flag: i % 2 === 0 }) }],
  ['create a node with two labels and a relationship from a match', 'social', { first: ["MATCH (a:Person {name: 'Ada'}) CREATE (a)-[:MADE {i: -1}]->(:Thing:Made {i: -1})"], text: (i) => `MATCH (a:Person {name: 'Ada'}) CREATE (a)-[:MADE {i: ${i}}]->(t:Thing:Made {i: ${i}}) RETURN t.i AS i` }],
  ['create a relationship between matched nodes', 'social', { first: ["MATCH (a:Person {name: 'Ada'}), (b:Person {name: 'Alan'}) CREATE (a)-[:SAW {n: -1}]->(b)"], text: (i) => `MATCH (a:Person {name: 'Ada'}), (b:Person {name: 'Alan'}) CREATE (a)-[r:SAW {n: ${i}}]->(b) RETURN r.n AS n` }],
  ['set a property', 'social', { text: (i) => `MATCH (p:Person {name: 'Ada'}) SET p.n = ${i}` }],
  ['set a property to a value computed from the node', 'social', { text: (i) => `MATCH (p:Person {name: 'Ada'}) SET p.n = p.born + ${i}, p.label = p.name + '-${i}' RETURN p.n AS n, p.label AS label` }],
  ['set a property and return it', 'social', { text: (i) => `MATCH (p:Person {name: 'Alan'}) SET p.n = ${i} RETURN p.n AS n, p.name AS name` }],
  ['set a property to a text, then a number of its own shape', 'social', { text: (i) => `MATCH (p:Person {name: 'Grace'}) SET p.note = 'note ${i}', p.rank = ${i}.5` }],
  ['set a property from a parameter', 'social', { text: () => "MATCH (p:Person {name: $name}) SET p.v = $v RETURN p.v AS v", params: (i) => ({ name: ['Ada', 'Alan'][i % 2], v: i * 3 }) }],
  ['add properties from a map: a NULL removes its key', 'social', { text: () => "MATCH (p:Person {name: 'Ada'}) SET p += $m RETURN p.a AS a, p.b AS b", params: (i) => ({ m: i % 2 ? { a: i, b: 'b' } : { a: null, b: i } }) }],
  ['replace the properties', 'social', { text: () => "MATCH (p:Person {name: 'Barbara'}) SET p = $m RETURN p.k AS k, p.name AS name", params: (i) => ({ m: { name: 'Barbara', k: i, [`k${i % 3}`]: true } }) }],
  ['remove a property', 'social', { text: (i) => [`MATCH (p:Person {name: 'Ada'}) SET p.tmp = ${i}`, "MATCH (p:Person {name: 'Ada'}) REMOVE p.tmp"] }],
  ["set a relationship's property", 'social', { text: (i) => `MATCH (:Person {name: 'Ada'})-[r:KNOWS]->() SET r.w = ${i} RETURN count(*) AS c` }],
  ['add a label, then remove it', 'social', { first: ["MATCH (p:Person {name: 'Ada'}) SET p:Marked", "MATCH (p:Person {name: 'Ada'}) REMOVE p:Marked"], text: () => ["MATCH (p:Person {name: 'Ada'}) SET p:Marked RETURN labels(p) AS l", "MATCH (p:Person {name: 'Ada'}) REMOVE p:Marked RETURN labels(p) AS l"] }],
  ['add two labels, then remove them', 'social', { first: ["MATCH (p:Person {name: 'Ada'}) SET p:One:Two", "MATCH (p:Person {name: 'Ada'}) REMOVE p:One:Two"], text: () => ["MATCH (p:Person {name: 'Ada'}) SET p:One:Two RETURN labels(p) AS l", "MATCH (p:Person {name: 'Ada'}) REMOVE p:One:Two RETURN labels(p) AS l"] }],
  ['merge a node that is there', 'social', { text: (i) => `MERGE (p:Person {name: '${['Ada', 'Alan', 'Grace'][i % 3]}'}) RETURN p.born AS born` }],
  ['merge: found, then ON MATCH', 'social', { text: (i) => `MERGE (p:Person {name: 'Ada'}) ON MATCH SET p.seen = ${i} ON CREATE SET p.made = ${i} RETURN p.seen AS seen` }],
  ['merge: made, then ON CREATE', 'social', { text: (i) => `MERGE (p:Person {name: 'New ${i}'}) ON MATCH SET p.seen = ${i} ON CREATE SET p.made = ${i} RETURN p.made AS made` }],
  ['merge a relationship', 'social', { first: ["MATCH (a:Person {name: 'Ada'}), (b:Person {name: 'Grace'}) MERGE (a)-[:MET {year: 0}]->(b)"], text: (i) => `MATCH (a:Person {name: 'Ada'}), (b:Person {name: 'Grace'}) MERGE (a)-[r:MET {year: ${1900 + (i % 2)}}]->(b) RETURN r.year AS year` }],
  ['delete a node and its relationships', 'social', { first: ["MATCH (a:Person {name: 'Ada'}) CREATE (a)-[:HAS]->(:Gone {i: -1})-[:HAS]->(a)"], text: (i) => [`MATCH (a:Person {name: 'Ada'}) CREATE (a)-[:HAS]->(:Gone {i: ${i}})-[:HAS]->(a)`, `MATCH (n:Gone {i: ${i}}) DETACH DELETE n`] }],
  ['delete a relationship', 'social', { first: ["MATCH (a:Person {name: 'Ada'}), (b:Person {name: 'Alan'}) CREATE (a)-[:TMP {i: -1}]->(b)"], text: (i) => [`MATCH (a:Person {name: 'Ada'}), (b:Person {name: 'Alan'}) CREATE (a)-[:TMP {i: ${i}}]->(b)`, `MATCH ()-[r:TMP {i: ${i}}]->() DELETE r`] }],
  ['delete a node without DETACH', 'empty', { first: ['CREATE (:Lone {i: -1})'], text: (i) => [`CREATE (:Lone {i: ${i}})`, `MATCH (n:Lone {i: ${i}}) DELETE n`] }],
  ['a write per row of an UNWIND of three', 'empty', { first: ['CREATE (:R {i: -1})'], text: (i) => `UNWIND range(${i}, ${i + 2}) AS x CREATE (:R {i: x})` }],
  ['a write per row of an UNWIND of one', 'empty', { first: ['CREATE (:R {i: -1})'], text: (i) => `UNWIND range(${i}, ${i}) AS x CREATE (:R {i: x, twice: x * 2})` }],
];

describe('a write with other values runs the statements kept for its shape', () => {
  test.each(SHAPES)('%s', (_name, graph, shape) => {
    const prepared = { n: 0 };
    const p = start(graph, counting(prepared));
    const params = (i: number) => shape.params?.(i) ?? {};
    const run = (i: number) => {
      const texts = shape.text(i);
      for (const cypher of typeof texts === 'string' ? [texts] : texts) p.run(cypher, params(i));
    };
    for (const cypher of shape.first ?? []) p.run(cypher);
    // The first of the shape makes its statements; one more settles those only a second run needs (a property that
    // is there now, a row that matches).
    run(0);
    run(1);
    const made = prepared.n;
    expect(made, 'the shape keeps statements').toBeGreaterThan(0);
    for (let i = 2; i < 9; i++) run(i);
    expect(prepared.n, 'no statement is made for a write whose shape is kept').toBe(made);
  });

  test('a value of another kind is another shape, with statements of its own', () => {
    const prepared = { n: 0 };
    const p = start('social', counting(prepared));
    const set = (v: string) => p.run(`MATCH (p:Person {name: 'Ada'}) SET p.v = ${v} RETURN p.v AS v`);
    set('1');
    set('2');
    const whole = prepared.n;
    set('3');
    expect(prepared.n).toBe(whole);
    // A text, then a float: each a shape of its own, kept in turn.
    set("'a'");
    const text = prepared.n;
    expect(text).toBeGreaterThan(whole);
    set("'b'");
    set('1.5');
    const float = prepared.n;
    expect(float).toBeGreaterThan(text);
    set('2.5');
    set('4');
    set("'c'");
    expect(prepared.n).toBe(float);
  });

  test('the shapes kept are counted with the reads kept, and the oldest go first', () => {
    const p = start('empty');
    p.run('CREATE (:N {i: 0})');
    const before = keptShapes(p.db).shapes;
    // 300 shapes: a write that differs in a property's name.
    for (let i = 0; i < 300; i++) p.run(`MATCH (n:N) SET n.k${i} = ${i}`);
    expect(keptShapes(p.db).shapes).toBe(256);
    expect(before).toBeLessThan(256);
    // A shape that went is made again and runs as before.
    p.run('MATCH (n:N) SET n.k0 = -1 RETURN n.k0 AS k');
    p.run('MATCH (n:N) SET n.k0 = -2 RETURN n.k0 AS k');
  });
});

describe('a label or a type added while a statement runs', () => {
  test('a later row sees the label an earlier row added', () => {
    const p = start('empty');
    // Row 1 finds no :Fresh node and makes one, with its label; rows 2 and 3 must find it.
    p.run('UNWIND [1, 2, 3] AS i MERGE (n:Fresh {k: 1}) ON CREATE SET n.made = i ON MATCH SET n.seen = i RETURN n.made AS made, n.seen AS seen');
    p.run('MATCH (n:Fresh) RETURN count(*) AS c');
    // The same statement on the graph with the label: another shape, which keeps its statements.
    p.run('UNWIND [1, 2, 3] AS i MERGE (n:Fresh {k: 2}) ON CREATE SET n.made = i ON MATCH SET n.seen = i RETURN n.made AS made, n.seen AS seen');
    p.run('UNWIND [4, 5, 6] AS i MERGE (n:Fresh {k: 3}) ON CREATE SET n.made = i ON MATCH SET n.seen = i RETURN n.made AS made, n.seen AS seen');
    p.run('MATCH (n:Fresh) RETURN n.k AS k, n.made AS made, n.seen AS seen ORDER BY k');
  });

  test('a later row sees the type an earlier row added', () => {
    const p = start('empty');
    p.run('CREATE (:A {i: 1}), (:A {i: 2})');
    p.run('UNWIND [1, 2, 3] AS i MATCH (a:A {i: 1}), (b:A {i: 2}) MERGE (a)-[r:NEW]->(b) ON CREATE SET r.made = i ON MATCH SET r.seen = i RETURN r.made AS made, r.seen AS seen');
    p.run('MATCH ()-[r:NEW]->() RETURN count(*) AS c, sum(r.seen) AS seen');
    p.run('UNWIND [1, 2] AS i MATCH (a:A {i: 2}), (b:A {i: 1}) MERGE (a)-[r:NEW]->(b) ON CREATE SET r.made = i ON MATCH SET r.seen = i RETURN r.made AS made, r.seen AS seen');
  });

  test('a shape kept before a label came runs on, and the graph with the label has shapes of its own', () => {
    const prepared = { n: 0 };
    const p = start('social', counting(prepared));
    const set = (i: number) => p.run(`MATCH (p:Person {name: 'Ada'}) SET p.n = ${i} RETURN p.n AS n`);
    set(1);
    set(2);
    p.run("MATCH (p:Person {name: 'Alan'}) SET p:Fellow");
    // The graph's tables are others now: the write is planned for them once, then kept again.
    set(3);
    const after = prepared.n;
    set(4);
    set(5);
    expect(prepared.n).toBe(after);
  });

  test('a statement that adds a label and then fails leaves the graph, and what is kept, as they were', () => {
    const p = start('social');
    const good = (i: number) => p.run(`MATCH (p:Person {name: 'Ada'}) CREATE (p)-[:OWNS]->(:Thing {i: ${i}}) RETURN count(*) AS c`);
    good(1);
    good(2);
    // Adds a label, writes, then fails: all of it is undone, the label too.
    const tables = p.tables;
    p.run("MATCH (p:Person {name: 'Ada'}) CREATE (p)-[:OWNS]->(:Never {i: 1}) WITH p MATCH (q:Person {name: 'Alan'}) DELETE q");
    expect(p.tables).toBe(tables);
    expect(p.tables.labelTables.has('Never')).toBe(false);
    good(3);
    // The statement that failed runs again, to the same end, and one that works adds the label.
    p.run("MATCH (p:Person {name: 'Ada'}) CREATE (p)-[:OWNS]->(:Never {i: 1}) WITH p MATCH (q:Person {name: 'Alan'}) DELETE q");
    p.run("MATCH (p:Person {name: 'Ada'}) CREATE (p)-[:OWNS]->(:Never {i: 2}) RETURN count(*) AS c");
    expect(p.tables.labelTables.has('Never')).toBe(true);
    good(4);
  });
});

describe('a write whose rows are of several tables', () => {
  test('one shape sets a property of relationships of three types, each in its own table', () => {
    const p = start('empty');
    p.run('CREATE (a:A {i: 1})-[:R1 {i: 1}]->(b:B {i: 2})-[:R2 {i: 2}]->(c:C {i: 3})-[:R3 {i: 3}]->(a)');
    // The same shape finds a relationship of another type each time: its SET writes that type's table.
    for (let round = 0; round < 3; round++) {
      for (const i of [1, 2, 3, 1, 3]) {
        p.run('MATCH ()-[r {i: $i}]->() SET r.w = $w, r.seen = r.i * $w RETURN type(r) AS t, r.w AS w, r.seen AS seen', { i, w: round * 10 + i });
        p.run('MATCH ()-[r {i: $i}]->() REMOVE r.seen RETURN type(r) AS t, r.seen AS seen', { i });
      }
    }
    p.run('MATCH ()-[r]->() RETURN type(r) AS t, r.w AS w ORDER BY t');
  });

  test('one shape deletes a relationship of another type each time', () => {
    const p = start('empty');
    p.run('CREATE (a:A {i: 1}), (b:A {i: 2})');
    for (let round = 0; round < 2; round++) {
      p.run('MATCH (a:A {i: 1}), (b:A {i: 2}) CREATE (a)-[:R1 {i: 1}]->(b), (a)-[:R2 {i: 2}]->(b), (b)-[:R3 {i: 3}]->(a)');
      for (const i of [2, 3, 1]) p.run('MATCH ()-[r {i: $i}]->() DELETE r RETURN count(*) AS c', { i });
      p.run('MATCH ()-[r]->() RETURN count(*) AS c');
    }
  });
});

describe('a write over many rows, below an operation that reads all its rows first', () => {
  // `setup` makes the rows; `write` is the statement counted. Its write is the lowest of the statement, with a query
  // below it and an aggregate above: it writes its rows at once, so twice the rows are as many statements.
  const MANY: readonly [string, { setup?: (n: number) => string; write: string | ((n: number) => string) }][] = [
    ['CREATE of nodes', { write: (n) => `UNWIND range(1, ${n}) AS i CREATE (b:Many {i: i}) RETURN count(*) AS c` }],
    ['CREATE of relationships', { setup: (n) => `UNWIND range(1, ${n}) AS i CREATE (:Many {i: i})`, write: 'MATCH (b:Many) CREATE (b)-[:TO {i: b.i}]->(:End {i: b.i}) RETURN count(*) AS c' }],
    ['SET of a property', { setup: (n) => `UNWIND range(1, ${n}) AS i CREATE (:Many {i: i})`, write: 'MATCH (b:Many) SET b.twice = b.i * 2 RETURN count(*) AS c, sum(b.twice) AS twice' }],
    ['REMOVE of a property', { setup: (n) => `UNWIND range(1, ${n}) AS i CREATE (:Many {i: i, gone: i})`, write: 'MATCH (b:Many) REMOVE b.gone RETURN count(*) AS c' }],
    ['SET of a label', { setup: (n) => `UNWIND range(1, ${n}) AS i CREATE (:Many {i: i})`, write: 'MATCH (b:Many) SET b:Marked RETURN count(*) AS c' }],
    ['MERGE of new nodes', { write: (n) => `UNWIND range(1, ${n}) AS i MERGE (b:Many {i: i}) RETURN count(*) AS c` }],
    ['DETACH DELETE of nodes', { setup: (n) => `UNWIND range(1, ${n}) AS i CREATE (:Many {i: i})-[:TO]->(:Many {i: -i})`, write: 'MATCH (b:Many) DETACH DELETE b RETURN count(*) AS c' }],
    ['DELETE of relationships', { setup: (n) => `UNWIND range(1, ${n}) AS i CREATE (:Many {i: i})-[:TO]->(:Many {i: -i})`, write: 'MATCH (:Many)-[r:TO]->() DELETE r RETURN count(*) AS c' }],
  ];
  test.each(MANY)('%s: as many statements for 40 rows as for 20', (_name, { setup, write }) => {
    const statements = (n: number): number => {
      const ran = { n: 0 };
      const p = start('empty', countingRuns(ran));
      if (setup) p.run(setup(n));
      ran.n = 0;
      p.run(typeof write === 'string' ? write : write(n));
      return ran.n;
    };
    const twenty = statements(20);
    expect(twenty).toBeGreaterThan(0);
    expect(statements(40)).toBe(twenty);
  });
});

describe('one SET item, over rows that set and rows that remove', () => {
  test('a value sets the property and a NULL removes it, row after row of one statement', () => {
    const p = start('social');
    // The rows share their node, so they are written one by one: the item keeps a statement that sets and one that removes.
    for (let round = 0; round < 3; round++) {
      // This shape's first write sets the property, its second removes it: the node is left without it.
      p.run("UNWIND [1, null] AS v MATCH (p:Person {name: 'Ada'}) SET p.tmp = v RETURN p.tmp AS tmp");
      p.run("MATCH (p:Person {name: 'Ada'}) SET p.tmp = 0");
      // This one's first write removes it, its second sets it: the node is left with it.
      p.run("UNWIND [null, 4] AS v MATCH (p:Person {name: 'Ada'}) SET p.tmp = v RETURN p.tmp AS tmp");
      p.run("UNWIND [5, null, 6, null, 7] AS v MATCH (p:Person {name: 'Ada'}) SET p.tmp = v");
    }
    p.run("MATCH (p:Person {name: 'Ada'}) RETURN p.tmp AS tmp");
  });
});

describe('errors, with statements kept', () => {
  test('a write that fails after writing is undone, and its shape runs again', () => {
    const p = start('social');
    const set = (name: string, by: number) => p.run(`MATCH (p:Person {name: '${name}'}) SET p.x = 10 WITH p RETURN 100 / ${by} AS q`);
    set('Ada', 5);
    set('Alan', 4);
    // The same shape, failing after its SET: smaltdb's graph is as it was (`Pair.run`).
    set('Grace', 0);
    set('Grace', 2);
    set('Ada', 0);
    set('Ada', 1);
  });

  test('a parameter that is missing is the same error each time', () => {
    const p = start('social');
    const cypher = "MATCH (p:Person {name: 'Ada'}) SET p.v = $v, p.w = $w RETURN p.v AS v";
    p.run(cypher, { v: 1, w: 2 });
    p.run(cypher, { v: 3, w: 4 });
    for (let i = 0; i < 2; i++) p.run(cypher, { v: 5 });
    p.run(cypher, { v: 6, w: 7 });
  });

  test('a parameter missing from a property map is refused, as it was, each time', () => {
    const p = start('empty');
    // A map of parameters is read without a query when all of them are given.
    const create = 'CREATE (n:V {a: $a, b: $b}) RETURN n.a AS a, n.b AS b';
    p.run(create, { a: 1, b: 2 });
    for (let i = 0; i < 2; i++) expect(() => runOnSmaltdb(p.db, compile(create).plan, p.tables, { params: { a: 3 } })).toThrow(Unsupported);
    p.run(create, { a: 4, b: 5 });
    p.run('MATCH (n:V) RETURN count(*) AS c');
  });

  test('a node that still has relationships is not deleted, each time', () => {
    const p = start('social');
    for (let i = 0; i < 3; i++) p.run("MATCH (p:Person {name: 'Ada'}) DELETE p");
    p.run('CREATE (:Lone {i: 1})');
    p.run('MATCH (n:Lone) DELETE n');
    for (let i = 0; i < 2; i++) p.run("MATCH (p:Person {name: 'Alan'}) DELETE p");
  });
});

describe('a DELETE of a few, and of many', () => {
  /** `n` nodes in a ring with a self-loop on the first, each also tied to a person: then all deleted at once. */
  const ring = (p: Pair, label: string, n: number) => {
    p.run(`UNWIND range(1, ${n}) AS i CREATE (:${label} {i: i})`);
    p.run(`MATCH (a:${label}), (b:${label}) WHERE b.i = a.i % ${n} + 1 CREATE (a)-[:NEXT {w: a.i}]->(b)`);
    p.run(`MATCH (a:${label} {i: 1}) CREATE (a)-[:SELF]->(a)`);
    p.run(`MATCH (a:${label}), (q:Person {name: 'Ada'}) CREATE (q)-[:OWNS]->(a), (a)-[:OWNED_BY]->(q)`);
  };
  // Up to eight nodes and relationships are deleted one by one, by the statements kept for one; more, all at once.
  test.each([1, 2, 3, 8, 9, 30])('%i nodes with their relationships', (n) => {
    const p = start('social');
    // Twice, so the second DELETE of this many runs what the first kept.
    for (const label of ['Ring', 'Ring']) {
      ring(p, label, n);
      p.run(`MATCH (a:${label}) DETACH DELETE a`);
      p.run('MATCH (a:Ring) RETURN count(*) AS c');
    }
    p.run("MATCH (q:Person {name: 'Ada'})-[r]->() RETURN type(r) AS t, count(*) AS c ORDER BY t");
  });

  test.each([1, 4, 8, 9, 25])('%i relationships, then their nodes', (n) => {
    const p = start('empty');
    for (let round = 0; round < 2; round++) {
      p.run(`UNWIND range(1, ${n}) AS i CREATE (:E {i: i})-[:R {i: i}]->(:E {i: -i})`);
      p.run('MATCH (:E)-[r:R]->(:E) DELETE r');
      p.run('MATCH (e:E) DELETE e');
      p.run('MATCH (e) RETURN count(*) AS c');
    }
  });

  test('a relationship and both its nodes in one DELETE, and a path', () => {
    const p = start('empty');
    for (let round = 0; round < 2; round++) {
      p.run('CREATE (:P {i: 1})-[:R]->(:P {i: 2})-[:R]->(:P {i: 3})');
      p.run('MATCH (a:P {i: 1})-[r:R]->(b) DETACH DELETE a, r, b');
      p.run('MATCH (n) RETURN count(*) AS c');
      p.run('CREATE (:P {i: 1})-[:R]->(:P {i: 2})');
      p.run('MATCH path = (:P {i: 1})-[:R]->(:P {i: 2}) DETACH DELETE path');
      p.run('MATCH (n:P) DETACH DELETE n');
    }
  });
});

describe('values of every kind, written by statements kept', () => {
  const VALUES: readonly [string, unknown][] = [
    ['a text', 'a'],
    ['an empty text', ''],
    ['a whole number', 7],
    ['a float', 1.5],
    ['a float that is whole', 2.0],
    ['a number past the largest whole number held exactly', 1e300],
    ['true', true],
    ['false', false],
    ['NULL', null],
    ['NaN', NaN],
    ['infinity', Infinity],
    ['minus infinity', -Infinity],
  ];
  test('a property map of written values and parameters, read without a query', () => {
    const p = start('empty');
    p.run("CREATE (:V {name: 'first', n: 0})");
    for (const [name, v] of VALUES) {
      // In a CREATE's map, in a MERGE's (made, then found), and in a SET's.
      p.run('CREATE (n:V {name: $name, v: $v, w: 1}) RETURN n.v AS v', { name, v });
      if (v !== null) {
        for (let i = 0; i < 2; i++) p.run('MERGE (n:M {v: $v}) RETURN n.v AS v', { v });
      }
      p.run("MATCH (n:V {name: 'first'}) SET n += {v: $v, k: 1} RETURN n.v AS v", { v });
    }
    p.run('MATCH (n:V) RETURN n.name AS name, n.v AS v ORDER BY name');
  });

  test('a list or a map given as a parameter in a property map is refused, as it was, each time', () => {
    const p = start('empty');
    p.run('CREATE (:V {v: $v})', { v: 1 });
    for (const v of [[1, 'a'], [], { a: 1 }]) {
      for (let i = 0; i < 2; i++) expect(() => runOnSmaltdb(p.db, compile('CREATE (:V {v: $v, w: 1})').plan, p.tables, { params: { v } }), JSON.stringify(v)).toThrow(Unsupported);
    }
    // Alone, a parameter is the value it holds: a list is a property.
    p.run('MATCH (n:V) SET n.v = $v RETURN n.v AS v', { v: [1, 'a'] });
    p.run('CREATE (:V {v: $v})', { v: 2 });
  });

  test('a map with a value written in the text beside a parameter, and one computed', () => {
    const p = start('empty');
    for (let i = 0; i < 4; i++) {
      p.run(`CREATE (n:W {a: 'x${i}', b: $b, c: null, d: true}) RETURN n.a AS a, n.b AS b, n.c AS c, n.d AS d`, { b: i });
      // An entry that is computed makes the whole map a query.
      p.run(`CREATE (n:W {a: 'y${i}', b: $b + 1}) RETURN n.b AS b`, { b: i });
    }
    p.run('MATCH (n:W) RETURN n.a AS a, n.b AS b ORDER BY a');
  });
});

describe('the next ids, with statements kept', () => {
  test('ids kept by the caller move on as on smaltcy, statement after statement', () => {
    const g = open();
    const p = start('empty');
    const ids = { node: 0, relationship: 0 };
    let tables = p.tables;
    for (let i = 0; i < 6; i++) {
      const cypher = `CREATE (a:A {i: ${i}})-[r:R]->(b:B {i: ${i}}) RETURN id(a) AS a, id(r) AS r, id(b) AS b`;
      const mine = g.run(cypher);
      const theirs = runOnSmaltdb(p.db, compile(cypher).plan, tables, { ids });
      tables = theirs.tables;
      expect(theirs.rows, cypher).toEqual(mine.rows);
    }
    expect(ids).toEqual({ node: 12, relationship: 6 });
    expect(stateIn(p.db, tables)).toEqual(stateOf(g));
  });
});
