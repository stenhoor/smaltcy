import { describe, expect, test } from 'vitest';
import type { Database } from 'smaltdb-src/engine/database.js';
import { compile } from '../src/cypher/index.js';
import { open, type Graph } from '../src/index.js';
import { Unsupported } from '../src/smaltdb/compile.js';
import type { GraphTables } from '../src/smaltdb/schema.js';
import { runOnSmaltdb, type SmaltdbDatabase } from '../src/smaltdb/write.js';
import { social } from './helpers/graphs.js';
import { READ_CASES, READ_PARAMS } from './helpers/read-cases.js';
import { both } from './helpers/smaltdb.js';

/**
 * Queries kept by their shape (src/smaltdb/shape.ts; ADR 0004, "Statements kept by shape"): a query that differs from
 * one run before only in its strings and numbers runs the statement prepared for that one. Each must give the rows
 * smaltcy's engine gives, whichever statement it runs.
 */

/** A smaltdb database that counts the statements it is asked to prepare. */
function counting(db: Database): { db: SmaltdbDatabase; prepared: () => number } {
  let n = 0;
  return {
    db: {
      queryPlan: (stmt, params) => db.queryPlan(stmt, params as never),
      preparePlan: (stmt) => {
        n++;
        return db.preparePlan(stmt);
      },
      get inTransaction() {
        return db.inTransaction;
      },
    },
    prepared: () => n,
  };
}

/** A query's rows on smaltdb as objects keyed by column, as `Graph.query` gives them. */
function onSmaltdb(db: SmaltdbDatabase, tables: GraphTables, cypher: string, params: Record<string, unknown> = {}) {
  const r = runOnSmaltdb(db, compile(cypher).plan, tables, { params });
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
}

describe('the read cases, each run twice: by a shape made for it, then by the shape kept', () => {
  const { db, tables } = both(social());
  test.each(READ_CASES)('%s', (name, cypher, expected) => {
    if (name === 'labels and keys') {
      // Refused (test/smaltdb-differential.test.ts), the second time as the first.
      for (let i = 0; i < 2; i++) expect(() => onSmaltdb(db, tables, cypher, READ_PARAMS)).toThrow(Unsupported);
      return;
    }
    expect(onSmaltdb(db, tables, cypher, READ_PARAMS)).toEqual(expected);
    expect(onSmaltdb(db, tables, cypher, READ_PARAMS)).toEqual(expected);
  });
});

