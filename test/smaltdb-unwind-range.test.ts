import { describe, expect, test } from 'vitest';
import { compile } from '../src/cypher/index.js';
import { compileQuery, Unsupported } from '../src/smaltdb/compile.js';
import { compileWrite } from '../src/smaltdb/write-plan.js';
import { start } from './helpers/write-pair.js';

/**
 * `UNWIND range(a, b[, step])` on smaltdb (compile.ts, `unwindRange`): the numbers are read as rows of smaltdb's
 * `range`, with no list made of them to take apart again, from the one row a statement starts with and beside rows
 * whose columns the arguments read. Each statement runs on smaltcy's engine and on the same graph in smaltdb
 * (`Pair.run`): the same rows in the same order, the same counts and the same graph, or the same error.
 */

type Params = Readonly<Record<string, unknown>>;

/** The operations of a compiled statement's plan, nested plans included, and the aggregates it calls. */
function parts(statement: unknown): { ops: string[]; aggs: string[]; sources: string[] } {
  const ops: string[] = [];
  const aggs: string[] = [];
  const sources: string[] = [];
  const walk = (x: unknown): void => {
    if (x === null || typeof x !== 'object') return;
    if (Array.isArray(x)) return void x.forEach(walk);
    const o = x as Record<string, unknown>;
    if (typeof o.op === 'string') ops.push(o.op);
    if (o.op === 'source' && typeof o.name === 'string') sources.push(o.name);
    if (o.op === 'aggregate') for (const a of o.aggs as { fn: string }[]) aggs.push(a.fn);
    Object.values(o).forEach(walk);
  };
  walk(statement);
  return { ops, aggs, sources };
}

const count = (xs: readonly string[], x: string): number => xs.filter((y) => y === x).length;

describe('UNWIND range() from the row a statement starts with', () => {
  const reads: readonly (readonly [string, Params?])[] = [
    ['UNWIND range(1, 5) AS i RETURN i'],
    ['UNWIND range(0, 10, 3) AS i RETURN i'],
    ['UNWIND range(5, 1, -2) AS i RETURN i'],
    ['UNWIND range(-2, 2) AS i RETURN i'],
    ['UNWIND range(1, 1) AS i RETURN i'],
    // No numbers: the end before the start, or a step that leads away from it.
    ['UNWIND range(3, 1) AS i RETURN i'],
    ['UNWIND range(1, 3, -1) AS i RETURN i'],
    // A NULL argument is a NULL list, which has no rows.
    ['UNWIND range(1, null) AS i RETURN i'],
    ['UNWIND range(null, 3) AS i RETURN i'],
    ['UNWIND range(1, 3, null) AS i RETURN i'],
    ['UNWIND range($from, $to) AS i RETURN i', { from: 7, to: 9 }],
    ['UNWIND range($from, $to, $step) AS i RETURN i', { from: 9, to: 1, step: -4 }],
    ['UNWIND range($from, $to) AS i RETURN i', { from: 1, to: null }],
    // Arguments that are computed.
    ['UNWIND range(1 + 1, 2 * 3) AS i RETURN i'],
    ['UNWIND range(1, size([1, 2, 3])) AS i RETURN i'],
    ['UNWIND range($from, $from + 2) AS i RETURN i', { from: 40 }],
    // What comes after reads the numbers.
    ['UNWIND range(1, 6) AS i WITH i WHERE i % 2 = 0 RETURN i * 10 AS x'],
    ['UNWIND range(1, 100) AS i RETURN sum(i) AS s, count(*) AS n, min(i) AS lo, max(i) AS hi'],
    ['UNWIND range(1, 10) AS i RETURN i ORDER BY i DESC LIMIT 3'],
    ['UNWIND range(1, 10) AS i RETURN i SKIP 2 LIMIT 3'],
    ['UNWIND range(1, 4) AS i RETURN i, i * i AS square, i > 2 AS big'],
    ['UNWIND range(1, 3) AS i RETURN collect(i) AS all'],
    // A large one: the numbers past what a small list holds.
    ['UNWIND range(1, 5000) AS i RETURN count(*) AS n, sum(i) AS s'],
  ];
  for (const [cypher, params] of reads) test(params ? `${cypher} with ${JSON.stringify(params)}` : cypher, () => start('empty').run(cypher, params));

  test('on a graph: the numbers beside what a later MATCH finds', () => {
    const p = start('social');
    p.run('UNWIND range(1, 2) AS i MATCH (n:Person) WITH i, n ORDER BY i, n.name RETURN i, n.name LIMIT 5');
    p.run('UNWIND range(1900, 1920, 10) AS year OPTIONAL MATCH (n:Person) WHERE n.born >= year AND n.born < year + 10 RETURN year, count(n) AS people ORDER BY year');
  });
});

