/** The queries bench/run.ts and bench/smaltdb.ts time. */
export const QUERIES: [string, string][] = [
  ['seek by name', "MATCH (p:Person {name: 'Bo 1'}) RETURN p.age"],
  ['1 hop', "MATCH (p:Person {name: 'Bo 1'})-[:KNOWS]-(f) RETURN count(f)"],
  ['2 hops', "MATCH (p:Person {name: 'Bo 1'})-[:KNOWS]-()-[:KNOWS]-(f) RETURN count(f)"],
  ['3 hops', "MATCH (p:Person {name: 'Bo 1'})-[:KNOWS]-()-[:KNOWS]-()-[:KNOWS]-(f) RETURN count(f)"],
  ['var-length 1..3, distinct', "MATCH (p:Person {name: 'Bo 1'})-[:KNOWS*1..3]-(f) RETURN count(DISTINCT f)"],
  ['shortest path', "MATCH (a:Person {name: 'Bo 1'}), (b:Person {name: 'Gus 6'}) MATCH p = shortestPath((a)-[:KNOWS*]-(b)) RETURN length(p)"],
  ['shortest path, 5 hops', "MATCH (a:Person {name: 'Bo 1'}), (b:Person {name: 'Wen 1172'}) MATCH p = shortestPath((a)-[:KNOWS*]-(b)) RETURN length(p)"],
  ['shortest path, none (out)', "MATCH (a:Person {name: 'Wen 1172'}), (b:Person {name: 'Ana 1500'}) MATCH p = shortestPath((a)-[:KNOWS*]->(b)) RETURN length(p)"],
  ['shortest path, none (all)', "MATCH (a:Person {name: 'Bo 1'}), (b:City {name: 'Lisbon'}) MATCH p = shortestPath((a)-[:KNOWS*]-(b)) RETURN length(p)"],
  ['label scan + filter', 'MATCH (p:Person) WHERE p.age > 70 RETURN count(p)'],
  ['group by city', 'MATCH (p:Person)-[:LIVES_IN]->(c:City) RETURN c.name, count(p), avg(p.age)'],
  ['all relationships', 'MATCH ()-[r:KNOWS]->() RETURN count(r)'],
  ['triangles (bounded)', "MATCH (a:Person {community: 1})-[:KNOWS]->(b)-[:KNOWS]->(c), (a)-[:KNOWS]->(c) RETURN count(*)"],
];
