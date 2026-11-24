/**
 * Statements as an application sends them: no two the same. bench/smaltdb.ts and bench/writes.ts run one text again and
 * again, which an engine that keeps its plans by their text answers from that cache; here every statement differs from
 * the others of its case in a value. Each case is measured twice: with the value as a literal in the text, and as a
 * parameter (one text, another value each run). The cases are bench/queries.ts's and bench/writes.ts's that have such a
 * value: group by city and all relationships have none, and the triangles' community has 6 values.
 *
 * smaltcy's MemoryStore and smaltdb (`runOnSmaltdb`, ADR 0004) over the same generated network as bench/smaltdb.ts, the
 * network's index on :Person(name) on both. A statement can be timed once, so the engines take turns in blocks of BLOCK
 * statements, each block the same values on both (bench/timing.ts says why they take turns). An engine's time is the
 * median of its timed statements; the ratio is the median of the blocks' ratios, each of two blocks run back to back.
 * BENCH_BLOCKS blocks are timed (default 20) after WARM_BLOCKS that aren't; statements that take long stop sooner
 * (WARM_MS, TIMED_MS). Rows and counts must agree on every timed statement. `BENCH_ENTRY=bench/vary.ts npm run
 * bench:smaltdb`; BENCH_PEOPLE sizes it, BENCH_ONLY runs the cases whose name contains it. Method:
 * docs/research/benchmarks.md.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { Database } from 'smaltdb-src/engine/database.js';
import { registerLanguage } from 'smaltdb-src/engine/plan/language.js';
import { network } from '../src/datasets/index.js';
import { dumpGraph } from '../src/engine/io.js';
import { open } from '../src/index.js';
import { cypherLanguage } from '../src/smaltdb/language.js';
import { graphTablesFor, loadStatements, schemaStatements } from '../src/smaltdb/schema.js';
import { indexStatement, runOnSmaltdb } from '../src/smaltdb/write.js';
import { median } from './timing.js';

registerLanguage(cypherLanguage());

const PEOPLE = Number(process.env.BENCH_PEOPLE ?? 20000);
const BLOCKS = Number(process.env.BENCH_BLOCKS ?? 20);
const ONLY = process.env.BENCH_ONLY;
/** Statements an engine runs before the other takes its turn. */
const BLOCK = 10;
const WARM_BLOCKS = 2;
/** Values a case takes in one mode: one for each statement of the warm-up, then of the timed blocks. */
const EACH = (WARM_BLOCKS + BLOCKS) * BLOCK;
// Statements that take long: the warm-up ends once it has taken WARM_MS (one block at least), the timed blocks once
// they have taken TIMED_MS (two at least).
const WARM_MS = 500;
const TIMED_MS = 4000;

type Params = Record<string, unknown>;

interface Case {
  readonly name: string;
  /** Run `i` with its values written into the text. */
  readonly literal: (i: number) => string;
  /** The same statement with parameters, and their values for run `i`. */
  readonly text: string;
  readonly params: (i: number) => Params;
  /** Run once before a mode's statements (not timed): what they need to be there. */
  readonly before?: string;
  /** Run before statement `i` (not timed): what that one needs. */
  readonly setup?: (i: number) => string;
  /** Run after every statement (not timed): undoes it, where the next would otherwise run on a larger graph. */
  readonly cleanup?: string;
  /** Run once after a mode's statements (not timed): undoes them, so every mode starts from the same graph. */
  readonly after?: string;
}

const mem = open();
mem.load(network(PEOPLE));
const raw = dumpGraph(mem.store);
const ids: number[] = [];
mem.store.scanRels(null, (id) => void ids.push(id));
const data = { ...raw, relationships: raw.relationships.map((r, i) => ({ ...r, id: ids[i]! })) };
const tables = graphTablesFor(data);
const db = Database.openMemory();
for (const st of [...schemaStatements(tables), ...loadStatements(data, tables)]) db.queryPlan(st);
for (const ix of raw.indexes ?? []) db.queryPlan(indexStatement({ kind: 'createIndex', label: ix.label, key: ix.key } as never, tables));

// Each mode of a case reads its own stretch of these, so no value comes twice within a case.
const names = (mem.run(`MATCH (p:Person) RETURN p.name LIMIT ${2 * EACH + 1}`).rows as string[][]).map((r) => r[0]!);
if (names.length < 2 * EACH + 1) throw new Error(`the network has ${names.length} people; ${2 * EACH + 1} are needed (BENCH_PEOPLE, BENCH_BLOCKS)`);
const quoted = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const name = (i: number) => names[i]!;