describe('UNWIND range() beside rows', () => {
  const reads: readonly (readonly [string, Params?])[] = [
    // The rows' order, then the numbers'.
    ['UNWIND [3, 1, 2] AS n UNWIND range(1, n) AS i RETURN n, i'],
    ['UNWIND range(1, 3) AS n UNWIND range(n, 1, -1) AS i RETURN n, i'],
    ['UNWIND range(1, 3) AS a UNWIND range(a, 3) AS b UNWIND range(b, 3) AS c RETURN a, b, c'],
    // A row with no numbers is dropped.
    ['UNWIND [2, 0, 1] AS n UNWIND range(1, n) AS i RETURN n, i'],
    ['UNWIND [0, 0] AS n UNWIND range(1, n) AS i RETURN n, i'],
    // A row and a parameter.
    ['UNWIND [1, 2] AS n UNWIND range(n, $to) AS i RETURN n, i', { to: 3 }],
    ['UNWIND [1, 2] AS n UNWIND range($from, n * 2, n) AS i RETURN n, i', { from: 0 }],
    // An argument computed from the row.
    ['UNWIND [1, 2, 3] AS n UNWIND range(n * 10, n * 10 + 1) AS i RETURN n, i'],
    ['UNWIND [1, 2, 3] AS n WITH n WHERE n <> 2 UNWIND range(1, n) AS i RETURN n, i'],
    ['UNWIND [1, 2, 3] AS n UNWIND range(1, n) AS i RETURN n, count(*) AS numbers, sum(i) AS s ORDER BY n'],
    // Arguments that read no row: the list as before, for each row.
    ['UNWIND [10, 20] AS n UNWIND range(1, 2) AS i RETURN n, i'],
    ['UNWIND [10, 20] AS n UNWIND range($from, $to) AS i RETURN n, i', { from: 5, to: 6 }],
  ];
  for (const [cypher, params] of reads) test(params ? `${cypher} with ${JSON.stringify(params)}` : cypher, () => start('empty').run(cypher, params));

  test('after a MATCH, with arguments that read no row and that read one', () => {
    const p = start('social');
    p.run('MATCH (n:Person) WITH n ORDER BY n.name LIMIT 3 UNWIND range(1, 2) AS i RETURN n.name, i');
    p.run('MATCH (n:Person) WITH n ORDER BY n.name LIMIT 3 WITH n.name AS name, size(n.name) % 3 AS k UNWIND range(0, k) AS i RETURN name, k, i');
  });
});

describe('UNWIND range() into writes', () => {
  test('nodes made in the numbers\' order, with the ids smaltcy\'s engine gives them', () => {
    const p = start('empty');
    p.run('UNWIND range(1, 5) AS i CREATE (n:N {i: i}) RETURN id(n) AS id, n.i AS i');
    p.run('UNWIND range(5, 1, -2) AS i CREATE (n:N {i: i * 100}) RETURN id(n) AS id, n.i AS i');
    p.run('UNWIND range($from, $to) AS i CREATE (:N {i: i})', { from: 10, to: 12 });
    p.run('UNWIND range($from, $to) AS i CREATE (:N {i: i})', { from: 13, to: 12 });
    p.run('UNWIND range($from, $to) AS i CREATE (:N {i: i})', { from: 13, to: null });
    p.run('MATCH (n:N) RETURN n.i AS i ORDER BY id(n)');
  });

  test('a thousand at once, and again', () => {
    const p = start('social');
    p.run('UNWIND range(1, 1000) AS i CREATE (:Many {i: i})');
    p.run('UNWIND range($from, $to) AS i CREATE (:Many {i: i})', { from: 1001, to: 2000 });
    p.run('MATCH (m:Many) RETURN count(*) AS n, sum(m.i) AS s, min(m.i) AS lo, max(m.i) AS hi');
  });

  test('MERGE, relationships and what a write made', () => {
    const p = start('empty');
    p.run('UNWIND range(1, 4) AS i MERGE (n:M {i: i % 2}) RETURN id(n) AS id, i');
    p.run('UNWIND range(1, 3) AS i MERGE (n:M {i: i}) RETURN id(n) AS id, i');
    p.run('UNWIND range(1, 3) AS i CREATE (a:A {i: i})-[r:TO {i: i}]->(b:B {i: -i}) RETURN id(a) AS a, id(r) AS r, id(b) AS b');
    p.run('MATCH (a:A) WITH a ORDER BY a.i UNWIND range(1, 2) AS k CREATE (a)-[:MORE {k: k}]->(:C {k: k}) RETURN count(*) AS n');
  });

  test('beside rows that a write made', () => {
    const p = start('empty');
    p.run('UNWIND [2, 3] AS n CREATE (a:A {n: n}) WITH a, n UNWIND range(1, n) AS i CREATE (a)-[:HAS {i: i}]->(:B {i: i, of: n}) RETURN count(*) AS made');
    p.run('MATCH (a:A)-[h:HAS]->(b:B) RETURN a.n AS n, h.i AS i, b.of AS of ORDER BY n, i');
  });
});

