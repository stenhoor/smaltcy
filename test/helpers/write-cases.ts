/**
 * The write cases of the Cypher suite: a name, the graph they start from (empty, or the social graph of
 * helpers/graphs.ts) and statements run in order, each with the rows it gives (as `Graph.query` gives them), what it
 * wrote, or the error it fails with. test/cypher-write.test.ts runs them on smaltcy's engine, and
 * test/smaltdb-writes.test.ts on smaltdb, comparing the two after each statement.
 */
import type { WriteCounts } from '../../src/engine/exec.js';

export interface WriteStep {
  readonly cypher: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly rows?: readonly Record<string, unknown>[];
  readonly counts?: Partial<WriteCounts>;
  /** The statement fails, with a message that matches. */
  readonly throws?: RegExp;
}

export const WRITE_CASES: readonly [string, 'empty' | 'social', readonly WriteStep[]][] = [
  ['CREATE: nodes, relationships and counts', 'empty', [
    {
      cypher: 'CREATE (a:A {x: 1})-[:R {w: 2}]->(b:B), (b)-[:R]->(:C) RETURN a.x AS x',
      rows: [{ x: 1 }],
      counts: { nodesCreated: 3, relationshipsCreated: 2, labelsAdded: 3, propertiesSet: 2 },
    },
    { cypher: 'MATCH (:A)-[:R]->(:B)-[:R]->(c) RETURN labels(c) AS l', rows: [{ l: ['C'] }] },
  ]],
  ['CREATE: per input row', 'empty', [
    { cypher: 'UNWIND range(1, 5) AS i CREATE (:N {i: i})' },
    { cypher: 'MATCH (n:N) RETURN sum(n.i) AS s', rows: [{ s: 15 }] },
  ]],
  ['CREATE: between matched nodes', 'social', [
    { cypher: "MATCH (a:Person {name: 'Ada'}), (b:Person {name: 'Barbara'}) CREATE (a)-[:KNOWS {since: 2000}]->(b)" },
    { cypher: "MATCH (:Person {name: 'Ada'})-[:KNOWS]->(b) RETURN b.name AS n ORDER BY n", rows: [{ n: 'Alan' }, { n: 'Barbara' }] },
  ]],
  ['CREATE: reads before writes, MATCH then CREATE sees only what was there', 'empty', [
    { cypher: 'CREATE (:N), (:N)' },
    { cypher: 'MATCH (n:N) CREATE (:N)' },
    { cypher: 'MATCH (n:N) RETURN count(*) AS c', rows: [{ c: 4 }] },
  ]],
  ['CREATE: a relationship needs a type and a direction', 'empty', [
    { cypher: 'CREATE (a)-[:R]-(b)', throws: /direction/ },
    { cypher: 'CREATE (a)-[r]->(b)', throws: /one type/ },
  ]],
  ['CREATE: properties must be storable', 'empty', [
    { cypher: 'CREATE (a {m: {x: 1}})', throws: /a property can't be a MAP/ },
  ]],
  ['MERGE: matches or creates', 'empty', [
    { cypher: "MERGE (n:Person {name: 'Ada'}) ON CREATE SET n.created = true" },
    { cypher: "MERGE (n:Person {name: 'Ada'}) ON MATCH SET n.seen = true" },
    { cypher: 'MATCH (n:Person) RETURN n.created AS c, n.seen AS s', rows: [{ c: true, s: true }] },
  ]],
  ['MERGE: sees its own creations on later rows', 'empty', [
    { cypher: 'UNWIND [1, 2, 1, 3, 2] AS v MERGE (:V {v: v})' },
    { cypher: 'MATCH (n:V) RETURN count(*) AS c', rows: [{ c: 3 }] },
  ]],
  ['MERGE: relationships between bound nodes', 'empty', [
    { cypher: 'CREATE (:A {id: 1}), (:B {id: 2})' },
    { cypher: 'MATCH (a:A), (b:B) MERGE (a)-[:R]->(b)' },
    { cypher: 'MATCH (a:A), (b:B) MERGE (a)-[:R]->(b)' },
    { cypher: 'MATCH ()-[r:R]->() RETURN count(r) AS c', rows: [{ c: 1 }] },
  ]],
  ['SET and REMOVE: properties and labels', 'social', [
    { cypher: "MATCH (p:Person {name: 'Ada'}) SET p.title = 'Countess', p:Mathematician, p.born = null" },
    { cypher: 'MATCH (p:Mathematician) RETURN p.title AS t, p.born AS b', rows: [{ t: 'Countess', b: null }] },
    { cypher: "MATCH (p:Person {name: 'Ada'}) REMOVE p.title, p:Mathematician" },
    { cypher: "MATCH (p:Person {name: 'Ada'}) RETURN p.title AS t, labels(p) AS l", rows: [{ t: null, l: ['Person'] }] },
  ]],
  ['SET: replace and merge maps', 'empty', [
    { cypher: 'CREATE (:N {a: 1, b: 2})' },
    { cypher: 'MATCH (n:N) SET n += {b: 3, c: 4}' },
    { cypher: 'MATCH (n:N) RETURN properties(n) AS p', rows: [{ p: { a: 1, b: 3, c: 4 } }] },
    { cypher: 'MATCH (n:N) SET n = {z: 9}' },
    { cypher: 'MATCH (n:N) RETURN properties(n) AS p', rows: [{ p: { z: 9 } }] },
  ]],
  ['DELETE: needs DETACH when relationships remain', 'social', [
    { cypher: "MATCH (p:Person {name: 'Ada'}) DELETE p", throws: /DETACH/ },
    { cypher: "MATCH (p:Person {name: 'Ada'}) DETACH DELETE p", counts: { nodesDeleted: 1, relationshipsDeleted: 2 } },
    { cypher: 'MATCH (p:Person) RETURN count(*) AS c', rows: [{ c: 4 }] },
  ]],
  ['DELETE: relationships', 'social', [
    { cypher: 'MATCH ()-[r:LIVES_IN]->() DELETE r' },
    { cypher: 'MATCH ()-[r:LIVES_IN]->() RETURN count(r) AS c', rows: [{ c: 0 }] },
  ]],
  ['a failing statement changes nothing', 'social', [
    // The CREATE happens, then the DELETE fails: both are undone.
    { cypher: "CREATE (:Temp) WITH 1 AS x MATCH (p:Person {name: 'Ada'}) DELETE p", throws: /DETACH/ },
    { cypher: 'MATCH (t:Temp) RETURN count(t) AS c', rows: [{ c: 0 }] },
  ]],
];