const CITIES = (mem.run('MATCH (c:City) RETURN c.name').rows as string[][]).map((r) => r[0]!);
const CLEAN_BENCH = 'MATCH (n:Bench) DETACH DELETE n';
/** A case whose statements begin at a person found by name. */
const fromPerson = (name_: string, rest: string): Case => ({
  name: name_,
  literal: (i) => `MATCH (p:Person {name: ${quoted(name(i))}})${rest}`,
  text: `MATCH (p:Person {name: $name})${rest}`,
  params: (i) => ({ name: name(i) }),
});
/** A shortest path between two people, or from a person to a city (no path: KNOWS joins people only). */
const shortest = (name_: string, arrow: string, to: 'person' | 'city'): Case => {
  const end = (v: string) => (to === 'person' ? `(b:Person {name: ${v}})` : `(b:City {name: ${v}})`);
  const other = (i: number) => (to === 'person' ? name(i + 1) : CITIES[i % CITIES.length]!);
  const query = (a: string, b: string) => `MATCH (a:Person {name: ${a}}), ${end(b)} MATCH p = shortestPath((a)-[:KNOWS*]${arrow}(b)) RETURN length(p)`;
  return { name: name_, literal: (i) => query(quoted(name(i)), quoted(other(i))), text: query('$a', '$b'), params: (i) => ({ a: name(i), b: other(i) }) };
};
const CASES: Case[] = [
  fromPerson('seek by name', ' RETURN p.age'),
  fromPerson('1 hop', '-[:KNOWS]-(f) RETURN count(f)'),
  fromPerson('2 hops', '-[:KNOWS]-()-[:KNOWS]-(f) RETURN count(f)'),
  fromPerson('3 hops', '-[:KNOWS]-()-[:KNOWS]-()-[:KNOWS]-(f) RETURN count(f)'),
  fromPerson('3 hops, directed', '<-[:KNOWS]-()<-[:KNOWS]-()<-[:KNOWS]-(f) RETURN count(f)'),
  fromPerson('2 hops to a label', '-[:KNOWS]-()-[:KNOWS]-(f:Person) RETURN count(f)'),
  fromPerson('2 hops, relationship filter', '-[:KNOWS]-()-[r:KNOWS]-(f) WHERE r.since >= 2013 RETURN count(f)'),
  fromPerson('var-length 1..3, distinct', '-[:KNOWS*1..3]-(f) RETURN count(DISTINCT f)'),
  shortest('shortest path', '-', 'person'),
  shortest('shortest path, directed', '->', 'person'),
  shortest('shortest path, none', '-', 'city'),
  {
    name: 'label scan + filter',
    // Ages are whole numbers from 18 to 77: a tenth more each run, so no two statements compare with the same value.
    literal: (i) => `MATCH (p:Person) WHERE p.age > ${20 + i / 10} RETURN count(p)`,
    text: 'MATCH (p:Person) WHERE p.age > $age RETURN count(p)',
    params: (i) => ({ age: 20 + i / 10 }),
  },
  {
    name: 'node of a small label',
    // One of a label's some 440 nodes, by a property that has no index: a scan of the label on both engines.
    before: `UNWIND range(0, ${2 * EACH}) AS i CREATE (:Bench {i: i})`,
    literal: (i) => `MATCH (n:Bench {i: ${i}}) RETURN n.i`,
    text: 'MATCH (n:Bench {i: $i}) RETURN n.i',
    params: (i) => ({ i }),
    after: CLEAN_BENCH,
  },
  {
    name: 'create 1 node',
    literal: (i) => `CREATE (:Bench {i: ${i}})`,
    text: 'CREATE (:Bench {i: $i})',
    params: (i) => ({ i }),
    after: CLEAN_BENCH,
  },
  {
    name: 'create 1,000 nodes',
    literal: (i) => `UNWIND range(${1000 * i}, ${1000 * i + 999}) AS i CREATE (:Bench {i: i})`,
    text: 'UNWIND range($from, $to) AS i CREATE (:Bench {i: i})',
    params: (i) => ({ from: 1000 * i, to: 1000 * i + 999 }),
    cleanup: CLEAN_BENCH,
  },
  {
    name: 'create 1 relationship',
    literal: (i) => `MATCH (a:Person {name: ${quoted(name(i))}}) CREATE (a)-[:BENCH]->(:Bench {i: ${i}})`,
    text: 'MATCH (a:Person {name: $name}) CREATE (a)-[:BENCH]->(:Bench {i: $i})',
    params: (i) => ({ name: name(i), i }),
    after: CLEAN_BENCH,
  },
  {
    name: 'create 1,000 relationships',
    literal: (i) => `MATCH (p:Person) WITH p LIMIT 1000 CREATE (p)-[:BENCH]->(:Bench {i: ${i}})`,
    text: 'MATCH (p:Person) WITH p LIMIT 1000 CREATE (p)-[:BENCH]->(:Bench {i: $i})',
    params: (i) => ({ i }),
    cleanup: CLEAN_BENCH,
  },
  {
    name: 'set 1 property by name',
    literal: (i) => `MATCH (p:Person {name: ${quoted(name(i))}}) SET p.bench = ${i}`,
    text: 'MATCH (p:Person {name: $name}) SET p.bench = $i',
    params: (i) => ({ name: name(i), i }),
    after: 'MATCH (p:Person) WHERE p.bench IS NOT NULL REMOVE p.bench',
  },
  {
    name: 'set 1,000 properties',
    literal: (i) => `MATCH (p:Person) WITH p LIMIT 1000 SET p.bench = ${i}`,
    text: 'MATCH (p:Person) WITH p LIMIT 1000 SET p.bench = $i',
    params: (i) => ({ i }),
    after: 'MATCH (p:Person) WHERE p.bench IS NOT NULL REMOVE p.bench',
  },
  {
    name: 'merge existing node',
    literal: (i) => `MERGE (p:Person {name: ${quoted(name(i))}})`,
    text: 'MERGE (p:Person {name: $name})',
    params: (i) => ({ name: name(i) }),
  },
  {
    name: 'merge 1,000 new nodes',
    literal: (i) => `UNWIND range(${1000 * i}, ${1000 * i + 999}) AS i MERGE (:Bench {i: i})`,
    text: 'UNWIND range($from, $to) AS i MERGE (:Bench {i: i})',
    params: (i) => ({ from: 1000 * i, to: 1000 * i + 999 }),
    cleanup: CLEAN_BENCH,
  },
  {
    name: 'delete 1 node',
    // The nodes every mode deletes one by one: found by a scan of their label on both engines (no index on :Bench(i)).
    before: `UNWIND range(0, ${2 * EACH}) AS i CREATE (:Bench {i: i})`,
    literal: (i) => `MATCH (n:Bench {i: ${i}}) DETACH DELETE n`,
    text: 'MATCH (n:Bench {i: $i}) DETACH DELETE n',
    params: (i) => ({ i }),
    after: CLEAN_BENCH,
  },
  {
    name: 'delete 1,000 nodes',
    setup: (i) => `UNWIND range(1, 1000) AS j CREATE (:Bench {batch: ${i}})`,
    literal: (i) => `MATCH (n:Bench {batch: ${i}}) DETACH DELETE n`,
    text: 'MATCH (n:Bench {batch: $batch}) DETACH DELETE n',
    params: (i) => ({ batch: i }),
  },
];