describe('the plan of UNWIND range()', () => {
  const tables = () => start('social').tables;

  test('from the first row: the function alone, no list made or taken apart', () => {
    for (const [cypher, params] of [
      ['UNWIND range(1, 3) AS i RETURN i', {}],
      ['UNWIND range($from, $to) AS i RETURN i', { from: 1, to: 3 }],
      ['UNWIND range($from, $to, $step) AS i RETURN i * 2 AS x', { from: 1, to: 9, step: 2 }],
    ] as const) {
      const p = parts(compileQuery(compile(cypher).plan, tables(), { params }).statement);
      expect(p.sources, cypher).toEqual(['range']);
      expect(p.ops, cypher).not.toContain('explode');
      expect(p.ops, cypher).not.toContain('join');
      expect(p.aggs, cypher).not.toContain('implode');
    }
  });

  test('in a write', () => {
    const cypher = 'UNWIND range($from, $to) AS i CREATE (:Bench {i: i})';
    const p = parts(compileWrite(compile(cypher).plan as never, tables(), { from: 1, to: 3 }).statement);
    expect(p.sources).toEqual(['range']);
    expect(p.ops).not.toContain('explode');
    expect(p.ops).not.toContain('join');
    expect(p.aggs).not.toContain('implode');
    expect(count(p.ops, 'graphCreate')).toBe(1);
  });

  test('beside rows whose columns the arguments read: a join that keeps the rows\' order', () => {
    for (const cypher of [
      'UNWIND [3, 1] AS n UNWIND range(1, n) AS i RETURN n, i',
      // The row read inside a call, a CASE and a test for NULL.
      'UNWIND [3, 1] AS n UNWIND range(n - 1, 2 * n, 1) AS i RETURN n, i',
      'UNWIND [3, 1] AS n UNWIND range(1, CASE WHEN n IS NULL THEN 0 ELSE n END) AS i RETURN n, i',
    ]) {
      const statement = compileQuery(compile(cypher).plan, tables()).statement;
      const p = parts(statement);
      expect(p.sources, cypher).toEqual(['range']);
      expect(p.aggs, cypher).not.toContain('implode');
      // The list literal is taken apart; the numbers are not a list.
      expect(count(p.ops, 'explode'), cypher).toBe(1);
      expect(count(p.ops, 'join'), cypher).toBe(1);
      const joins: Record<string, unknown>[] = [];
      const walk = (x: unknown): void => {
        if (x === null || typeof x !== 'object') return;
        if (Array.isArray(x)) return void x.forEach(walk);
        const o = x as Record<string, unknown>;
        if (o.op === 'join') joins.push(o);
        Object.values(o).forEach(walk);
      };
      walk(statement);
      expect(joins[0], cypher).toMatchObject({ kind: 'cross', ordered: true });
      expect((joins[0]!.inputs as { op: string; name?: string }[])[1], cypher).toMatchObject({ op: 'source', kind: 'function', name: 'range' });
      start('empty').run(cypher);
    }
  });

  test('refused as range() is anywhere: an argument that may not be a whole number, one or four arguments', () => {
    for (const [cypher, params] of [
      ['UNWIND range(1, $to) AS i RETURN i', { to: 2.5 }],
      ['UNWIND range($from, 3) AS i RETURN i', { from: 'a' }],
      ['UNWIND [1.5, 2.5] AS x UNWIND range(1, x) AS i RETURN i', {}],
      ['RETURN range(1, $to) AS l', { to: 2.5 }],
      ['UNWIND range(1) AS i RETURN i', {}],
      ['UNWIND range(1, 2, 3, 4) AS i RETURN i', {}],
    ] as const) {
      expect(() => compileQuery(compile(cypher).plan, tables(), { params }), cypher).toThrow(Unsupported);
    }
  });

  test('an argument that reads its row only inside a nested plan is refused, as it was', () => {
    // smaltdb runs a function for each row only where an argument reads the row's own columns, and does not look
    // into a nested plan for them: such a statement keeps the list, which the compiler refuses.
    const cypher = 'MATCH (p:Person) WITH p ORDER BY p.name LIMIT 3 UNWIND range(1, size([(p)--(f) | f])) AS i RETURN p.name, i';
    expect(() => compileQuery(compile(cypher).plan, tables())).toThrow(Unsupported);
  });

  test('a list as before where the arguments read no row of rows that are there, and where range() is not what is unwound', () => {
    for (const cypher of [
      'MATCH (n:Person) UNWIND range(1, 2) AS i RETURN n.name, i',
      'UNWIND [1, 2] AS n UNWIND range(1, 2) AS i RETURN n, i',
      'UNWIND range(1, 3) + [9] AS i RETURN i',
      'UNWIND tail(range(1, 3)) AS i RETURN i',
      'RETURN range(1, 3) AS l',
      // The row read inside a list comprehension, which this compiler does not look through.
      'UNWIND [2, 3] AS n UNWIND range(1, size([x IN [1, 2, 3] WHERE x <= n])) AS i RETURN n, i',
    ]) {
      // The numbers are made a list (`implode`), as `range()` is anywhere else.
      expect(parts(compileQuery(compile(cypher).plan, tables()).statement).aggs, cypher).toContain('implode');
      start('social').run(cypher);
    }
  });
});
