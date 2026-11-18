/**
 * smaltcy's graphs in smaltdb, for the tests that run Cypher on both engines (test/smaltdb-differential.test.ts,
 * test/smaltdb-writes.test.ts).
 */
import { Database } from 'smaltdb-src/engine/database.js';
import { dumpGraph } from '../../src/engine/io.js';
import type { Graph } from '../../src/index.js';
import { graphTablesFor, loadStatements, schemaStatements, type GraphData, type GraphTables } from '../../src/smaltdb/schema.js';

/** A store's graph to load, with its relationship ids (`dumpGraph` gives relationships in id order, without them). */
export function dataOf(g: Graph): GraphData {
  const data = dumpGraph(g.store);
  const ids: number[] = [];
  g.store.scanRels(null, (id) => void ids.push(id));
  return { ...data, relationships: data.relationships.map((r, i) => ({ ...r, id: ids[i]! })) };
}

/** A smaltcy graph and the same graph in a smaltdb database. */
export function both(g: Graph): { g: Graph; db: Database; tables: GraphTables } {
  const data = dataOf(g);
  const tables = graphTablesFor(data);
  const db = Database.openMemory();
  for (const st of [...schemaStatements(tables), ...loadStatements(data, tables)]) db.queryPlan(st);
  return { g, db, tables };
}
