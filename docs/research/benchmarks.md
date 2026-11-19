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
`BENCH_RUNS` size it, `BENCH_BRANCHES` sets the compiler's `maxBranches`, and `BENCH_INDEXES=1` makes the property
indexes smaltcy's store has (the network's, on `:Person(name)`) on smaltdb too; results go to
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
region repeats the scan that finds the person and the join to it. (EXPLAIN ANALYZE later confirmed it, and found that
with the index each region seeks; see below.)

### Hops from a row (2026-11-19)

A relationship read both ways, or of several types, was one FROM item, the union of its edge tables, which smaltdb
can't seek into: each hop scanned and hashed both readings of all 40,025 relationships (80,050 rows), 33 to 45 ms a hop
at 20,000 people, however few rows reached it. Now a hop like that from a bound node is a hop from each row
(ADR 0004, "Patterns"): the region before it runs once, and smaltdb's `iterate`, run for one step, seeks the edge
tables' `start` and `end` indexes (and the far node by id) for each of its rows. smaltdb pinned at `9f19a2f`
(stenhoor/smaltdb#266); before is the compiler at `5e4f27f`, after is this change, run one after the other; "index" is
`BENCH_INDEXES=1`. Milliseconds, median of 7 runs.

At 20,000 people (20,008 nodes, 60,025 relationships):

| Query | smaltcy | before | after | before, index | after, index |
| --- | ---: | ---: | ---: | ---: | ---: |
| Seek a person by name | 0.45 | 28.22 | 27.81 | 0.43 | 0.42 |
| 1 hop | 0.32 | 47.92 | 27.97 | 15.31 | 1.25 |
| 2 hops | 1.44 | 93.91 | 32.43 | 66.67 | 4.88 |
| 3 hops (13,076 rows) | 4.52 | 155.95 | 61.83 | 121.24 | 35.87 |
| Variable length 1..3, distinct | 10.85 | 208.67 | 215.59 | 188.72 | 163.44 |
| Shortest path | 0.20 | 69.09 | 53.95 | 1.75 | 1.62 |
| Label scan and filter | 2.36 | 41.89 | 39.05 | 40.23 | 44.55 |
| Group by city | 14.10 | 100.75 | 94.68 | 105.53 | 94.13 |
| All relationships | 13.84 | 7.60 | 6.85 | 7.63 | 7.04 |
| Triangles (bounded) | 11.82 | 71.83 | 71.93 | 72.21 | 68.89 |

At 2,000 people (2,008 nodes, 5,972 relationships):

| Query | smaltcy | before | after | before, index | after, index |
| --- | ---: | ---: | ---: | ---: | ---: |
| Seek a person by name | 0.47 | 4.51 | 3.88 | 0.74 | 0.42 |
| 1 hop | 0.21 | 6.14 | 4.11 | 4.94 | 0.90 |
| 2 hops | 0.74 | 13.25 | 6.53 | 8.57 | 2.57 |
| 3 hops (2,952 rows) | 1.59 | 17.98 | 12.00 | 15.09 | 9.11 |
| Variable length 1..3, distinct | 2.32 | 38.74 | 39.21 | 46.04 | 35.57 |
| Shortest path | 0.21 | 7.14 | 7.80 | 1.48 | 1.38 |
| Label scan and filter | 1.11 | 4.65 | 4.19 | 6.02 | 4.51 |
| Group by city | 2.11 | 11.24 | 11.01 | 13.56 | 9.32 |
| All relationships | 1.38 | 0.86 | 1.07 | 1.39 | 0.85 |
| Triangles (bounded) | 1.13 | 7.10 | 7.16 | 7.61 | 6.76 |

- **A hop no longer grows with the graph.** With the index, 1 hop is 0.90 ms at 2,000 people and 1.25 ms at 20,000
  (49 and 105 rows; it was 4.94 and 15.31 ms), of which 0.42 ms is the seek of the person. Without the index the hop
  adds as little (1 hop 27.97 ms, the seek alone 27.81 ms); what is left is finding the person, a scan of the node
  table filtering `map_get(props, 'name')`, which smaltcy's store does with its index.
- The queries without a relationship read both ways run the same plans as before (their times differ by the
  container's noise). Variable length and shortest paths are smaltdb's `paths` and the search, unchanged.
- **3 hops** now spends its time on rows: 25,606 relationships reached at the third hop (13,076 after uniqueness, which
  the hop checks before it reads the far node), each sought and its far node read by id.

**Why a region per type and reading was slower.** EXPLAIN ANALYZE of `BENCH_BRANCHES=8` (each region a type and
reading, a union of the regions): without an index on `:Person(name)`, every region begins with its own scan of the
node table filtering on the name (`SCAN graph_node (fused scan + filter)`, what a seek by name costs without the
index: 28 ms at 20,000 people), so 1 hop pays it twice (two such scans in its EXPLAIN ANALYZE) and 3 hops eight times (1 hop 61.7, 2 hops 119.4, 3 hops 271.5 ms, against 47.9, 93.9 and 156.0 ms in one
region). With the index (smaltcy's store has it), every region seeks the person and then the edge tables' indexes, and
the regions were the faster shape (1 hop 1.09, 2 hops 4.11, 3 hops 43.3 ms). They still repeat the hops before each
split (a pattern of k hops read both ways is 2^k regions), and the planner chose a hash join over a whole edge table in
one of the eight 3-hop regions, where its estimate of the `end` index's rows was high. A hop from each row does the
region before it once, needs no index to seek, and grows with the rows rather than with 2^k.

**What a hop from a row costs, and when the compiler doesn't use it.** From a node scanned without a property
condition (`MATCH (p:Person)-[:KNOWS]-(f)`, all 20,000 people), a seek per row was slower than hashing the union (about
200 against 125 ms for `count(f)`, measured before this rule), so such a hop, and any reached from it, is still the union in the region; with a
property map or a WHERE equality on the node, or from a bound node, it is a hop from each row. When neither end is
bound and the order of rows doesn't show, the pattern starts at its node with a property condition
(`MATCH (a)-[:KNOWS]-(b:Person {name: 'Bo 1'})`: 49.0 to 29.9 ms, with the index 16.2 to 1.1 ms). Where the order
shows (results without ORDER BY, `collect()`, LIMIT), it starts where it did, so rows keep their order.

### Paths from a row, and rows that carry less (2026-11-19)

Two queries were far behind: variable length 1..3 (`paths` in a subquery for each row: it ran its input twice, sorted
its paths, and its list of paths was encoded, decoded and exploded) and 3 hops (EXPLAIN ANALYZE: each of 14,581
relationships found was sought in the edge index, then read from the edge table for its other end, then its far node
read by id, though only `count(f)` reads it; CPU profiles: B-tree descents first, then copying rows of 25 columns
through the `iterate` and its projections). Now (ADR 0004, "Patterns"):

- **Variable length where the order doesn't show** (a count, EXISTS) is a search from each row, an `iterate` that seeks
  the edge index at the path's last node, as a hop from a row does, with the trail's relationships in a column each
  (a list only past 8 hops or unbounded) and its hops built only where read.
- **A node read only by `count()` or `id()`**, with no labels or properties, is a relationship's end: its node isn't
  read (3 hops: 13,076 seeks fewer).
- **A hop from a row carries less:** the columns that are the same literal on every row (ends and properties nothing
  reads, a relationship's one type) stay out of the `iterate` and are put back after it (25 columns to 8 at the third
  hop), and a relationship whose properties nothing reads is read without them.
- **smaltdb's edge indexes** on `(start, end)` and `(end, start)` (the claude/perf-paths branch of smaltdb, as
  smaltdb's ADR 0033 describes them; `addType` made them on `start` and on `end`) let a hop read the index alone.

Milliseconds, median of 15 runs, `BENCH_INDEXES=1`, run one after the other. Before is the compiler at `ceb417d`;
"main" is smaltdb `d180f45` (`packed.json`), "covering" the smaltdb branch with the covering indexes.

At 20,000 people:

| Query | smaltcy | before, main | after, main | before, covering | after, covering |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 hop | 0.21 | 1.26 | 0.79 | 0.98 | 0.73 |
| 2 hops | 0.91 | 4.90 | 3.15 | 3.44 | 2.14 |
| 3 hops (13,076 rows) | 4.55 | 37.46 | 20.85 | 28.88 | 13.40 |
| Variable length 1..3, distinct | 12.05 | 165.70 | 21.48 | 135.74 | 13.38 |
| Triangles (bounded) | 11.56 | 41.48 | 39.00 | 30.69 | 29.33 |

At 2,000 people:

| Query | smaltcy | before, main | after, main | before, covering | after, covering |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 hop | 0.16 | 0.72 | 0.56 | 0.72 | 0.54 |
| 2 hops | 0.52 | 2.47 | 1.78 | 2.15 | 1.99 |
| 3 hops (2,952 rows) | 0.93 | 8.57 | 4.85 | 11.01 | 3.81 |
| Variable length 1..3, distinct | 2.28 | 31.18 | 4.93 | 29.90 | 3.76 |
| Triangles (bounded) | 0.99 | 4.24 | 4.43 | 3.25 | 3.28 |

The other queries run the same plans (their times differ by the container's noise, 10–30 % between runs here). With
both changes, 3 hops is 2.9 times smaltcy's time and variable length about the same as smaltcy's, and both grow with
the rows found, not the graph: 3.81 to 13.40 ms for 2,952 to 13,076 rows. What is left in 3 hops (profile) is the
`iterate`'s per-row work: a row array and a queue entry for each hop found, the projections' register copies, and the
index seeks.
