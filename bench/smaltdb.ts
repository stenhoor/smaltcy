/**
 * The same queries as bench/run.ts on smaltcy's MemoryStore and on smaltdb (the compiler to smaltdb plans, ADR 0004;
 * smaltdb ADR 0033 step 8), over the same generated network. Rows must agree; times are medians and include compiling
 * the Cypher, as Graph.run's include parsing and planning. `npm run bench:smaltdb`; BENCH_PEOPLE, BENCH_ROUNDS
 * (bench/timing.ts), BENCH_BRANCHES (the compiler's `maxBranches`) and BENCH_INDEXES (smaltcy's property indexes on
 * smaltdb too) size and shape it. Every query here is one text run again and again; bench/vary.ts runs statements that
 * differ each time. Method: docs/research/benchmarks.md.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { Database } from 'smaltdb-src/engine/database.js';
import { compile } from '../src/cypher/index.js';
import { network } from '../src/datasets/index.js';
import { dumpGraph } from '../src/engine/io.js';
import { open } from '../src/index.js';
import { graphTablesFor, loadStatements, schemaStatements } from '../src/smaltdb/schema.js';
import { compileQuery } from '../src/smaltdb/compile.js';
import { indexStatement, runOnSmaltdb } from '../src/smaltdb/write.js';
import { QUERIES } from './queries.js';
import { METHOD, ROUNDS, rounds, timed } from './timing.js';

const PEOPLE = Number(process.env.BENCH_PEOPLE ?? 20000);
let t0 = performance.now();
const mem = open();
mem.load(network(PEOPLE));
const memLoadMs = performance.now() - t0;

t0 = performance.now();
const raw = dumpGraph(mem.store);
const ids: number[] = [];
mem.store.scanRels(null, (id) => void ids.push(id));
const data = { ...raw, relationships: raw.relationships.map((r, i) => ({ ...r, id: ids[i]! })) };
const tables = graphTablesFor(data);
const db = Database.openMemory();
for (const st of [...schemaStatements(tables), ...loadStatements(data, tables)]) db.queryPlan(st);
// BENCH_INDEXES=1: the property indexes smaltcy's store has (the network's on :Person(name)) on smaltdb too.
const INDEXES = !!process.env.BENCH_INDEXES;
if (INDEXES) for (const ix of raw.indexes ?? []) db.queryPlan(indexStatement({ kind: 'createIndex', label: ix.label, key: ix.key } as never, tables));
const dbLoadMs = performance.now() - t0;

const st = mem.store.stats();
console.log(`network(${PEOPLE}): ${st.nodes} nodes, ${st.rels} relationships; smaltcy load ${memLoadMs.toFixed(0)} ms, smaltdb load ${dbLoadMs.toFixed(0)} ms`);
console.log(`${METHOD} (each run includes compiling the Cypher)\n`);
console.log('query'.padEnd(28), 'smaltcy'.padStart(10), 'smaltdb'.padStart(10), 'ratio'.padStart(8), ' rows');

// As an application runs a query (`runOnSmaltdb`); with BENCH_BRANCHES, compiled here with the compiler's maxBranches
// (how many join regions a pattern may split into).
const branches = process.env.BENCH_BRANCHES ? { maxBranches: Number(process.env.BENCH_BRANCHES) } : undefined;
const onDb = (cypher: string) => {
  if (!branches) return [...runOnSmaltdb(db, compile(cypher).plan, tables).rows] as unknown[];
  const q = compileQuery(compile(cypher).plan, tables, branches);
  return [...db.queryPlan(q.statement).rows] as unknown[];
};
const results: Record<string, { smaltcy: number; smaltdb: number | null; ratio?: number; note?: string }> = {};
for (const [name, q] of QUERIES) {
  const a = [...mem.run(q).rows] as unknown[];
  let b: unknown[];
  try {
    b = onDb(q);
  } catch (e) {
    results[name] = { smaltcy: +rounds([() => timed(() => mem.run(q))]).ms[0]!.toFixed(3), smaltdb: null, note: (e as Error).message };
    console.log(name.padEnd(28), results[name].smaltcy.toFixed(3).padStart(10), 'refused'.padStart(10), '', ` ${(e as Error).message}`);
    continue;
  }
  // Rows in any order (none of the queries orders them), floats to 9 digits.
  const norm = (rows: unknown[]) => rows.map((r) => JSON.stringify(r, (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? +v.toFixed(9) : v))).sort().join('\n');
  if (norm(a) !== norm(b)) throw new Error(`engines disagree on ${name}: ${norm(a).slice(0, 200)} vs ${norm(b).slice(0, 200)}`);
  const t = rounds([() => timed(() => mem.run(q)), () => timed(() => onDb(q))]);
  const [m, d] = t.ms as [number, number];
  results[name] = { smaltcy: +m.toFixed(3), smaltdb: +d.toFixed(3), ratio: +t.ratio[1]!.toFixed(2) };
  console.log(name.padEnd(28), m.toFixed(3).padStart(10), d.toFixed(3).padStart(10), `${t.ratio[1]!.toFixed(2)}x`.padStart(8), ` ${JSON.stringify(a[0])}`);
}
mkdirSync('bench/results', { recursive: true });
const file = `bench/results/${new Date().toISOString().slice(0, 10)}.smaltdb.local.json`;
writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), node: process.version, people: PEOPLE, indexes: INDEXES, nodes: st.nodes, rels: st.rels, rounds: ROUNDS, memLoadMs, dbLoadMs, results }, null, 2));
console.log(`\nwrote ${file}`);