describe('a query with other values runs the statement kept for its shape', () => {
  const g = social();
  const b = both(g);
  const same = (db: SmaltdbDatabase, cypher: string, params: Record<string, unknown> = {}) => expect(onSmaltdb(db, b.tables, cypher, params), cypher).toEqual(g.query(cypher, params));

  test('strings: one statement for every name', () => {
    const { db, prepared } = counting(b.db);
    for (const name of ['Ada', 'Alan', 'Grace', 'Nobody', '', "O'Hara", 'Ada']) same(db, `MATCH (p:Person {name: ${JSON.stringify(name)}}) RETURN p.born AS born`);
    expect(prepared()).toBe(1);
  });

  test('numbers: one statement for whole numbers, one for floats', () => {
    const { db, prepared } = counting(b.db);
    for (const year of [1815, 1912, 0, -3, 2000]) same(db, `MATCH (p:Person) WHERE p.born < ${year} RETURN p.name AS name ORDER BY name`);
    expect(prepared()).toBe(1);
    for (const year of [1815.5, 1912.25, -0.5]) same(db, `MATCH (p:Person) WHERE p.born < ${year} RETURN p.name AS name ORDER BY name`);
    expect(prepared()).toBe(2);
  });

  test('a value of another kind is another shape', () => {
    const { db, prepared } = counting(b.db);
    for (const v of ["'Ada'", '1912', '1912.5', 'true', 'null', "'Alan'", '1815', '0.25', 'false']) same(db, `MATCH (p:Person) WHERE p.name = ${v} OR p.born = ${v} RETURN p.name AS name ORDER BY name`);
    // Text, whole numbers, floats, true, NULL and false.
    expect(prepared()).toBe(6);
  });

  test('several values, in lists and maps, and the same value twice', () => {
    const { db, prepared } = counting(b.db);
    for (const [x, y, z] of [['Ada', 1900, 'a'], ['Grace', 1815, 'b'], ['Ada', 1, 'Ada']] as const) {
      same(db, `MATCH (p:Person) WHERE p.name IN ['${x}', '${z}'] OR p.born > ${y} RETURN p.name AS name, {k: '${x}', n: ${y}} AS m, ['${z}', ${y}] AS l ORDER BY name`);
    }
    expect(prepared()).toBe(1);
  });

  test('parameters: one statement for values of one kind, another for another kind', () => {
    const { db, prepared } = counting(b.db);
    const cypher = 'MATCH (p:Person) WHERE p.name = $x OR p.born = $x RETURN p.name AS name ORDER BY name';
    for (const x of ['Ada', 'Alan', 'Nobody']) same(db, cypher, { x });
    expect(prepared()).toBe(1);
    for (const x of [1912, 1815]) same(db, cypher, { x });
    expect(prepared()).toBe(2);
    for (const x of [null, true, 1912.5, NaN, 'Grace']) same(db, cypher, { x });
    expect(prepared()).toBe(6);
  });

  test('a parameter and values written in the query together', () => {
    const { db, prepared } = counting(b.db);
    for (const [year, name] of [[1900, 'Ada'], [1930, 'Grace'], [1800, 'Edsger']] as const) {
      same(db, `MATCH (p:Person) WHERE p.born < $year AND p.name <> '${name}' RETURN p.name AS name ORDER BY name`, { year });
    }
    expect(prepared()).toBe(1);
  });

  test('SKIP and LIMIT are part of the shape: each count its own statement, checked as it is compiled', () => {
    const { db, prepared } = counting(b.db);
    const page = (skip: number | string, limit: number | string) => `MATCH (p:Person) WHERE p.born > 1800 RETURN p.name AS name ORDER BY name SKIP ${skip} LIMIT ${limit}`;
    same(db, page(0, 2));
    same(db, page(2, 2));
    same(db, page(0, 2));
    expect(prepared()).toBe(2);
    for (const n of [1, 3]) same(db, page('$s', '$n'), { s: 1, n });
    expect(prepared()).toBe(4);
    // A count that isn't one fails as it does on smaltcy's engine, after one that is ran.
    for (const bad of [-1, 1.5, 'x']) {
      let mine: unknown;
      try {
        g.query(page('$s', '$n'), { s: 0, n: bad });
      } catch (e) {
        mine = e;
      }
      expect(mine, String(bad)).toBeDefined();
      expect(() => onSmaltdb(db, b.tables, page('$s', '$n'), { s: 0, n: bad }), String(bad)).toThrow((mine as Error).message);
    }
  });

  test('a parameter that is missing fails, after a query that had it ran', () => {
    const { db } = counting(b.db);
    const cypher = "MATCH (p:Person) WHERE p.born < $year AND p.name <> 'Ada' RETURN p.name AS name ORDER BY name";
    same(db, cypher, { year: 1900 });
    expect(() => onSmaltdb(db, b.tables, cypher)).toThrow(/year/);
    same(db, cypher, { year: 1930 });
  });

  test('what the compiler needs written out is compiled as written: degree()', () => {
    const { db, prepared } = counting(b.db);
    for (const name of ['Alan', 'Ada', 'Grace']) same(db, `MATCH (p:Person {name: '${name}'}) RETURN degree(p) AS all, degree(p, 'out', 'KNOWS') AS knowsOut`);
    for (const dir of ['in', 'both']) same(db, `MATCH (p:Person {name: 'Alan'}) RETURN degree(p, '${dir}', 'KNOWS') AS n`);
    // Never by a shape: the statements are smaltdb's, by their text.
    expect(prepared()).toBe(0);
  });

  test('more values than a statement takes parameters for: compiled as written', () => {
    const { db, prepared } = counting(b.db);
    const many = Array.from({ length: 100 }, (_, i) => 1800 + i);
    same(db, `MATCH (p:Person) WHERE p.born IN [${many.join(', ')}] RETURN p.name AS name ORDER BY name`);
    expect(prepared()).toBe(0);
  });

  test('a database that can only run statements: the same rows', () => {
    const plain: SmaltdbDatabase = { queryPlan: (stmt, params) => b.db.queryPlan(stmt, params as never) };
    for (const name of ['Ada', 'Alan', 'Nobody']) same(plain, `MATCH (p:Person {name: '${name}'})-[:KNOWS]->(q) RETURN q.name AS name ORDER BY name`);
  });
});

