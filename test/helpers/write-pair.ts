/**
 * A graph on smaltcy's engine and the same graph in smaltdb, kept in step: each statement runs on both, and after each
 * the two must agree (test/smaltdb-writes.test.ts, test/smaltdb-kept-writes.test.ts).
 */
import { expect } from 'vitest';
import type { Database, DatabaseOptions } from 'smaltdb-src/engine/database.js';
import { open, type Graph } from '../../src/index.js';
import { Unsupported } from '../../src/smaltdb/compile.js';
import type { GraphTables } from '../../src/smaltdb/schema.js';
import { runOnSmaltdb, type SmaltdbDatabase } from '../../src/smaltdb/write.js';
import { social } from './graphs.js';
import { both, dataOf, tablesIn } from './smaltdb.js';

export interface State {
  nodes: { id: number; labels: string[]; properties: Record<string, unknown> }[];
  relationships: { id: number; type: string; start: number; end: number; properties: Record<string, unknown> }[];
}

const byId = <T extends { id: number }>(xs: T[]) => xs.sort((a, b) => a.id - b.id);

/** smaltcy's graph. */
export function stateOf(g: Graph): State {
  const data = dataOf(g);
  return {
    nodes: byId(data.nodes.map((n) => ({ id: n.id as number, labels: [...(n.labels ?? [])], properties: { ...n.properties } }))),
    relationships: byId(data.relationships.map((r) => ({ id: r.id!, type: r.type, start: r.start as number, end: r.end as number, properties: { ...r.properties } }))),
  };
}

/** The graph in smaltdb, read back from its tables. */
export function stateIn(db: Database, t: GraphTables): State {
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
export class Pair {
  readonly g: Graph;
  readonly db: Database;

  /** The database statements are run on: the engine's, or with `through`, what that makes of it (one that counts, say). */
  readonly given: SmaltdbDatabase;

  constructor(g: Graph, through?: (db: Database) => SmaltdbDatabase, options?: DatabaseOptions) {
    const b = both(g, options);
    this.g = g;
    this.db = b.db;
    this.given = through ? through(b.db) : b.db;
  }

  /** The graph's tables in smaltdb as they are now. */
  get tables(): GraphTables {
    return tablesIn(this.db);
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
      theirs = runOnSmaltdb(this.given, cypher, { params });
    } catch (e) {
      theirsError = e;
    }
    if (theirsError instanceof Unsupported) throw theirsError;
    if (mineError !== undefined) {
      expect(theirsError, `${cypher}: fails on smaltcy (${String(mineError)}), not on smaltdb`).toBeDefined();
      // The same error: smaltcy's code and message, raised by the plan (smaltdb's raise_error) or reworded from smaltdb's.
      const { code, message } = mineError as { code: string; message: string };
      expect({ code: (theirsError as { code: string }).code, message: (theirsError as Error).message }, cypher).toEqual({ code, message });
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

export const start = (graph: 'empty' | 'social', through?: (db: Database) => SmaltdbDatabase, options?: DatabaseOptions) => new Pair(graph === 'social' ? social() : open(), through, options);

