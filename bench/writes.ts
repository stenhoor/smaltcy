/**
 * Cypher writes on smaltcy's MemoryStore and on smaltdb (`runOnSmaltdb`, ADR 0004), over the same generated network as
 * bench/smaltdb.ts. Each case is a setup (not timed), the write (timed) and a cleanup that undoes it (not timed), so
 * every run starts from the same graph. Both engines must report the same counts. `BENCH_ENTRY=bench/writes.ts npm run
 * bench:smaltdb`; BENCH_PEOPLE and BENCH_ROUNDS (bench/timing.ts) size it. The network's index on :Person(name) is on
 * both engines. Every case here writes the same values on every run; bench/vary.ts writes others each time.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { Database } from 'smaltdb-src/engine/database.js';
import { compile } from '../src/cypher/index.js';
import { network } from '../src/datasets/index.js';
import { dumpGraph } from '../src/engine/io.js';
import { open } from '../src/index.js';
import { graphTablesFor, loadStatements, schemaStatements, type GraphTables } from '../src/smaltdb/schema.js';
import { indexStatement, runOnSmaltdb } from '../src/smaltdb/write.js';
import { registerLanguage } from 'smaltdb-src/engine/plan/language.js';
import { cypherLanguage } from '../src/smaltdb/language.js';

// PROTOTYPE: BENCH_LANGUAGE=1 gives smaltdb the Cypher as text, through the language registered with it.
const AS_TEXT = !!process.env.BENCH_LANGUAGE;
if (AS_TEXT) registerLanguage(cypherLanguage() as never);
const NONE = { nodesCreated: 0, nodesDeleted: 0, relationshipsCreated: 0, relationshipsDeleted: 0, propertiesSet: 0, labelsAdded: 0, labelsRemoved: 0 };
import { METHOD, ROUNDS, rounds, timed } from './timing.js';

const PEOPLE = Number(process.env.BENCH_PEOPLE ?? 20000);
// BENCH_ONLY: run only the cases whose name contains it.

interface Case {
  readonly name: string;
  readonly setup?: string;
  readonly write: string;
  readonly cleanup?: string;
}

const CLEAN_BENCH = 'MATCH (n:Bench) DETACH DELETE n';
const CASES: Case[] = [
  { name: 'create 1 node', write: "CREATE (:Bench {name: 'x'})", cleanup: CLEAN_BENCH },
  { name: 'create 1,000 nodes', write: 'UNWIND range(1, 1000) AS i CREATE (:Bench {i: i})', cleanup: CLEAN_BENCH },
  { name: 'create 1 relationship', write: "MATCH (a:Person {name: 'Bo 1'}) CREATE (a)-[:BENCH]->(:Bench)", cleanup: CLEAN_BENCH },
  { name: 'create 1,000 relationships', write: 'MATCH (p:Person) WITH p LIMIT 1000 CREATE (p)-[:BENCH]->(:Bench)', cleanup: CLEAN_BENCH },
  { name: 'set 1 property by name', write: "MATCH (p:Person {name: 'Bo 1'}) SET p.bench = 1", cleanup: "MATCH (p:Person {name: 'Bo 1'}) REMOVE p.bench" },
  { name: 'set 1,000 properties', write: 'MATCH (p:Person) WITH p LIMIT 1000 SET p.bench = 1', cleanup: 'MATCH (p:Person) WHERE p.bench IS NOT NULL REMOVE p.bench' },
  { name: 'merge existing node', write: "MERGE (p:Person {name: 'Bo 1'})" },
  { name: 'merge 1,000 new nodes', write: 'UNWIND range(1, 1000) AS i MERGE (:Bench {i: i})', cleanup: CLEAN_BENCH },
  { name: 'delete 1,000 nodes', setup: 'UNWIND range(1, 1000) AS i CREATE (:Bench {i: i})', write: CLEAN_BENCH },
];

const mem = open();
mem.load(network(PEOPLE));
const raw = dumpGraph(mem.store);
const ids: number[] = [];
mem.store.scanRels(null, (id) => void ids.push(id));
const data = { ...raw, relationships: raw.relationships.map((r, i) => ({ ...r, id: ids[i]! })) };
let tables: GraphTables = graphTablesFor(data);
const db = Database.openMemory();
for (const st of [...schemaStatements(tables), ...loadStatements(data, tables)]) db.queryPlan(st);
for (const ix of raw.indexes ?? []) db.queryPlan(indexStatement({ kind: 'createIndex', label: ix.label, key: ix.key } as never, tables));

const onMem = (cypher: string) => mem.run(cypher).counts;
const onDb = (cypher: string) => {
  if (AS_TEXT) return (db.query(cypher, undefined, { language: 'cypher' }) as { graph?: typeof NONE }).graph ?? NONE;
  const r = runOnSmaltdb(db, compile(cypher).plan, tables);
  tables = r.tables;
  return r.counts;
};

/** One run of a case on an engine: its setup, the write, its cleanup. The time is the write's. */
const once = (run: (c: string) => unknown, c: Case) => (): number => {
  if (c.setup) run(c.setup);
  const t = timed(() => run(c.write));
  if (c.cleanup) run(c.cleanup);
  return t;
};

const st = mem.store.stats();
console.log(`network(${PEOPLE}): ${st.nodes} nodes, ${st.rels} relationships`);
console.log(`${METHOD} (each run includes compiling the Cypher)\n`);
console.log('write'.padEnd(28), 'smaltcy'.padStart(10), 'smaltdb'.padStart(10), 'ratio'.padStart(8), ' counts');
const results: Record<string, { smaltcy: number; smaltdb: number; ratio: number }> = {};
const ONLY = process.env.BENCH_ONLY;
for (const c of CASES.filter((c) => !ONLY || c.name.includes(ONLY))) {
  // Counts must agree: compare one run of each, then undo it.
  if (c.setup) { onMem(c.setup); onDb(c.setup); }
  const a = onMem(c.write) as unknown as Record<string, number>;
  const b = onDb(c.write) as unknown as Record<string, number>;
  if (c.cleanup) { onMem(c.cleanup); onDb(c.cleanup); }
  const keys = Object.keys(b);
  const diff = keys.filter((k) => (a[k] ?? 0) !== b[k]);
  if (diff.length) throw new Error(`engines disagree on ${c.name}: ${diff.map((k) => `${k} ${a[k]} vs ${b[k]}`).join(', ')}`);
  const t = rounds([once(onMem, c), once(onDb, c)]);
  const [m, d] = t.ms as [number, number];
  results[c.name] = { smaltcy: +m.toFixed(3), smaltdb: +d.toFixed(3), ratio: +t.ratio[1]!.toFixed(2) };
  const shown = keys.filter((k) => b[k]).map((k) => `${k} ${b[k]}`).join(', ');
  console.log(c.name.padEnd(28), m.toFixed(3).padStart(10), d.toFixed(3).padStart(10), `${t.ratio[1]!.toFixed(2)}x`.padStart(8), ` ${shown}`);
}
mkdirSync('bench/results', { recursive: true });
const file = `bench/results/${new Date().toISOString().slice(0, 10)}.smaltdb-writes.local.json`;
writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), node: process.version, people: PEOPLE, rounds: ROUNDS, results }, null, 2));
console.log(`\nwrote ${file}`);