describe("a write's values are parameters of the statements it runs", () => {
  /** A graph on both engines, with the texts of the queries smaltdb is given. */
  function pair() {
    const g = social();
    const b = both(g);
    const texts = new Set<string>();
    let tables = b.tables;
    const db: SmaltdbDatabase = {
      queryPlan: (stmt, params) => {
        if ((stmt as { kind: string }).kind === 'query') texts.add(JSON.stringify(stmt));
        return b.db.queryPlan(stmt, params as never);
      },
      get inTransaction() {
        return b.db.inTransaction;
      },
    };
    /** Runs a statement on both engines: the same rows and counts. */
    const run = (cypher: string, params: Record<string, unknown> = {}) => {
      const mine = g.run(cypher, params);
      const theirs = runOnSmaltdb(db, compile(cypher).plan, tables, { params });
      tables = theirs.tables;
      expect(theirs.rows, cypher).toEqual(mine.rows);
      expect(theirs.counts, cypher).toEqual(mine.counts);
    };
    const graph = () => expect(onSmaltdb(b.db, tables, 'MATCH (n) RETURN labels(n) AS l, properties(n) AS p ORDER BY id(n)')).toEqual(g.query('MATCH (n) RETURN labels(n) AS l, properties(n) AS p ORDER BY id(n)'));
    return { run, graph, queries: () => texts.size };
  }

  test('a MERGE of a node that is there: the same queries for every name', () => {
    const p = pair();
    p.run("MERGE (n:Person {name: 'Ada'})");
    const first = p.queries();
    for (const name of ['Alan', 'Grace', 'Edsger']) p.run(`MERGE (n:Person {name: '${name}'})`);
    expect(p.queries()).toBe(first);
    // With a RETURN, the rows the runner found go back into a query of their own: the same rows as smaltcy's.
    for (const name of ['Ada', 'Barbara', 'Nobody']) p.run(`MERGE (n:Person {name: '${name}'}) RETURN n.born AS born`);
    p.graph();
  });

  test('a SET of a node found by a value: its match is the same query for every value', () => {
    const p = pair();
    p.run("MATCH (n:Person) WHERE n.name = 'Ada' AND n.born < 1900 SET n.seen = 1 RETURN count(*) AS c");
    const first = p.queries();
    p.run("MATCH (n:Person) WHERE n.name = 'Grace' AND n.born < 1950 SET n.seen = 2 RETURN count(*) AS c");
    // The match is one query for both; what the runner makes of the rows it found holds their ids and values still.
    expect(p.queries()).toBeLessThan(2 * first);
    p.graph();
  });

  test('values of every kind, written and read back', () => {
    const p = pair();
    for (const v of ["'x'", "''", '1', '0', '1.5', '-2.5e10', '9007199254740993', 'true', 'null', "['a', 2, 2.5, false]", '[]']) {
      p.run(`MATCH (n:Person {name: 'Ada'}) SET n.v = ${v} RETURN n.v AS v`);
      p.run(`CREATE (m:Mark {v: ${v}, n: 7})-[:AT {v: ${v}}]->(:Mark) RETURN m.v AS v`);
    }
    // In a list, beside a value that stays written.
    for (const v of ["'x'", '1', '1.5', 'true']) p.run(`MATCH (n:Person {name: 'Alan'}) SET n.w = [${v}, ${v}], n.u = ${v} RETURN n.w AS w, n.u AS u`);
    p.graph();
  });

  test('what the compiler needs written out stays written: degree() in a write', () => {
    const p = pair();
    for (const name of ['Alan', 'Ada']) p.run(`MATCH (n:Person {name: '${name}'}) SET n.out = degree(n, 'out', 'KNOWS'), n.all = degree(n) RETURN n.out AS o, n.all AS a`);
    p.graph();
  });

  test('SKIP and LIMIT stay written, and a count that is not one fails on both engines', () => {
    const p = pair();
    p.run("MATCH (n:Person) WITH n ORDER BY n.name SKIP 1 LIMIT 2 SET n.page = 'a' RETURN count(*) AS c");
    p.run("MATCH (n:Person) WITH n ORDER BY n.name SKIP 2 LIMIT 1 SET n.page = 'b' RETURN count(*) AS c");
    p.graph();
  });
});

