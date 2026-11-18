import { describe, expect, test } from 'vitest';
import { CsrStore, open, records } from '../src/index.js';
import { social } from './helpers/graphs.js';
import { WRITE_CASES } from './helpers/write-cases.js';

// The write cases (helpers/write-cases.ts), which test/smaltdb-writes.test.ts also runs on smaltdb.
describe('the write cases', () => {
  test.each(WRITE_CASES)('%s', (_name, graph, steps) => {
    const g = graph === 'social' ? social() : open();
    for (const step of steps) {
      if (step.throws) {
        expect(() => g.run(step.cypher, step.params), step.cypher).toThrow(step.throws);
        continue;
      }
      const r = g.run(step.cypher, step.params);
      if (step.rows) expect(records(r), step.cypher).toEqual(step.rows);
      if (step.counts) expect(r.counts, step.cypher).toMatchObject(step.counts);
    }
  });
});

describe('transactions', () => {
  test('transaction() commits together or not at all', () => {
    const g = open();
    expect(() =>
      g.transaction((t) => {
        t.run('CREATE (:X)');
        t.run('CREATE (:X)');
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(g.query('MATCH (x:X) RETURN count(x) AS c')).toEqual([{ c: 0 }]);
    g.transaction((t) => {
      t.run('CREATE (:X)');
      t.run('CREATE (:X)');
    });
    expect(g.query('MATCH (x:X) RETURN count(x) AS c')).toEqual([{ c: 2 }]);
  });

  test('undo restores indexes', () => {
    const g = open();
    g.run('CREATE INDEX FOR (n:P) ON (n.k)');
    g.run("CREATE (:P {k: 'a'})");
    expect(() => g.run("MATCH (p:P {k: 'a'}) SET p.k = 'b' WITH p RETURN 1/0")).toThrow(/zero/);
    expect(g.query("MATCH (p:P {k: 'a'}) RETURN count(p) AS c")).toEqual([{ c: 1 }]);
    expect(g.query("MATCH (p:P {k: 'b'}) RETURN count(p) AS c")).toEqual([{ c: 0 }]);
  });
});

describe('indexes', () => {
  test('the planner seeks with an index and finds the same rows', () => {
    const g = social();
    const q = "MATCH (p:Person {name: 'Grace'}) RETURN p.born AS b";
    expect(g.explain(q)).toContain('NodeByLabelScan+Filter');
    g.run('CREATE INDEX FOR (p:Person) ON (p.name)');
    expect(g.explain(q)).toContain('NodeIndexSeek');
    expect(g.query(q)).toEqual([{ b: 1906 }]);
    // Writes keep the index up to date.
    g.run("MATCH (p:Person {name: 'Grace'}) SET p.name = 'Grace H'");
    expect(g.query(q)).toEqual([]);
    expect(g.query("MATCH (p:Person {name: 'Grace H'}) RETURN p.born AS b")).toEqual([{ b: 1906 }]);
    g.run('DROP INDEX ON :Person(name)');
    expect(g.explain(q)).not.toContain('NodeIndexSeek');
  });
});

describe('read-only stores', () => {
  test('writes fail on CsrStore', () => {
    const g = open({ store: CsrStore.from(social().store) });
    expect(() => g.run('CREATE (:X)')).toThrow(/read-only/);
  });
});
