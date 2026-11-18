import { describe, expect, test } from 'vitest';
import { socialStores } from './helpers/graphs.js';
import { READ_CASES, READ_PARAMS } from './helpers/read-cases.js';

/**
 * Reading Cypher. Every case runs on every store: the same plan must give the same rows (in the same order where the
 * query orders them). The cases are in helpers/read-cases.ts, which the smaltdb differential test runs too.
 */
describe.each(socialStores())('%s store', (_name, g) => {
  test.each(READ_CASES)('%s', (_label, query, expected) => {
    expect(g.query(query, READ_PARAMS)).toEqual(expected);
  });

  test('nodes and relationships in results', () => {
    const [row] = g.query("MATCH (a:Person {name: 'Ada'})-[r:KNOWS]->(b) RETURN a, r, b");
    expect(row!.a).toMatchObject({ kind: 'node', labels: ['Person'], properties: { name: 'Ada', born: 1815, langs: ['en', 'fr'] } });
    expect(row!.r).toMatchObject({ kind: 'relationship', type: 'KNOWS', properties: { since: 1833 } });
    const r = row!.r as { start: number; end: number };
    expect([r.start, r.end]).toEqual([(row!.a as { id: number }).id, (row!.b as { id: number }).id]);
  });

  test('paths in results', () => {
    const [row] = g.query("MATCH p = (:Person {name: 'Ada'})-[:KNOWS]->(b) RETURN p");
    const p = row!.p as { kind: string; nodes: { properties: { name: string } }[]; relationships: unknown[] };
    expect(p.kind).toBe('path');
    expect(p.nodes.map((n) => n.properties.name)).toEqual(['Ada', 'Alan']);
    expect(p.relationships).toHaveLength(1);
  });

  test('relationships are distinct within a match', () => {
    // a-[r1]-b-[r2]-c can't use the same relationship twice, so a and c differ.
    const rows = g.query("MATCH (a:Person {name: 'Ada'})-[:KNOWS]-(b)-[:KNOWS]-(c) RETURN c.name AS name ORDER BY name");
    expect(rows.map((r) => r.name)).toEqual(['Edsger', 'Grace']);
  });

  test('EXPLAIN shows the steps', () => {
    const text = g.explain("MATCH (a:Person {name: 'Ada'})-[:KNOWS]->(b) RETURN b.name");
    expect(text).toContain('Match');
    expect(text).toContain('Expand(All)');
  });
});