describe('a shape is for the graph as it is: labels, types and indexes that come later', () => {
  /** Runs a statement on both engines and keeps the tables smaltdb's runner gives back. */
  class Pair {
    readonly g: Graph = open();
    readonly db: SmaltdbDatabase;
    readonly prepared: () => number;
    tables: GraphTables;

    constructor() {
      const b = both(this.g);
      const c = counting(b.db);
      this.db = c.db;
      this.prepared = c.prepared;
      this.tables = b.tables;
    }

    write(cypher: string): void {
      this.g.run(cypher);
      this.tables = runOnSmaltdb(this.db, compile(cypher).plan, this.tables).tables;
    }

    same(cypher: string): void {
      expect(onSmaltdb(this.db, this.tables, cypher), cypher).toEqual(this.g.query(cypher));
    }
  }

  test('a label and a type the graph gets after the query first ran', () => {
    const p = new Pair();
    const people = "MATCH (p:Person {name: 'Ada'})-[:KNOWS]->(q) RETURN q.name AS name ORDER BY name";
    p.same(people);
    p.write("CREATE (:Person {name: 'Ada'})-[:KNOWS]->(:Person {name: 'Alan'})");
    p.same(people);
    p.same(people.replace('Ada', 'Alan'));
    p.write("MATCH (a:Person {name: 'Alan'}) CREATE (a)-[:KNOWS]->(:Person:Admiral {name: 'Grace'})");
    p.same(people.replace('Ada', 'Alan'));
    p.same("MATCH (p:Admiral) WHERE p.name = 'Grace' RETURN count(p) AS n");
  });

  test('writes between two runs of a shape: the statement kept reads the graph as it is', () => {
    const p = new Pair();
    p.write('UNWIND range(1, 20) AS i CREATE (:N {i: i, half: i % 2})');
    const q = (i: number) => `MATCH (n:N) WHERE n.i > ${i} RETURN count(n) AS c, sum(n.half) AS odd`;
    p.same(q(5));
    const before = p.prepared();
    p.write('MATCH (n:N) WHERE n.i > 15 DETACH DELETE n');
    p.same(q(5));
    p.write('MATCH (n:N) WHERE n.i < 3 SET n.i = 100');
    p.same(q(10));
    expect(p.prepared()).toBe(before);
  });

  test('an index made after the query first ran, and dropped again', () => {
    const p = new Pair();
    p.write("UNWIND range(1, 300) AS i CREATE (:N {i: i, name: ['a', 'b', 'c', 'd', 'e', 'f', 'g'][i % 7]})");
    const q = (name: string) => `MATCH (n:N {name: '${name}'}) RETURN count(n) AS c, min(n.i) AS lo`;
    p.same(q('d'));
    p.write('CREATE INDEX FOR (n:N) ON (n.name)');
    p.same(q('d'));
    p.same(q('f'));
    p.write('DROP INDEX ON :N(name)');
    p.same(q('g'));
    p.same(q('nobody'));
  });
});
