# Benchmarks

`npm run bench` runs the same queries on `MemoryStore` and `CsrStore` over a generated social network
(`network(20000)` from `@smaltworks/smaltcy/datasets`: 20,008 nodes and 60,025 relationships), checks that both
stores return the same rows, and reports the median time of 7 runs after one warm-up run.

## Method

- Node 22, one process, both stores in memory.
- Times include parsing and planning each query, as `Graph.run` does.
- `BENCH_PEOPLE` and `BENCH_RUNS` change the size and the number of runs. Results are written to
  `bench/results/<date>.local.json`.

## Results (2026-11-11)

In a cloud container (shared CPU; expect noise of 10–20 %). Milliseconds, median of 7 runs.

| Query | MemoryStore | CsrStore |
| --- | ---: | ---: |
| Seek a person by name | 0.45 | 0.05 |
| 1 hop | 0.31 | 0.23 |
| 2 hops | 1.89 | 1.22 |
| 3 hops (13,076 rows) | 5.88 | 2.85 |
| Variable length 1..3, distinct | 11.30 | 7.72 |
| Shortest path | 0.22 | 0.10 |
| Label scan and filter | 3.04 | 1.43 |

Loading the graph took 229 ms and building the `CsrStore` from it 155 ms.

- `MemoryStore` seeks without an index here: it scans the label. `CsrStore` indexes every property the first time a
  query looks it up.
- `CsrStore` reads relationships from contiguous typed arrays, which shows from two hops on.

## History (2026-11-12)

The same run continues with `network(10000, 42, { history: true })` loaded into a graph that keeps history: 10,001
versions, one per person joining, with a snapshot every 2,000 changes. Milliseconds, median of 7 runs.

| Step | Time |
| --- | ---: |
| Generate and load all 10,001 versions | 439 |
| Open a recent version (about 10,000 nodes) | 64 |
| Open a version mid-way (about 5,000 nodes) | 32 |
| Diff across 1 commit | 0.02 |
| Diff across 100 commits | 0.41 |
| Diff across all of history, forwards | 103 |
| Diff across all of history, backwards | 47 |
| `commits()` | 1.7 |
| `AT VERSION` mid-way, counting people (version already open) | 2.0 |

- **Opening a version** costs about as much as copying a graph of its size, plus replaying at most 2,000 changes.
  Opened versions are kept, so the next query on the same version is quick.
- **Scrubbing a timeline** moves a step or a few at a time. Each step is a diff of microseconds, and the drawing
  applies it without reloading.

## smaltdb (2026-11-19)

`npm run bench:smaltdb` runs the same queries (`bench/queries.ts`) on smaltcy's `MemoryStore` and on smaltdb, through
the compiler to smaltdb plans (`src/smaltdb`, [ADR 0004](../adr/0004-cypher-on-smaltdb.md)), over the same
`network(20000)` loaded into an in-memory smaltdb database (`Database.openMemory()`, smaltdb from the commit
`packed.json` pins). It checks that both give the same rows (in any order) and reports the median of 7 runs after one
warm-up. Times include compiling the Cypher, under 0.2 ms; the rest is smaltdb running the plan. `BENCH_PEOPLE` and
`BENCH_RUNS` size it, `BENCH_BRANCHES` sets the compiler's `maxBranches`; results go to
`bench/results/<date>.smaltdb.local.json`.

Milliseconds, median of 7 runs, in a cloud container (shared CPU; runs differ by 10–20 %). Before is the compiler at
`b620204`, after is this change, both run one after the other; the last column is after, with an index on
`:Person(name)` (`CREATE INDEX FOR (n:Person) ON (n.name)`).

| Query | smaltcy (`MemoryStore`) | smaltdb before | smaltdb after | after, with the index |
| --- | ---: | ---: | ---: | ---: |
| Seek a person by name | 0.32 | 59.0 | 21.0 | 2.3 |
| 1 hop | 0.21 | 128.1 | 56.7 | 38.5 |
| 2 hops | 1.29 | 193.7 | 115.2 | 88.0 |
| 3 hops (13,076 rows) | 4.29 | 314.1 | 154.5 | 152.6 |
| Variable length 1..3, distinct | 16.82 | 245.4 | 176.6 | 135.9 |
| Shortest path | 0.13 | 459.0 | 57.1 | 6.8 |
| Label scan and filter | 2.33 | 58.7 | 29.1 | 29.1 |
| Group by city | 15.30 | 98.5 | 77.3 | 82.1 |
| All relationships | 14.17 | 95.8 | 6.2 | 7.0 |
| Triangles (bounded) | 12.25 | 220.8 | 76.1 | 75.6 |

What changed (ADR 0004, "Patterns"):

- **A MATCH is one join region** of bare scans (node table, label index, edge tables) with its conditions, where it was
  a chain of joins over a row of `values ()`, semi-joins and unions, each `ordered`. smaltdb planned every `ordered`
  join as two numbered inputs, a join and a sort.
- **Order only where it shows** (results, `collect()`, LIMIT, ties): a count or EXISTS asks for none.
- **A property compared with a literal** is smaltdb's own comparison, not a CASE on its kind that read the property
  nine times for a string; smaltdb seeks with an index on it.
- **Anonymous nodes** that only a relationship reaches aren't scanned: all relationships is one scan of an edge table.
- **Paths** are searched from each row in a subquery (`paths` ran the plan before it twice), and one shortest path is a
  breadth-first search that stops at its end (`paths` searched all 20,000 nodes).

What is left is smaltdb's (ADR 0004, "Consequences"): its planner estimates a property comparison at a third of the
table, with or without an index, so it joins the relationships with hashes over whole edge tables rather than seeking
them from the one node found (with the index, the seek finds the person in well under a millisecond, then both
readings of all 40,025 relationships are scanned and hashed); `map_get` decodes the whole map on each call (filtering
20,000 nodes on one property costs about 25 ms); `paths` with `anyShortest` can't be given its end. Splitting a
region per type and reading (`BENCH_BRANCHES=8`) was slower on every query it changes, those with a relationship read
both ways (1 hop 100 against 63 ms, 2 hops 263 against 92 ms, 3 hops 807 against 161 ms, in one session), as each
region repeats the scan that finds the person and the join to it.
