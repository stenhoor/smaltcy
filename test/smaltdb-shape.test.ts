import { describe, expect, test } from 'vitest';
import type { Database } from 'smaltdb-src/engine/database.js';
import { open, type Graph } from '../src/index.js';
import { Unsupported } from '../src/smaltdb/compile.js';
import { runOnSmaltdb } from '../src/smaltdb/write.js';
import { social } from './helpers/graphs.js';
import { READ_CASES, READ_PARAMS } from './helpers/read-cases.js';
import { binds, both } from './helpers/smaltdb.js';

/**
 * Statements kept by their shape (src/smaltdb/shape.ts; ADR 0004, "Statements kept by shape" and "A language of
 * smaltdb"): a statement that differs from one run before only in its strings and numbers runs what smaltdb kept for
 * that one, and the language binds nothing for it (`binds`). Each must give the rows smaltcy's engine gives, whatever
 * it runs.
 */

/** A query's rows on smaltdb as objects keyed by column, as `Graph.query` gives them. */
function onSmaltdb(db: Database, cypher: string, params: Record<string, unknown> = {}) {
  const r = runOnSmaltdb(db, cypher, { params });
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
}

/** What smaltdb had bound while `run` ran. */
function bound(run: () => void): number {
  const before = binds();
  run();
  return binds() - before;
}

describe('the read cases, each run twice: bound, then by what smaltdb kept', () => {
  const { db } = both(social());
  test.each(READ_CASES)('%s', (name, cypher, expected) => {
    if (name === 'labels and keys') {
      // Refused (test/smaltdb-differential.test.ts), the second time as the first.
      for (let i = 0; i < 2; i++) expect(() => onSmaltdb(db, cypher, READ_PARAMS)).toThrow(Unsupported);
      return;
    }
    expect(onSmaltdb(db, cypher, READ_PARAMS)).toEqual(expected);
    // The text is one smaltdb has: nothing is bound for it.
    expect(bound(() => expect(onSmaltdb(db, cypher, READ_PARAMS)).toEqual(expected))).toBe(0);
  });
});

