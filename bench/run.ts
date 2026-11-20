/**
 * Storage and traversal benchmarks in Node: the same queries on MemoryStore and CsrStore over a generated social
 * network. `npm run bench`; BENCH_PEOPLE and BENCH_ROUNDS (bench/timing.ts) size it, BENCH_RUNS the history steps'
 * runs; results go to bench/results/<date>.local.json. Method: docs/research/benchmarks.md.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { network } from '../src/datasets/index.js';
import { CsrStore, open } from '../src/index.js';
import { QUERIES } from './queries.js';
import { METHOD, ROUNDS, rounds, timed } from './timing.js';

const PEOPLE = Number(process.env.BENCH_PEOPLE ?? 20000);
const RUNS = Number(process.env.BENCH_RUNS ?? 7);

const t0 = performance.now();
const data = network(PEOPLE);
const mem = open();
mem.load(data);
const loadMs = performance.now() - t0;
const t1 = performance.now();
const csr = open({ store: CsrStore.from(mem.store) });
const csrMs = performance.now() - t1;
const st = mem.store.stats();
console.log(`network(${PEOPLE}): ${st.nodes} nodes, ${st.rels} relationships; generate+load ${loadMs.toFixed(0)} ms, CSR build ${csrMs.toFixed(0)} ms`);
console.log(`${METHOD}\n`);
console.log('query'.padEnd(28), 'memory'.padStart(10), 'csr'.padStart(10), 'ratio'.padStart(8), ' rows');
const results: Record<string, { memory: number; csr: number; ratio: number }> = {};
for (const [name, q] of QUERIES) {
  const a = mem.run(q).rows;
  const b = csr.run(q).rows;
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`stores disagree on ${name}`);
  const t = rounds([() => timed(() => mem.run(q)), () => timed(() => csr.run(q))]);
  const [m, c] = t.ms as [number, number];
  results[name] = { memory: +m.toFixed(3), csr: +c.toFixed(3), ratio: +t.ratio[1]!.toFixed(2) };
  console.log(name.padEnd(28), m.toFixed(3).padStart(10), c.toFixed(3).padStart(10), `${t.ratio[1]!.toFixed(2)}x`.padStart(8), ` ${JSON.stringify(a[0])}`);
}
mkdirSync('bench/results', { recursive: true });
const file = `bench/results/${new Date().toISOString().slice(0, 10)}.local.json`;
writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), node: process.version, people: PEOPLE, nodes: st.nodes, rels: st.rels, rounds: ROUNDS, loadMs, csrMs, results }, null, 2));
console.log(`\nwrote ${file}`);

// History: the network loaded with its growth, a commit per person.
{
  const HP = Number(process.env.BENCH_HISTORY_PEOPLE ?? 10000);
  const t0 = performance.now();
  const data = network(HP, 42, { history: true });
  const h = open({ history: true });
  h.load(data);
  const loadMs = performance.now() - t0;
  const last = h.version!;
  const med = (fn: () => void) => {
    fn();
    const ts: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const s = performance.now();
      fn();
      ts.push(performance.now() - s);
    }
    ts.sort((a, b) => a - b);
    return ts[Math.floor(ts.length / 2)]!;
  };
  const store = h.store as unknown as { history: { at(v: number): unknown } };
  // Opening a version: a fresh one each run (opened versions are cached).
  let v = 1;
  const openMs = (target: (i: number) => number) => {
    const ts: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const s = performance.now();
      store.history.at(target(v++));
      ts.push(performance.now() - s);
    }
    ts.sort((a, b) => a - b);
    return ts[Math.floor(ts.length / 2)]!;
  };
  const rows: [string, number][] = [
    ['open a recent version', openMs((i) => last - 3 - i)],
    ['open a version mid-way', openMs((i) => Math.floor(last / 2) - i)],
    ['diff: 1 commit', med(() => h.diff(last - 1, last))],
    ['diff: 100 commits', med(() => h.diff(last - 100, last))],
    ['diff: all, forwards', med(() => h.diff(0, last))],
    ['diff: all, backwards', med(() => h.diff(last, 0))],
    ['commits()', med(() => h.commits())],
    ['AT VERSION mid, count people', med(() => h.run(`AT VERSION ${Math.floor(last / 2)} MATCH (p:Person) RETURN count(p)`))],
  ];
  console.log(`\nhistory: network(${HP}) as it grew, ${last.toLocaleString()} versions; generate + load ${loadMs.toFixed(0)} ms`);
  for (const [name, ms] of rows) console.log(name.padEnd(32), ms.toFixed(2).padStart(10));
}