interface Outcome {
  readonly rows: unknown;
  readonly counts: unknown;
}
const onMem = (cypher: string, params?: Params): Outcome => {
  const r = mem.run(cypher, params);
  return { rows: r.rows, counts: r.counts };
};
const onDb = (cypher: string, params?: Params): Outcome => {
  const r = runOnSmaltdb(db, cypher, params ? { params } : {});
  return { rows: r.rows, counts: r.counts };
};
type Engine = (cypher: string, params?: Params) => Outcome;

/** Rows in any order (no case orders them), floats to 9 digits, and what was written (the counts that aren't 0). */
const norm = (o: Outcome): string =>
  JSON.stringify({
    rows: (o.rows as unknown[]).map((r) => JSON.stringify(r, (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? +v.toFixed(9) : v))).sort(),
    counts: Object.entries((o.counts ?? {}) as Record<string, number>).filter(([, n]) => n).sort(([a], [b]) => (a < b ? -1 : 1)),
  });

const ENGINES: readonly Engine[] = [onMem, onDb];

interface Times {
  /** For smaltcy and smaltdb, the median of the timed statements, ms. */
  readonly ms: [number, number];
  /** The median over the timed blocks of smaltdb's median in the block over smaltcy's. */
  readonly ratio: number;
  /** Timed statements on each engine. */
  readonly statements: number;
}