describe('a query with other values runs the statement kept for its shape', () => {
  const g = social();
  const b = both(g);
  const db = b.db;
  const same = (cypher: string, params: Record<string, unknown> = {}) => expect(onSmaltdb(db, cypher, params), cypher).toEqual(g.query(cypher, params));

  test('strings: one statement for every name', () => {
    const n = bound(() => {
      for (const name of ['Ada', 'Alan', 'Grace', 'Nobody', '', "O'Hara", 'Ada']) same(`MATCH (p:Person {name: ${JSON.stringify(name)}}) RETURN p.born AS born`);
    });
    expect(n).toBe(1);
  });

  test('numbers: one statement for whole numbers, one for floats', () => {
    const q = (year: number) => `MATCH (p:Person) WHERE p.born < ${year} RETURN p.name AS name ORDER BY name`;
    expect(bound(() => [1815, 1912, 0, -3, 2000].forEach((year) => same(q(year))))).toBe(1);
    expect(bound(() => [1815.5, 1912.25, -0.5].forEach((year) => same(q(year))))).toBe(1);
  });

  test('a value of another kind is another statement', () => {
    const n = bound(() => {
      for (const v of ["'Ada'", '1912', '1912.5', 'true', 'null', "'Alan'", '1815', '0.25', 'false']) same(`MATCH (p:Person) WHERE p.name = ${v} OR p.born = ${v} RETURN p.name AS name ORDER BY name`);
    });
    // Text, whole numbers and floats, a shape each; true, NULL and false stay written, each text a statement.
    expect(n).toBe(6);
  });

  test('several values, and the same value twice', () => {
    const n = bound(() => {
      for (const [x, y, z] of [['Ada', 1900, 'a'], ['Grace', 1815, 'b'], ['Ada', 1, 'Ada']] as const) {
        same(`MATCH (p:Person {name: '${x}'}) WHERE p.born > ${y} OR p.name < '${z}' RETURN p.name AS name, '${z}' AS z, ${y} + 1 AS y ORDER BY name`);
      }
    });
    expect(n).toBe(1);
  });

  test('a list or a map the query builds stays written: another list is another statement', () => {
    const lists = bound(() => {
      for (const [x, y, z] of [['Ada', 1900, 'a'], ['Grace', 1815, 'b'], ['Ada', 1, 'Ada']] as const) {
        same(`MATCH (p:Person) WHERE p.name IN ['${x}', '${z}'] RETURN p.name AS name, {k: '${x}', n: ${y}} AS m, ['${z}', ${y}, []] AS l ORDER BY name`);
      }
    });
    expect(lists).toBe(3);
    // The lists the same and a value beside them another: one statement.
    const beside = bound(() => {
      for (const year of [1900, 1815, 1]) same(`MATCH (p:Person) WHERE p.name IN ['Ada', 'Alan'] AND p.born > ${year} RETURN p.name AS name, [1, []] AS l ORDER BY name`);
    });
    expect(beside).toBe(1);
    // Lists of lists with an empty one among them, whose elements smaltdb types by what is written.
    same('UNWIND [[1, 2], [1], [], [2, 0], [1, null]] AS x RETURN min(x) AS lo, max(x) AS hi');
  });

  test('parameters: bound once for values of one kind, again for another kind', () => {
    const cypher = 'MATCH (p:Person) WHERE p.name = $x OR p.born = $x RETURN p.name AS name ORDER BY name';
    expect(bound(() => ['Ada', 'Alan', 'Nobody'].forEach((x) => same(cypher, { x })))).toBe(1);
    expect(bound(() => [1912, 1815].forEach((x) => same(cypher, { x })))).toBe(1);
    // NULL, a boolean, a float and NaN are four more; a text is the first again.
    expect(bound(() => [null, true, 1912.5, NaN, 'Grace'].forEach((x) => same(cypher, { x })))).toBe(4);
  });

  test('a parameter and values written in the query together', () => {
    const n = bound(() => {
      for (const [year, name] of [[1900, 'Ada'], [1930, 'Grace'], [1800, 'Edsger']] as const) {
        same(`MATCH (p:Person) WHERE p.born < $year AND p.name <> '${name}' RETURN p.name AS name ORDER BY name`, { year });
      }
    });
    expect(n).toBe(1);
    // The same shape with a year of another kind: bound again, for every name once.
    const floats = bound(() => {
      for (const [year, name] of [[1900.5, 'Ada'], [1930.5, 'Grace']] as const) {
        same(`MATCH (p:Person) WHERE p.born < $year AND p.name <> '${name}' RETURN p.name AS name ORDER BY name`, { year });
      }
    });
    expect(floats).toBe(1);
  });

  test('SKIP and LIMIT are part of what a statement compiles to: each count its own, checked as it is compiled', () => {
    const page = (skip: number | string, limit: number | string) => `MATCH (p:Person) WHERE p.born > 1800 RETURN p.name AS name ORDER BY name SKIP ${skip} LIMIT ${limit}`;
    expect(bound(() => [page(0, 2), page(2, 2), page(0, 2)].forEach((q) => same(q)))).toBe(2);
    // Counts written out and a year that differs: the shape of each page is kept.
    const year = (y: number) => page(0, 2).replace('1800', String(y));
    expect(bound(() => [1810, 1900].forEach((y) => same(year(y))))).toBe(0);
    // Counts given as parameters: bound for each pair of them.
    expect(bound(() => [1, 3, 1].forEach((n) => same(page('$s', '$n'), { s: 1, n })))).toBe(2);
    // A count that isn't one fails as it does on smaltcy's engine, after one that is ran.
    for (const bad of [-1, 1.5, 'x']) {
      let mine: unknown;
      try {
        g.query(page('$s', '$n'), { s: 0, n: bad });
      } catch (e) {
        mine = e;
      }
      expect(mine, String(bad)).toBeDefined();
      for (let i = 0; i < 2; i++) expect(() => onSmaltdb(db, page('$s', '$n'), { s: 0, n: bad }), String(bad)).toThrow((mine as Error).message);
    }
    same(page('$s', '$n'), { s: 1, n: 3 });
  });

  test('a parameter that is missing fails, after a query that had it ran, and each time', () => {
    const cypher = "MATCH (p:Person) WHERE p.born < $year AND p.name <> 'Ada' RETURN p.name AS name ORDER BY name";
    same(cypher, { year: 1900 });
    for (const params of [{}, { year: undefined }, { other: 1 }, {}]) expect(() => onSmaltdb(db, cypher, params), JSON.stringify(params)).toThrow(/year/);
    same(cypher, { year: 1930 });
  });

  test('what the compiler needs written out is bound as written: degree()', () => {
    // No shape: each text is a statement of its own, bound once.
    const texts = ['Alan', 'Ada', 'Grace'].map((name) => `MATCH (p:Person {name: '${name}'}) RETURN degree(p) AS all, degree(p, 'out', 'KNOWS') AS knowsOut`);
    texts.push(...['in', 'both'].map((dir) => `MATCH (p:Person {name: 'Alan'}) RETURN degree(p, '${dir}', 'KNOWS') AS n`));
    expect(bound(() => texts.forEach((q) => same(q)))).toBe(5);
    expect(bound(() => texts.forEach((q) => same(q)))).toBe(0);
  });

  test('more values than a statement takes parameters for: bound as written', () => {
    const where = (count: number, from: number) => Array.from({ length: count }, (_, i) => `p.born = ${from + 2 * i}`).join(' OR ');
    const q = (count: number, from: number) => `MATCH (p:Person) WHERE ${where(count, from)} RETURN p.name AS name ORDER BY name`;
    // 70 values: each text is bound. 60: one shape.
    expect(bound(() => [1800, 1801, 1802].forEach((from) => same(q(70, from))))).toBe(3);
    expect(bound(() => [1800, 1801, 1802].forEach((from) => same(q(60, from))))).toBe(1);
  });

  test('shapes with one hash are kept apart: names of one length with the same ends', () => {
    // The hash takes a name's length and its first and last letter (shape.ts): these three queries have one hash.
    const keys = ['born', 'burn', 'bean'];
    const n = bound(() => {
      for (const year of [1900, 1815, 1950]) {
        for (const key of keys) same(`MATCH (p:Person) WHERE p.${key} < ${year} RETURN p.name AS who ORDER BY who`);
      }
    });
    expect(n).toBe(3);
  });

  test('0 and -0 written in a list are two shapes: what stays written is compared as it is', () => {
    // A tag beside the list gives the statement a shape: the list is part of it.
    const q = (zero: string, tag: string) => `RETURN [1.5, ${zero}] AS l, '${tag}' AS tag`;
    const n = bound(() => {
      for (const tag of ['a', 'b', 'c']) for (const zero of ['-0.0', '0.0']) onSmaltdb(db, q(zero, tag));
    });
    expect(n).toBe(2);
  });

  test('past 256 shapes the oldest goes, and is bound again when it comes back', () => {
    const b = both(social());
    // Each column name is a shape of its own. Some have one hash (a name's length and ends): c10, c20 and c30.
    const run = (i: number, name = 'Ada', born = 1815) => expect(onSmaltdb(b.db, `MATCH (p:Person {name: '${name}'}) RETURN p.born AS c${i}`)).toEqual([{ [`c${i}`]: born }]);
    expect(bound(() => {
      for (let i = 0; i <= 256; i++) run(i);
    })).toBe(257);
    // The newest and the oldest left are kept: another name runs what was bound for them.
    expect(bound(() => [256, 1].forEach((i) => run(i, 'Alan', 1912)))).toBe(0);
    // The first went: it is bound again, and the oldest left goes for it.
    expect(bound(() => run(0, 'Alan', 1912))).toBe(1);
    expect(bound(() => run(1, 'Grace', 1906))).toBe(1);
    // Ten more, and c3 to c12 go: c10 from among others of its hash, which stay.
    expect(bound(() => {
      for (let i = 300; i < 310; i++) run(i);
    })).toBe(10);
    expect(bound(() => [20, 30, 13, 256, 0, 1, 309].forEach((i) => run(i, 'Grace', 1906)))).toBe(0);
    expect(bound(() => run(10, 'Grace', 1906))).toBe(1);
  });
});

describe("a write's values are parameters of the statement it runs", () => {
  /** A graph on both engines. */
  function pair() {
    const g = social();
    const b = both(g);
    /** Runs a statement on both engines: the same rows and counts. */
    const run = (cypher: string, params: Record<string, unknown> = {}) => {
      const mine = g.run(cypher, params);
      const theirs = runOnSmaltdb(b.db, cypher, { params });
      expect(theirs.rows, cypher).toEqual(mine.rows);
      expect(theirs.counts, cypher).toEqual(mine.counts);
    };
    const graph = () => expect(onSmaltdb(b.db, 'MATCH (n) RETURN labels(n) AS l, properties(n) AS p ORDER BY id(n)')).toEqual(g.query('MATCH (n) RETURN labels(n) AS l, properties(n) AS p ORDER BY id(n)'));
    return { run, graph };
  }

  test('a MERGE of a node that is there: the same statement for every name', () => {
    const p = pair();
    expect(bound(() => p.run("MERGE (n:Person {name: 'Ada'})"))).toBe(1);
    expect(bound(() => ['Alan', 'Grace', 'Edsger'].forEach((name) => p.run(`MERGE (n:Person {name: '${name}'})`)))).toBe(0);
    // With a RETURN it is another statement, one for every name again: the same rows as smaltcy's.
    expect(bound(() => ['Ada', 'Barbara', 'Nobody'].forEach((name) => p.run(`MERGE (n:Person {name: '${name}'}) RETURN n.born AS born`)))).toBe(1);
    p.graph();
  });

  test('a SET of a node found by a value: the same statement for every value', () => {
    const p = pair();
    expect(bound(() => p.run("MATCH (n:Person) WHERE n.name = 'Ada' AND n.born < 1900 SET n.seen = 1 RETURN count(*) AS c"))).toBe(1);
    expect(bound(() => p.run("MATCH (n:Person) WHERE n.name = 'Grace' AND n.born < 1950 SET n.seen = 2 RETURN count(*) AS c"))).toBe(0);
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

describe('a statement kept is for the graph as it is: labels, types and indexes that come later', () => {
  /** A graph on both engines, written and read in step. */
  class Pair {
    readonly g: Graph = open();
    readonly db: Database = both(this.g).db;

    write(cypher: string): void {
      this.g.run(cypher);
      runOnSmaltdb(this.db, cypher);
    }

    same(cypher: string): void {
      expect(onSmaltdb(this.db, cypher), cypher).toEqual(this.g.query(cypher));
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
    p.write('MATCH (n:N) WHERE n.i > 15 DETACH DELETE n');
    // A write of rows changes no table's definition: nothing is bound again for the read.
    expect(bound(() => p.same(q(5)))).toBe(0);
    p.write('MATCH (n:N) WHERE n.i < 3 SET n.i = 100');
    expect(bound(() => p.same(q(10)))).toBe(0);
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