/** A case in one mode on both engines, over the values from `from` on. */
function time(c: Case, mode: 'literal' | 'parameter', from: number): Times {
  if (c.before) for (const engine of ENGINES) engine(c.before);
  /** Statement `i` on an engine with what it needs before and after it, and its time. */
  const run = (engine: Engine, i: number): { ms: number; outcome: Outcome } => {
    if (c.setup) engine(c.setup(i));
    const t0 = performance.now();
    const outcome = mode === 'literal' ? engine(c.literal(i)) : engine(c.text, c.params(i));
    const ms = performance.now() - t0;
    if (c.cleanup) engine(c.cleanup);
    return { ms, outcome };
  };
  let spent = 0;
  for (let b = 0; b < WARM_BLOCKS && (b < 1 || spent < WARM_MS); b++) {
    for (const engine of ENGINES) for (let j = 0; j < BLOCK; j++) spent += run(engine, from + b * BLOCK + j).ms;
  }
  // The timed blocks take the same values however long the warm-up was.
  const all: [number[], number[]] = [[], []];
  const ratios: number[] = [];
  spent = 0;
  for (let b = 0; b < BLOCKS && (b < 2 || spent < TIMED_MS); b++) {
    const first = from + (WARM_BLOCKS + b) * BLOCK;
    const gave: string[] = [];
    const medians = ENGINES.map((engine, e) => {
      const ts: number[] = [];
      for (let j = 0; j < BLOCK; j++) {
        const r = run(engine, first + j);
        ts.push(r.ms);
        spent += r.ms;
        const n = norm(r.outcome);
        if (e === 0) gave.push(n);
        else if (gave[j] !== n) throw new Error(`engines disagree on ${c.name} (${mode}, value ${first + j}): ${gave[j]!.slice(0, 200)} vs ${n.slice(0, 200)}`);
      }
      all[e]!.push(...ts);
      return median(ts);
    });
    ratios.push(medians[1]! / medians[0]!);
  }
  if (c.after) for (const engine of ENGINES) engine(c.after);
  return { ms: [median(all[0]), median(all[1])], ratio: median(ratios), statements: all[0].length };
}

const st = mem.store.stats();
console.log(`network(${PEOPLE}): ${st.nodes} nodes, ${st.rels} relationships`);
console.log(`ms: the median of up to ${BLOCKS * BLOCK} statements, no two of a case with the same value; the engines take turns in blocks of ${BLOCK}; ratio: the median of the blocks' ratios\n`);
console.log(' '.repeat(26), 'a literal in the text'.padStart(30), 'a parameter'.padStart(30));
console.log('statement'.padEnd(26), 'smaltcy'.padStart(10), 'smaltdb'.padStart(10), 'ratio'.padStart(8), 'smaltcy'.padStart(11), 'smaltdb'.padStart(10), 'ratio'.padStart(8));
type Result = { smaltcy: number; smaltdb: number; ratio: number; statements: number };
const results: Record<string, Record<'literal' | 'parameter', Result>> = {};
const ratio = (x: number) => `${x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)}x`.padStart(8);
for (const c of CASES.filter((c) => !ONLY || c.name.includes(ONLY))) {
  const out = {} as Record<'literal' | 'parameter', Result>;
  // Each mode takes its own stretch of values.
  for (const [k, mode] of (['literal', 'parameter'] as const).entries()) {
    const t = time(c, mode, k * EACH);
    out[mode] = { smaltcy: +t.ms[0].toFixed(4), smaltdb: +t.ms[1].toFixed(4), ratio: +t.ratio.toFixed(2), statements: t.statements };
  }
  results[c.name] = out;
  const f = (x: number, w: number) => x.toFixed(3).padStart(w);
  console.log(c.name.padEnd(26), f(out.literal.smaltcy, 10), f(out.literal.smaltdb, 10), ratio(out.literal.ratio), f(out.parameter.smaltcy, 11), f(out.parameter.smaltdb, 10), ratio(out.parameter.ratio));
}
mkdirSync('bench/results', { recursive: true });
const file = `bench/results/${new Date().toISOString().slice(0, 10)}.smaltdb-vary.local.json`;
writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), node: process.version, people: PEOPLE, blocks: BLOCKS, block: BLOCK, results }, null, 2));
console.log(`\nwrote ${file}`);
