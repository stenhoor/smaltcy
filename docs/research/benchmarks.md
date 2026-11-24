# Benchmarks

`npm run bench` runs the same queries on `MemoryStore` and `CsrStore` over a generated social network
(`network(20000)` from `@smaltworks/smaltcy/datasets`: 20,008 nodes and 60,025 relationships), checks that both
stores return the same rows, and times them as "Method" says.

## Method

- Node 22, one process, both stores in memory.
- Times include parsing and planning each query, as `Graph.run` does.
- `BENCH_PEOPLE` changes the size and `BENCH_ROUNDS` the number of rounds (below). Results are written to
  `bench/results/<date>.local.json`.

### How a time is taken (since 2026-11-20)

The results dated before 2026-11-20 are medians of 7 runs after one warm-up run, one engine timed after the other.
Measured on 2026-11-20 (a cloud container, Node 22.23.4), such a median depends on when it is taken:

- **The machine isn't quiet.** One query (the shortest path over 5 hops, on `MemoryStore`) run 150 times in a row
  took 30 to 100 ms a run, 46 at the median: 30 to 40 ms for about a second, 40 to 65 ms in the seconds before and
  after it. The process was running throughout (14 of the 2,826 ticks `/proc/stat` counted over the loop were steal).
  Three runs of `npm run bench` gave 14.9, 30.6 and 19.8 ms for variable length on `MemoryStore`.
- **A short query's first runs are slow.** Seek by name on `MemoryStore`: a median of 0.39 ms over the 7 runs after
  the first, 0.04 ms over runs 101 to 300.

So the engines take turns (`bench/timing.ts`). Each runs the query for a round (until 100 ms have passed: 3 runs at
least, 200 at most), then the other does, 15 times over (`BENCH_ROUNDS`). An engine's **time** is the lowest of its
rounds' medians: the machine at its quietest. The **ratio** is the median of the rounds' ratios, each of two rounds
run back to back, which a slow second slows alike. Where the two disagree, the ratio is the one to read, and the bar
for switching (ADR 0004) is read from it: 1.00 or less. Three runs of `BENCH_INDEXES=1 npm run bench:smaltdb` gave
ratios within 5 % of each other on 8 of the 13 queries, and within 15 % on all but group by city (2.53 to 3.15): a
ratio that near 1.00 is taken again with more rounds before a case is called.

`bench/vary.ts` (below) times statements that can each run once. There the engines take turns in blocks of 10
statements, each block the same values on both; an engine's time is the median of its statements, and the ratio the
median of the blocks' ratios.

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
`BENCH_RUNS` sized it then (`BENCH_ROUNDS` now, see "Method"), `BENCH_BRANCHES` sets the compiler's `maxBranches`,
and `BENCH_INDEXES=1` makes the property indexes smaltcy's store has (the network's, on `:Person(name)`) on smaltdb
too; results go to `bench/results/<date>.smaltdb.local.json`.

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

## Statements that differ, and the baseline for the bar (2026-11-20)

The benchmarks above run one text again and again. smaltdb keeps a statement by its plan's text, so from the second
run on it plans nothing; an application's statements differ from each other, and those weren't measured.
`BENCH_ENTRY=bench/vary.ts npm run bench:smaltdb` runs every query and write of the other two benchmarks that has a
value to differ in (group by city and all relationships have none, and the triangles' `community` has 6 values), each
statement with a value none of the others of its case has, twice over: the value **as a literal** in the text, and
**as a parameter**. Both engines must give the same rows and counts on every timed statement.

These tables are the baseline for the bar (ADR 0004, "The bar for switching") before the work in
stenhoor/smaltdb#274: smaltcy `main` at `a3a839c`, smaltdb at `37b4875`, the index on `:Person(name)` on both
engines, timed as "Method" says, in a cloud container (Node 22.23.4). Milliseconds; a ratio is smaltdb's time over
smaltcy's.

**Statements that differ** (`BENCH_ENTRY=bench/vary.ts npm run bench:smaltdb`; the first three columns with the value
as a literal, the last three as a parameter):

| Statement | smaltcy, literal | smaltdb, literal | ratio | smaltcy, parameter | smaltdb, parameter | ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Seek a person by name | 0.055 | 0.738 | 14.1x | 0.062 | 52.5 | 913x |
| 1 hop | 0.110 | 1.18 | 9.81x | 0.107 | 69.1 | 827x |
| 2 hops | 0.279 | 1.71 | 6.29x | 0.187 | 53.6 | 290x |
| 3 hops | 1.30 | 4.23 | 3.42x | 0.916 | 57.6 | 56.2x |
| Variable length 1..3, distinct | 2.73 | 4.21 | 1.31x | 2.06 | 60.8 | 29.7x |
| Shortest path | 5.02 | 5.68 | 1.34x | 9.05 | 124.0 | 11.9x |
| Shortest path, directed | 0.075 | 1.95 | 25.2x | 0.120 | 134.0 | 1,483x |
| Shortest path, none | 44.7 | 125.0 | 2.85x | 38.7 | 176.0 | 4.72x |
| Label scan and filter | 5.03 | 23.3 | 4.68x | 5.05 | 33.1 | 7.43x |
| Create 1 node | 0.021 | 0.936 | 46.6x | 0.018 | 0.958 | 53.4x |
| Create 1,000 nodes | 1.02 | 14.9 | 16.1x | 0.969 | 13.9 | 15.1x |
| Create 1 relationship | 0.044 | 3.39 | 85.8x | 0.034 | 63.8 | 1,719x |
| Create 1,000 relationships | 2.98 | 27.1 | 9.46x | 2.31 | 24.1 | 10.9x |
| Set 1 property by name | 0.036 | 1.11 | 31.0x | 0.029 | 56.7 | 2,136x |
| Set 1,000 properties | 0.777 | 11.8 | 15.2x | 0.766 | 12.4 | 16.2x |
| Merge existing node | 0.019 | 0.529 | 28.3x | 0.019 | 60.6 | 3,175x |
| Merge 1,000 new nodes | 20.3 | 22.1 | 1.01x | 19.3 | 17.7 | 0.94x |
| Delete 1 node | 0.045 | 2.84 | 71.3x | 0.041 | 3.99 | 101x |
| Delete 1,000 nodes | 0.865 | 25.3 | 28.0x | 0.856 | 29.1 | 33.4x |

**The same text every run: queries** (`BENCH_INDEXES=1 npm run bench:smaltdb`), with smaltcy's `CsrStore` beside them
(`npm run bench`, a run of its own: its `MemoryStore` times were within 18 % of the ones here, the seek apart, at
0.016 ms):

| Query | smaltcy (`MemoryStore`) | smaltdb | ratio | `CsrStore` | its ratio to `MemoryStore` |
| --- | ---: | ---: | ---: | ---: | ---: |
| Seek a person by name | 0.021 | 0.064 | 2.52x | 0.014 | 0.90x |
| 1 hop | 0.032 | 0.112 | 3.33x | 0.028 | 0.88x |
| 2 hops | 0.355 | 1.13 | 3.22x | 0.225 | 0.61x |
| 3 hops | 4.32 | 13.1 | 2.89x | 2.69 | 0.61x |
| Variable length 1..3, distinct | 11.9 | 13.6 | 1.09x | 10.8 | 0.79x |
| Shortest path | 0.047 | 0.143 | 3.14x | 0.035 | 0.84x |
| Shortest path, 5 hops | 33.0 | 47.4 | 1.50x | 12.8 | 0.46x |
| Shortest path, none (directed) | 0.031 | 0.142 | 4.92x | 0.026 | 0.86x |
| Shortest path, none (either way) | 32.8 | 91.9 | 2.54x | 16.6 | 0.51x |
| Label scan and filter | 2.29 | 4.95 | 2.17x | 0.981 | 0.38x |
| Group by city | 21.7 | 64.0 | 2.53x | 7.43 | 0.37x |
| All relationships | 15.6 | 8.26 | 0.50x | 10.3 | 0.59x |
| Triangles (bounded) | 13.7 | 33.4 | 2.34x | 4.09 | 0.35x |

**The same text every run: writes** (`BENCH_ENTRY=bench/writes.ts npm run bench:smaltdb`):

| Write | smaltcy | smaltdb | ratio |
| --- | ---: | ---: | ---: |
| Create 1 node | 0.007 | 0.531 | 50.6x |
| Create 1,000 nodes | 0.881 | 10.6 | 12.3x |
| Create 1 relationship | 0.016 | 2.12 | 115x |
| Create 1,000 relationships | 1.53 | 19.5 | 13.4x |
| Set 1 property by name | 0.012 | 0.080 | 8.34x |
| Set 1,000 properties | 0.720 | 11.1 | 14.8x |
| Merge existing node | 0.011 | 0.057 | 5.40x |
| Merge 1,000 new nodes | 16.4 | 13.9 | 0.84x |
| Delete 1,000 nodes | 0.562 | 19.7 | 32.9x |

What the baseline says:

- **With a parameter, smaltdb scans.** The seek takes 52.5 ms with the name as a parameter, 0.74 ms with it as a
  literal, and 0.06 ms on smaltcy either way; every statement that finds a person by a name given as a parameter
  takes 52 ms or more. EXPLAIN of the seek on smaltdb: with a literal, `SEARCH graph_node USING INDEX` (the property
  index) and `SEARCH graph_labels USING COVERING INDEX`; with a parameter, a `HASH JOIN` of `SCAN graph_labels` and
  `SCAN graph_node`.
- **With a literal, every statement is planned anew.** A seek that takes 0.064 ms when its text repeats takes 0.74 ms
  with a name smaltdb hasn't seen (smaltcy: 0.021 and 0.055 ms).
- **Where a short query's time goes when its text repeats** (seek by name, in a run of its own, timed in the same
  rounds): smaltcy's whole run 0.022 ms; smaltdb's whole path 0.048 ms, of which the prepared statement's run is
  0.005 ms, parsing the Cypher 0.006 ms, compiling it to a smaltdb plan 0.021 ms, and the plan's JSON text, the key
  the statement is found by, 0.007 ms. For the shortest path (0.046 ms on smaltcy) the prepared statement runs in
  0.012 ms and the whole path takes 0.134 ms.
- **Writes** are 12 to 33 times behind for 1,000 rows and 5 to 115 times for one, merging 1,000 new nodes apart
  (0.84).
- **Queries whose text repeats** are 1.5 to 4.9 times behind, variable length (1.09) and all relationships (0.50)
  apart. `CsrStore` takes 0.35 to 0.61 of `MemoryStore`'s time on the scans, the aggregate, the triangles and the
  traversals of 2 hops and more (variable length: 0.79), and 0.84 to 0.90 on the short queries.

Up to 200 statements of a case are timed in each mode, fewer where they take long: 20 to 140 of them where smaltdb's
take 17 ms and more. A second run of the statements that differ gave ratios within 18 % of these with a literal and
within 29 % with a parameter.

## Statements kept by shape (2026-11-20)

Step 1 of the work in stenhoor/smaltdb#274 (ADR 0004, "Statements kept by shape"). Four changes, each measured on its
own before it was kept:

- **A parameter is compared as a literal of its kind is.** A property compared with a string or number parameter was
  the general comparison, which smaltdb can't seek with: the seek by a name given as a parameter was a hash join of two
  full scans. Alone, this took it from 52.5 to 0.12 ms.
- **A query is kept by its shape** (`src/smaltdb/shape.ts`): compiled with its strings and numbers taken out, and the
  statement smaltdb prepared for it run with each query's values.
- **smaltdb checks a map key against a parameter on the stored bytes**, as it did against a literal (smaltdb
  `1c2fce8`, stenhoor/smaltdb#275; `packed.json` pins it). Without it a kept statement filtered a scan slower than one
  with its value written in: the label scan and filter went from 4.95 to 13.3 ms when its `70` became a parameter. A
  scan of the 20,008 nodes on a property, prepared, parameter against literal: `age > 70` 13.56 against 4.85 ms before,
  4.88 against 4.86 after; `name = 'Bo 1'` with no index 9.37 against 1.77 before, 1.91 against 1.83 after.
- **A write's values are parameters of the statements it runs** (`valuesOut`).

smaltcy at this change, smaltdb at `1c2fce8`, the same machine and method as the baseline above. "Before" is the
baseline's ratio. Milliseconds; a ratio is smaltdb's time over smaltcy's.

**Statements that differ** (`BENCH_ENTRY=bench/vary.ts npm run bench:smaltdb`):

| Statement | literal: before | smaltcy | smaltdb | ratio | parameter: before | smaltcy | smaltdb | ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Seek a person by name | 14.1x | 0.057 | 0.061 | 1.15x | 913x | 0.051 | 0.053 | 1.04x |
| 1 hop | 9.81x | 0.104 | 0.101 | 0.91x | 827x | 0.072 | 0.064 | 0.84x |
| 2 hops | 6.29x | 0.282 | 0.342 | 1.22x | 290x | 0.293 | 0.352 | 1.29x |
| 3 hops | 3.42x | 1.25 | 2.54 | 2.02x | 56.2x | 0.823 | 1.65 | 2.00x |
| Variable length 1..3, distinct | 1.31x | 2.44 | 2.22 | 0.96x | 29.7x | 1.41 | 1.31 | 0.97x |
| Shortest path | 1.34x | 4.71 | 2.94 | 0.62x | 11.9x | 7.21 | 7.14 | 0.96x |
| Shortest path, directed | 25.2x | 0.116 | 0.166 | 1.50x | 1,483x | 0.095 | 0.138 | 1.63x |
| Shortest path, none | 2.85x | 42.0 | 107.4 | 2.29x | 4.72x | 35.8 | 99.1 | 2.81x |
| Label scan and filter | 4.68x | 4.45 | 18.9 | 4.33x | 7.43x | 4.27 | 10.9 | 2.58x |
| Create 1 node | 46.6x | 0.022 | 0.792 | 38.4x | 53.4x | 0.018 | 0.790 | 45.0x |
| Create 1,000 nodes | 16.1x | 0.997 | 14.8 | 15.3x | 15.1x | 0.926 | 13.9 | 14.8x |
| Create 1 relationship | 85.8x | 0.053 | 2.88 | 69.3x | 1,719x | 0.049 | 2.67 | 61.2x |
| Create 1,000 relationships | 9.46x | 2.12 | 23.1 | 10.6x | 10.9x | 2.73 | 22.7 | 8.90x |
| Set 1 property by name | 31.0x | 0.050 | 1.04 | 21.9x | 2,136x | 0.025 | 0.681 | 26.8x |
| Set 1,000 properties | 15.2x | 0.737 | 12.5 | 17.5x | 16.2x | 0.720 | 12.5 | 17.1x |
| Merge existing node | 28.3x | 0.018 | 0.111 | 6.62x | 3,175x | 0.016 | 0.098 | 6.15x |
| Merge 1,000 new nodes | 1.01x | 18.3 | 18.0 | 0.97x | 0.94x | 18.4 | 17.2 | 0.99x |
| Delete 1 node | 71.3x | 0.032 | 3.77 | 116x | 101x | 0.033 | 3.73 | 115x |
| Delete 1,000 nodes | 28.0x | 0.771 | 22.0 | 29.0x | 33.4x | 0.813 | 22.6 | 26.9x |

**The same text every run: queries** (`BENCH_INDEXES=1 npm run bench:smaltdb`, which now runs a query as an
application does, through `runOnSmaltdb`):

| Query | before | smaltcy | smaltdb | ratio |
| --- | ---: | ---: | ---: | ---: |
| Seek a person by name | 2.52x | 0.021 | 0.025 | 1.04x |
| 1 hop | 3.33x | 0.049 | 0.071 | 1.89x |
| 2 hops | 3.22x | 0.373 | 0.964 | 2.58x |
| 3 hops | 2.89x | 4.53 | 13.1 | 2.94x |
| Variable length 1..3, distinct | 1.09x | 13.5 | 14.3 | 1.05x |
| Shortest path | 3.14x | 0.056 | 0.056 | 0.95x |
| Shortest path, 5 hops | 1.50x | 34.0 | 48.3 | 1.36x |
| Shortest path, none (directed) | 4.92x | 0.032 | 0.060 | 1.91x |
| Shortest path, none (either way) | 2.54x | 37.6 | 91.8 | 2.53x |
| Label scan and filter | 2.17x | 2.10 | 4.98 | 2.31x |
| Group by city | 2.53x | 27.9 | 76.8 | 2.62x |
| All relationships | 0.50x | 18.1 | 7.86 | 0.41x |
| Triangles (bounded) | 2.34x | 15.0 | 32.6 | 2.24x |

**The same text every run: writes** (`BENCH_ENTRY=bench/writes.ts npm run bench:smaltdb`):

| Write | before | smaltcy | smaltdb | ratio |
| --- | ---: | ---: | ---: | ---: |
| Create 1 node | 50.6x | 0.009 | 0.536 | 47.2x |
| Create 1,000 nodes | 12.3x | 0.880 | 11.7 | 12.7x |
| Create 1 relationship | 115x | 0.015 | 2.19 | 105x |
| Create 1,000 relationships | 13.4x | 1.70 | 20.9 | 12.2x |
| Set 1 property by name | 8.34x | 0.012 | 0.087 | 8.33x |
| Set 1,000 properties | 14.8x | 0.664 | 11.7 | 18.2x |
| Merge existing node | 5.40x | 0.011 | 0.068 | 5.71x |
| Merge 1,000 new nodes | 0.84x | 16.3 | 14.1 | 0.84x |
| Delete 1,000 nodes | 32.9x | 0.546 | 18.8 | 33.9x |

What it says:

- **The gate** (seek by name and 1 hop within 1.5 times smaltcy's time, with a literal and with a parameter): 1.15
  and 1.04 for the seek, 0.91 and 0.84 for 1 hop.
- **Reads that start at a node found by a value** are near smaltcy's time when their values differ: 2 hops 1.22 and
  1.29, variable length 0.96 and 0.97, the shortest path 0.62 and 0.96, directed 1.50 and 1.63. What is left is
  smaltdb's work on each row (3 hops 2.02 and 2.00, a shortest path that isn't there 2.29 and 2.81): steps 2 and 3.
- **When the text repeats**, the short queries no longer compile their Cypher to a plan and find their statement by
  the plan's text on every run: the seek 2.52 to 1.04, the shortest path 3.14 to 0.95, 1 hop 3.33 to 1.89, no path
  (directed) 4.92 to 1.91, 2 hops 3.22 to 2.58. The other queries are unchanged: over three runs of this change
  their ratios fall on both sides of the baseline's (3 hops 2.73, 3.06 and 2.94 against 2.89; the label scan 2.15,
  2.07 and 2.31 against 2.17).
- **A write that finds its rows by a parameter** lost its 55 ms scan: create 1 relationship 63.8 to 2.67 ms, set 1
  property 56.7 to 0.68, merge existing 60.6 to 0.10.
- **A write whose values differ** plans fewer statements: merge existing 28.3 to 6.62 times smaltcy's time (0.529
  to 0.111 ms), set 1 property 31.0 to 21.9, create 1 relationship 85.8 to 69.3, create 1 node 46.6 to 38.4.
- **Slower: delete 1 node with its value written in the text**, 2.84 to 3.77 ms. Its match is now a statement
  smaltdb keeps, with the plan it made when `:Bench` had 441 nodes: a scan of the node table. Planned anew for every
  statement, as it was, the match moved to the label's index as the label shrank. With a parameter it was a kept
  statement before (3.99 ms; 3.73 now). The two plans timed on their own (prepared, in turns): the label's index
  takes 0.13 ms at 201 nodes of the label and 0.26 ms at 401; the scan takes 1.39 ms whatever the label holds, and
  smaltdb's planner takes it from about 500 nodes on, where the index would still be the faster up to about 2,100
  (an estimate, from 0.66 µs a node).
- **Slower by about 0.01 ms: a single write whose text repeats** (merge existing 0.057 to 0.068 ms, set 1 property
  0.080 to 0.087). Its values are taken out again on every call (2.5 to 5.5 µs, timed on its own), which gains
  nothing when the text is the same.
- **Slower: set 1,000 properties with the value written in the text**, 11.8 to 12.5 ms, now what it takes with a
  parameter (12.4 before, 12.5 now). smaltdb's expression compiler builds a map of literals once and a map that holds
  a parameter for each row (`fold`, read in its source). That this is the 0.7 ms is an assumption: timing the update
  alone would confirm it.
- **Where a single write's time goes now** (the smaltdb statements one Cypher statement becomes, 200 statements with
  other values each, timed by a scratch script; ms for one Cypher statement):
  - create 1 node, 0.82: the largest node id, a scan of the node table, 0.37; the two appends, planned anew, 0.19.
  - create 1 relationship, 2.88: the largest ids, scans of the node table and the three edge tables, 1.63; three
    appends and a read of the node, planned anew, 0.61.
  - set 1 property, 1.54: the update, planned anew, 0.71; a read of the node, planned anew, 0.31; the match 0.09.
  - delete 1 node, 5.37 with the script's bookkeeping: the match 1.97; four reads of the edge tables, planned anew,
    2.46; the delete, planned anew, 0.31.
  - merge existing, 0.33: the match 0.06; nothing planned anew.

  The scans for ids and the statements that hold the runner's rows are the write path's own, and step 4.

## More hop cases, and their baseline (2026-11-20)

The hops above all go either way, to a node of any label, and read nothing of the relationship. smaltdb's ADR 0040
(stenhoor/smaltdb#274, step 2b) measured that a hop with a direction is compiled differently and fetches each
relationship's row, so the queries now have hops as they are more often written: with a direction (`1 hop, directed`,
`3 hops, directed`), to a label (`2 hops to a label`) and with a condition on the relationship (`2 hops, relationship
filter`), the last three among the statements that differ too. They count for the bar as the others do.

Their baseline, smaltcy `51f6b80` and smaltdb `1c2fce8`, the same machine and method. A ratio is smaltdb's time over
smaltcy's.

| Query | smaltcy (ms) | smaltdb (ms) | The same text | A literal, a parameter |
|---|---|---|---|---|
| 1 hop, directed | 0.028 | 0.068 | 2.59x | |
| 3 hops, directed | 2.232 | 7.636 | 3.62x | 1.82x, 1.52x |
| 2 hops to a label | 0.734 | 3.839 | 5.17x | 2.50x, 2.36x |
| 2 hops, relationship filter | 0.583 | 2.478 | 4.18x | 1.76x, 1.74x |

In the same run the hops that go either way were at 1.50x (1 hop), 2.62x (2 hops) and 3.20x (3 hops): the new cases
are further from the bar than the ones the benchmark had.

## smaltdb's graph index, and shortest paths to a target (2026-11-20)

Step 2 of the work in stenhoor/smaltdb#274 (smaltdb's ADR 0040), in two parts, each measured before it was kept:

- **2a, in smaltdb (`8904484`):** a property graph's relationships are kept in memory by node, and a plan that reads an
  edge table by its start or end reads them there instead of descending the endpoint index. Nothing changed here.
- **2c, in smaltdb (`95189f6`) and here:** smaltdb's `paths` takes a `target` and, over a property graph, is a
  breadth-first search the engine runs itself. `shortestPath` here is now that, where it was an `iterate` of its own.

The same machine and method as above; "step 1" is the section "Statements kept by shape". The smaltdb commits named are
those measured; both changes were since rebased onto smaltdb's `main` (`ffdeacd`), unchanged. A ratio is smaltdb's time over smaltcy's.

**The same text every run** (`BENCH_INDEXES=1 npm run bench:smaltdb`):

| Query | Step 1 | With 2a | With 2c | smaltcy, smaltdb with 2c (ms) |
|---|---|---|---|---|
| seek by name | 1.04x | 1.07x | 1.04x | 0.017, 0.018 |
| 1 hop | 1.89x | 1.28x | 1.32x | 0.032, 0.044 |
| 2 hops | 2.58x | 1.51x | 1.58x | 0.313, 0.531 |
| 3 hops | 2.94x | 1.68x | 1.59x | 3.889, 6.388 |
| var-length 1..3, distinct | 1.05x | 0.58x | 0.63x | 10.990, 7.206 |
| shortest path | 0.95x | 0.89x | 0.88x | 0.042, 0.038 |
| shortest path, 5 hops | 1.36x | 0.86x | 0.16x | 28.892, 5.062 |
| shortest path, none (out) | 1.91x | 1.55x | 1.20x | 0.029, 0.033 |
| shortest path, none (all) | 2.53x | 1.25x | 0.25x | 30.554, 7.439 |
| label scan + filter | 2.31x | 2.39x | 2.07x | 2.130, 4.473 |
| group by city | 2.62x | 3.12x | 3.18x | 16.947, 58.388 |
| all relationships | 0.41x | 0.46x | 0.49x | 13.117, 6.663 |
| triangles (bounded) | 2.24x | 2.04x | 2.09x | 11.054, 25.822 |

**Statements that differ** (`BENCH_ENTRY=bench/vary.ts npm run bench:smaltdb`; a literal, a parameter; with 2c only
the path cases were run again):

| Statement | Step 1 | With 2a | With 2c |
|---|---|---|---|
| seek by name | 1.15x, 1.04x | 1.19x, 1.10x | |
| 1 hop | 0.91x, 0.84x | 0.81x, 0.93x | |
| 2 hops | 1.22x, 1.29x | 0.91x, 0.82x | |
| 3 hops | 2.02x, 2.00x | 1.15x, 1.41x | |
| var-length 1..3, distinct | 0.96x, 0.97x | 0.61x, 0.62x | 0.65x, 0.68x |
| shortest path | 0.62x, 0.96x | 0.49x, 0.67x | 0.13x, 0.18x |
| shortest path, directed | 1.50x, 1.63x | 1.13x, 1.22x | 1.03x, 0.90x |
| shortest path, none | 2.29x, 2.81x | 1.28x, 1.24x | 0.28x, 0.29x |

**Writes: the index kept against no index** (two smaltdb databases taking turns, one opened with `graphIndexMem: 0`;
the index built before the first write and still the first build after the last; ms):

| Write | No index | The index kept | Ratio |
|---|---|---|---|
| create 1 node | 0.560 | 0.550 | 1.00x |
| create 1,000 nodes | 10.574 | 10.474 | 1.04x |
| create 1 relationship | 1.615 | 1.584 | 1.00x |
| create 1,000 relationships | 18.315 | 17.554 | 0.98x |
| set 1 property by name | 0.074 | 0.073 | 1.01x |
| set 1,000 properties | 8.879 | 8.815 | 1.02x |
| merge existing node | 0.060 | 0.060 | 1.00x |
| delete 1 node | 0.142 | 0.142 | 0.99x |
| delete 1,000 nodes | 16.736 | 14.165 | 0.84x |
| delete 1,000 relationships and their nodes | 19.729 | 17.154 | 0.85x |

What it says:

- **Paths are under smaltcy's times** but for two statements of under 0.15 ms (shortest path, none (out) 1.20x; a
  directed shortest path with a literal 1.03x). A search that finds nothing in the people's component went from 2.53
  to 0.25 times smaltcy's time.
- **Hops got 1.4 to 1.9 times faster and are still over** (1.3x to 1.6x with the same text). What is left is the
  `iterate` this compiler puts around a hop that may go either way, and the row a directed hop fetches: smaltdb's ADR
  0040 measures both and proposes a `relationships` operation for them (its step 2b).
- **No write is slower with the index**, and deletes are faster: the check that a node has no relationships reads the
  index.
- **Group by city did not change**: its plan reads no graph index, and prepared it takes 65.9 ms with the index and
  67.0 without. Its ratio moves between runs with smaltcy's own time (17 to 28 ms in these runs).
- **Where a statement of a few hundredths of a millisecond spends its time** (µs, in turns): the directed search
  with no path, smaltcy 30.8, smaltdb 32.0: 13.2 to turn the Cypher into its plan, which both engines do, and 20.2 to
  find the kept statement by its shape and run it, of which the prepared statement is 9.4. The seek by name, smaltcy
  11.4, smaltdb 15.7: 5.4 and 10.0, of which the prepared statement is 3.2. 1 hop, smaltcy 28.9, smaltdb 41.6: 7.4 and
  33.4, of which the prepared statement is 24.6. So for the smallest statements, finding the statement by its shape
  costs more than running it.
- **Building the index** takes smaltdb 13.9 ms for the network's 60,025 relationships (191.5 ms for 599,834, a network
  of 200,000 people), on the first statement that reads the graph. It takes 39 to 55 bytes per relationship.

## Hops as relationships (2026-11-20)

Step 2b of stenhoor/smaltdb#274 (smaltdb's ADR 0040, section 2.2). smaltdb has a `relationships` operation: a graph's
relationships as a relation that is read from either end. A hop here is now one of them, a FROM item of the pattern's
join region, where it was a union of edge tables, an `iterate` of one step from each row, or a scan that fetched every
relationship's row. Two more changes came with it: a far node of which only labels are asked is no longer read from
the node table, and the properties of a relationship nothing reads are not asked for.

The same machine and method. smaltdb at `8cc47b3` (steps 2a, 2c and 2b on its `main`), and with stenhoor/smaltdb#278
on top, which is the engine's own: a nested plan's projection leaves out the outputs nothing reads. "Before" is the
section above (with 2c), and for the four cases added since, the run with 2a in "More hop cases". A ratio is smaltdb's
time over smaltcy's.

**The same text every run** (`BENCH_INDEXES=1 npm run bench:smaltdb`):

| Query | Before | With 2b | With 2b and #278 | smaltcy, smaltdb with both (ms) |
|---|---|---|---|---|
| seek by name | 1.04x | 1.04x | 1.07x | 0.017, 0.019 |
| 1 hop | 1.32x | 0.96x | 0.79x | 0.031, 0.026 |
| 2 hops | 1.58x | 0.85x | 0.35x | 0.333, 0.120 |
| 3 hops | 1.59x | 0.85x | 0.30x | 4.140, 1.231 |
| 1 hop, directed | 2.39x | 1.03x | 0.86x | 0.028, 0.024 |
| 3 hops, directed | 2.55x | 0.66x | 0.26x | 2.223, 0.576 |
| 2 hops to a label | 4.44x | 2.26x | 2.09x | 0.717, 1.481 |
| 2 hops, relationship filter | 3.44x | 2.86x | 2.57x | 0.548, 1.406 |
| var-length 1..3, distinct | 0.63x | 0.64x | 0.69x | 10.667, 6.973 |
| shortest path | 0.88x | 0.85x | 0.89x | 0.035, 0.034 |
| shortest path, 5 hops | 0.16x | 0.16x | 0.17x | 27.250, 4.857 |
| shortest path, none (out) | 1.20x | 1.20x | 1.25x | 0.025, 0.032 |
| shortest path, none (all) | 0.25x | 0.24x | 0.23x | 30.293, 7.351 |
| label scan + filter | 2.07x | 2.18x | 2.27x | 2.030, 4.561 |
| group by city | 3.18x | 2.69x | 3.22x | 15.296, 50.800 |
| all relationships | 0.49x | 0.28x | 0.18x | 13.293, 2.559 |
| triangles (bounded) | 2.09x | 0.90x | 0.88x | 11.304, 9.922 |

**Statements that differ** (`BENCH_ENTRY=bench/vary.ts npm run bench:smaltdb`; a literal, a parameter). "Before" is
with 2a for the first three, and the baseline of "More hop cases" (before 2a) for the last three:

| Statement | Before | With 2b | With 2b and #278 |
|---|---|---|---|
| 1 hop | 0.81x, 0.93x | 0.68x, 0.80x | 0.70x, 0.80x |
| 2 hops | 0.91x, 0.82x | 0.68x, 0.67x | 0.46x, 0.50x |
| 3 hops | 1.15x, 1.41x | 0.74x, 0.76x | 0.33x, 0.37x |
| 3 hops, directed | 1.82x, 1.52x | 0.58x, 0.64x | 0.48x, 0.51x |
| 2 hops to a label | 2.50x, 2.36x | 1.30x, 1.12x | 1.10x, 1.17x |
| 2 hops, relationship filter | 1.76x, 1.74x | 1.38x, 1.36x | 1.49x, 1.51x |

What it says:

- **Hops and triangles are under smaltcy's times,** in the three ways they are measured. With 2b alone the two
  smallest, 1 hop and 1 hop directed with the same text, are at the bar (0.96x and 1.03x: a microsecond either way
  on 30); with #278 they are under it (0.79x and 0.86x).
- **Most of a hop's time was the pattern's row.** The compiler projects every column of a pattern (each node's id
  and properties, each relationship's five columns) and a query such as `count(f)` reads one. Prepared, 3 hops take
  3.44 ms with 2b and 1.06 ms once smaltdb leaves the unread outputs out; 2 hops 0.263 and 0.085 ms.
- **Two of the added cases are still over,** and for reasons the hop itself doesn't have:
  - **A hop to a labelled node** (2.09x; 1.10x and 1.17x): each far node's label is one probe of the label index's
    B+tree, about a microsecond, where smaltcy's store asks a set. Prepared, the query takes 1.84 ms with the label
    and 0.26 ms without it, for 1,505 far nodes. smaltdb's ADR 0040 provides for this: the graph index also holds
    each node's labels.
  - **A hop filtered on a relationship's property** (2.57x; 1.49x and 1.51x): each of the 1,610 relationships at the
    second hop has its row fetched for `since`, a B+tree seek and a read of its map. Prepared, 1.69 ms. That is the
    subject of the issue's step 5 (properties kept in memory).
- **All relationships got faster** (6.66 ms with 2c, 4.42 with 2b, 2.56 with #278): its scan no longer reads the
  properties column, and its unread columns are no longer computed.
- **Group by city, the label scan and the seek by name did not change** beyond what smaltcy's own time moves their
  ratios between runs: smaltdb's group by city took 58.4, 53.7 and 50.8 ms in the three runs, smaltcy's 16.9, 18.4
  and 15.3.
- **A pattern bound at its far end** is read from that end: `MATCH (f)-[:KNOWS]->(p:Person {name: 'Bo 1'}) RETURN
  f.name` finds `p` by name, then its relationships by their `other` column (`SEARCH RELATIONSHIPS OF graph
  (other=?)` in smaltdb's EXPLAIN), then each `f` by id.

## Labels in smaltdb's graph index (2026-11-20)

smaltdb's `main` at `57f0e94`, which this repository now pins. Since the section above it has two more changes, both
the engine's, and nothing changed here but the pin:

- **stenhoor/smaltdb#282:** the graph index also holds each node's labels, and a plan that asks whether one node has
  one label is answered from it, where it probed the label index's B+tree. This is ADR 0040's provision for the hop
  to a labelled node.
- **stenhoor/smaltdb#278,** measured above on its branch and now merged.

The same machine and method. "Before" is the section above with both of its changes (smaltdb `8cc47b3` and #278). A
ratio is smaltdb's time over smaltcy's.

**The same text every run** (`BENCH_INDEXES=1 npm run bench:smaltdb`):

| Query | Before | Now | smaltcy, smaltdb now (ms) |
|---|---|---|---|
| seek by name | 1.07x | 1.05x | 0.024, 0.026 |
| 1 hop | 0.79x | 0.76x | 0.034, 0.027 |
| 2 hops | 0.35x | 0.36x | 0.335, 0.121 |
| 3 hops | 0.30x | 0.33x | 4.176, 1.287 |
| 1 hop, directed | 0.86x | 0.80x | 0.029, 0.025 |
| 3 hops, directed | 0.26x | 0.28x | 2.274, 0.629 |
| 2 hops to a label | 2.09x | 0.26x | 0.728, 0.197 |
| 2 hops, relationship filter | 2.57x | 2.64x | 0.579, 1.593 |
| var-length 1..3, distinct | 0.69x | 0.61x | 12.183, 7.442 |
| shortest path | 0.89x | 0.84x | 0.045, 0.037 |
| shortest path, 5 hops | 0.17x | 0.18x | 29.138, 5.155 |
| shortest path, none (out) | 1.25x | 1.16x | 0.030, 0.035 |
| shortest path, none (all) | 0.23x | 0.25x | 29.773, 7.672 |
| label scan + filter | 2.27x | 1.01x | 2.151, 2.173 |
| group by city | 3.22x | 1.72x | 20.115, 36.367 |
| all relationships | 0.18x | 0.17x | 15.507, 2.847 |
| triangles (bounded) | 0.88x | 0.79x | 12.724, 10.740 |

**Statements that differ** (`BENCH_ENTRY=bench/vary.ts npm run bench:smaltdb`; a literal, a parameter):

| Statement | Before | Now |
|---|---|---|
| seek by name | 1.10x, 1.05x | 1.20x, 1.11x |
| 1 hop | 0.70x, 0.80x | 0.66x, 0.72x |
| 2 hops | 0.46x, 0.50x | 0.45x, 0.48x |
| 3 hops | 0.33x, 0.37x | 0.33x, 0.36x |
| 3 hops, directed | 0.48x, 0.51x | 0.41x, 0.54x |
| 2 hops to a label | 1.10x, 1.17x | 0.36x, 0.32x |
| 2 hops, relationship filter | 1.49x, 1.51x | 1.40x, 1.45x |
| var-length 1..3, distinct | 0.63x, 0.65x | 0.58x, 0.59x |
| shortest path | 0.13x, 0.14x | 0.12x, 0.15x |
| shortest path, directed | 1.12x, 0.94x | 1.05x, 0.97x |
| shortest path, none | 0.26x, 0.24x | 0.26x, 0.27x |
| label scan + filter | 4.52x, 2.68x | 2.63x, 1.64x |
| create 1 node | 38.0x, 43.1x | 38.6x, 45.5x |
| create 1,000 nodes | 14.7x, 14.8x | 14.3x, 14.1x |
| create 1 relationship | 71.6x, 80.8x | 69.0x, 78.5x |
| create 1,000 relationships | 10.9x, 10.4x | 9.91x, 8.93x |
| set 1 property by name | 21.4x, 25.0x | 23.1x, 27.2x |
| set 1,000 properties | 15.4x, 16.0x | 14.4x, 15.0x |
| merge existing node | 5.35x, 5.57x | 4.87x, 4.79x |
| merge 1,000 new nodes | 0.95x, 0.94x | 0.97x, 0.93x |
| delete 1 node | 126x, 122x | 112x, 120x |
| delete 1,000 nodes | 22.2x, 21.3x | 22.3x, 23.2x |

What it says:

- **The hop to a labelled node is under smaltcy's time** (2.09x to 0.26x; with a literal and a parameter 0.36x and
  0.32x): its 1,505 label checks are asked of a set in memory.
- **The label scan and group by city got faster too,** because smaltdb's planner now scans the label's nodes from the
  node table and checks the label of each in memory, where it read the label's entries and fetched each node's row.
  The label scan with the same text is at the bar (1.01x: 2.173 ms against 2.151); smaltdb's group by city went from
  50.8 to 36.4 ms.
- **Under smaltcy's time:** every hop but the one filtered on a relationship's property, the triangles, and every
  path but the two smallest statements (a shortest path with a direction: 1.16x with the same text, where there is no
  path, and 1.05x with a literal; 0.035 ms against 0.030).
- **Still over the bar among the reads:**
  - **2 hops filtered on a relationship's property** (2.64x; 1.40x and 1.45x) and **group by city** (1.72x).
  - **The label scan with a literal or a parameter** (2.63x and 1.64x). Its values are lower than the same text's
    (`p.age >` 22 to 42 with a literal and 44 to 64 with a parameter, against `> 70`, of ages from 18 to 77), so more
    people pass, and smaltdb's time grows with the rows that pass (10.4 and 5.9 ms against 2.2).
  - **Seek by name** (1.05x; 1.20x and 1.11x), a statement of under 0.1 ms: its time is finding the kept statement,
    as measured in "smaltdb's graph index, and shortest paths to a target".
- **Writes did not change:** they are the issue's step 4.

## Comparisons within one kind (2026-11-20)

Step 5a of stenhoor/smaltdb#274 (smaltdb's ADR 0041, section 1). smaltdb `166c6cd` has four comparisons that are NULL
unless both operands are numbers or both are strings (`cmp_lt_kind` and the others, stenhoor/smaltdb#283), and where
it scans a table it decides one on a property map's stored bytes. `<`, `<=`, `>` and `>=` of a property with a number
or a string are now that one operation here, where they were a CASE over the value's kind around smaltdb's `cmp_lt`,
which read the property three times for every row that passed.

The same machine and method. "Before" is the section above (smaltdb `57f0e94`). A ratio is smaltdb's time over
smaltcy's.

**The same text every run** (`BENCH_INDEXES=1 npm run bench:smaltdb`):

| Query | Before | Now | smaltcy, smaltdb now (ms) |
|---|---|---|---|
| seek by name | 1.05x | 1.08x | 0.018, 0.020 |
| 1 hop | 0.76x | 0.72x | 0.060, 0.045 |
| 2 hops | 0.36x | 0.35x | 0.351, 0.123 |
| 3 hops | 0.33x | 0.29x | 4.281, 1.269 |
| 1 hop, directed | 0.80x | 0.82x | 0.029, 0.024 |
| 3 hops, directed | 0.28x | 0.27x | 2.283, 0.618 |
| 2 hops to a label | 0.26x | 0.27x | 0.764, 0.206 |
| 2 hops, relationship filter | 2.64x | 1.87x | 0.644, 1.171 |
| var-length 1..3, distinct | 0.61x | 0.62x | 12.044, 7.466 |
| shortest path | 0.84x | 0.82x | 0.046, 0.038 |
| shortest path, 5 hops | 0.18x | 0.17x | 29.320, 5.193 |
| shortest path, none (out) | 1.16x | 1.16x | 0.030, 0.035 |
| shortest path, none (all) | 0.25x | 0.24x | 30.788, 7.628 |
| label scan + filter | 1.01x | 0.57x | 2.143, 1.230 |
| group by city | 1.72x | 1.85x | 18.271, 35.922 |
| all relationships | 0.17x | 0.17x | 15.778, 2.823 |
| triangles (bounded) | 0.79x | 0.81x | 12.258, 10.397 |

**Statements that differ** (`BENCH_ENTRY=bench/vary.ts npm run bench:smaltdb`; a literal, a parameter):

| Statement | Before | Now |
|---|---|---|
| seek by name | 1.20x, 1.11x | 1.09x, 1.09x |
| 1 hop | 0.66x, 0.72x | 0.63x, 0.72x |
| 2 hops | 0.45x, 0.48x | 0.49x, 0.47x |
| 3 hops | 0.33x, 0.36x | 0.31x, 0.35x |
| 3 hops, directed | 0.41x, 0.54x | 0.41x, 0.56x |
| 2 hops to a label | 0.36x, 0.32x | 0.31x, 0.34x |
| 2 hops, relationship filter | 1.40x, 1.45x | 1.05x, 1.09x |
| var-length 1..3, distinct | 0.58x, 0.59x | 0.58x, 0.63x |
| shortest path | 0.12x, 0.15x | 0.12x, 0.14x |
| shortest path, directed | 1.05x, 0.97x | 1.01x, 0.85x |
| shortest path, none | 0.26x, 0.27x | 0.24x, 0.22x |
| label scan + filter | 2.63x, 1.64x | 0.95x, 0.67x |
| create 1 node | 38.6x, 45.5x | 43.2x, 53.6x |
| create 1,000 nodes | 14.3x, 14.1x | 13.9x, 14.9x |
| create 1 relationship | 69.0x, 78.5x | 61.6x, 77.8x |
| create 1,000 relationships | 9.91x, 8.93x | 9.58x, 9.96x |
| set 1 property by name | 23.1x, 27.2x | 23.6x, 25.1x |
| set 1,000 properties | 14.4x, 15.0x | 14.2x, 14.4x |
| merge existing node | 4.87x, 4.79x | 5.24x, 5.03x |
| merge 1,000 new nodes | 0.97x, 0.93x | 0.90x, 0.96x |
| delete 1 node | 112x, 120x | 112x, 131x |
| delete 1,000 nodes | 22.3x, 23.2x | 23.5x, 22.4x |

What it says:

- **The label scan and filter is under smaltcy's time** in the three ways it is measured (0.57x; 0.95x and 0.67x).
  With a literal smaltdb's time went from 10.4 to 4.3 ms, with a parameter from 5.9 to 2.7: the scan no longer runs
  the comparison for the rows that pass its check of the stored bytes.
- **The relationship filter got faster and is still over** (2.64x to 1.87x; 1.05x and 1.09x). Its comparison is one
  read of the property where it was three. What is left is each relationship's row fetched for that property, 0.81
  of its 1.80 ms when profiled before this: smaltdb's ADR 0041, section 2 (step 5b).
- **Group by city did not change** (smaltdb's 36.4 and 35.9 ms; smaltcy's own time moved from 20.1 to 18.3): it has
  no such comparison. What it needs is in ADR 0041, sections 2 and 3.
- **The writes hold no such comparison,** and moved as they move between runs: creating 1 node took smaltdb 0.74
  and 0.66 ms before, 0.85 and 0.83 in this run, and 0.75 to 0.83 in two more runs of that case alone on this pin,
  with smaltcy's own time between 0.015 and 0.028 ms.

## A kept statement found by its tokens (2026-11-21)

For stenhoor/smaltdb#274: the two reads that were over the bar and take under 0.04 ms. A change to the smaltdb path
only (`src/smaltdb/shape.ts`; ADR 0004, "Statements kept by shape"). smaltcy's own engine is as it was, and smaltdb
is the pin of the section above (`166c6cd`).

**Where a small read's time went.** The seek by name in a loop, µs for one run: the lowest of 15 batches' means of
5,000 runs, the things measured taking turns. Before and now are two processes (one with `main`'s `shape.ts`, one
with this change), so the rows that did not change differ by what the machine did between them.

| | Before | Now |
|---|---|---|
| Compiling the Cypher (both engines do) | 5.54 | 6.17 |
| smaltcy's whole run | 9.63 | 11.36 |
| smaltdb's whole run | 14.95 | 11.02 |
| of it, finding the kept statement | 6.25 | 1.77 |
| of it, the prepared statement | 2.39 | 2.50 |

Finding the kept statement took more than running it. Profiled, it was two things: building the shape as a text
while walking the plan (43% of it), and looking that text up in a map (47%).

**What changed.** The walk writes the shape as a list of tokens (the plan's names, strings and numbers, a mark where
a list or an object opens and closes, a mark of its kind where a value was taken out) and hashes them as it writes
them. The statement is the one kept under that hash whose tokens are the same. No text is built.

**Finding a kept statement**, µs: `runOnSmaltdb` with the Cypher compiled once, on a database whose prepared
statements return no rows, the 17 shapes all kept. The lowest of 21 batches' means of 20,000 runs.

| Query | Before | Now |
|---|---|---|
| seek by name | 6.48 | 1.71 |
| 1 hop | 7.73 | 2.03 |
| 2 hops | 9.37 | 2.41 |
| 3 hops | 10.82 | 2.77 |
| 1 hop, directed | 7.80 | 2.02 |
| 3 hops, directed | 10.99 | 2.77 |
| 2 hops to a label | 9.57 | 2.37 |
| 2 hops, relationship filter | 11.03 | 2.82 |
| var-length 1..3, distinct | 8.48 | 2.07 |
| shortest path | 12.50 | 3.19 |
| shortest path, 5 hops | 12.30 | 3.20 |
| shortest path, none (out) | 12.28 | 3.26 |
| shortest path, none (all) | 12.07 | 3.23 |
| label scan + filter | 7.19 | 1.95 |
| group by city | 11.21 | 2.71 |
| all relationships | 7.22 | 1.74 |
| triangles (bounded) | 11.01 | 2.76 |
| all 17 together | 168.04 | 43.00 |

**Before and now** in the three tables below were run in turns in one series, both on this pin: before with `main`'s
`shape.ts`, now with this change. A ratio is smaltdb's time over smaltcy's.

**The same text every run** (`BENCH_INDEXES=1 npm run bench:smaltdb`; three runs before, three now; the times are
the first run's now):

| Query | Before | Now | smaltcy, smaltdb now (ms) |
|---|---|---|---|
| seek by name | 1.09x, 1.04x, 1.02x | 0.83x, 0.83x, 0.83x | 0.018, 0.015 |
| 1 hop | 0.78x, 0.77x, 0.78x | 0.61x, 0.61x, 0.59x | 0.040, 0.025 |
| 2 hops | 0.35x, 0.34x, 0.35x | 0.34x, 0.34x, 0.33x | 0.346, 0.127 |
| 3 hops | 0.30x, 0.29x, 0.29x | 0.28x, 0.29x, 0.29x | 4.413, 1.265 |
| 1 hop, directed | 0.83x, 0.85x, 0.83x | 0.63x, 0.63x, 0.64x | 0.029, 0.019 |
| 3 hops, directed | 0.27x, 0.27x, 0.27x | 0.27x, 0.27x, 0.26x | 2.286, 0.617 |
| 2 hops to a label | 0.27x, 0.26x, 0.25x | 0.25x, 0.26x, 0.23x | 0.744, 0.187 |
| 2 hops, relationship filter | 1.87x, 1.87x, 1.82x | 1.88x, 1.76x, 1.84x | 0.567, 1.104 |
| var-length 1..3, distinct | 0.63x, 0.63x, 0.57x | 0.59x, 0.58x, 0.58x | 11.731, 7.095 |
| shortest path | 0.83x, 0.83x, 0.85x | 0.66x, 0.61x, 0.69x | 0.044, 0.030 |
| shortest path, 5 hops | 0.17x, 0.17x, 0.16x | 0.17x, 0.17x, 0.17x | 27.932, 5.148 |
| shortest path, none (out) | 1.15x, 1.14x, 1.15x | 0.89x, 0.88x, 0.88x | 0.029, 0.026 |
| shortest path, none (all) | 0.23x, 0.23x, 0.23x | 0.24x, 0.22x, 0.23x | 31.267, 7.655 |
| label scan + filter | 0.54x, 0.58x, 0.58x | 0.56x, 0.58x, 0.56x | 2.129, 1.202 |
| group by city | 1.50x, 1.65x, 1.65x | 1.87x, 1.58x, 1.76x | 17.693, 35.985 |
| all relationships | 0.15x, 0.17x, 0.15x | 0.16x, 0.16x, 0.17x | 16.336, 2.647 |
| triangles (bounded) | 0.77x, 0.75x, 0.81x | 0.83x, 0.75x, 0.74x | 11.672, 10.215 |

**Statements that differ** (`BENCH_ENTRY=bench/vary.ts npm run bench:smaltdb`; a literal, a parameter; two runs
before, two now):

| Statement | Before | Now |
|---|---|---|
| seek by name | 1.12x, 1.02x and 1.18x, 1.02x | 1.01x, 0.95x and 1.08x, 0.96x |
| 1 hop | 0.65x, 0.70x and 0.66x, 0.81x | 0.56x, 0.64x and 0.57x, 0.60x |
| 2 hops | 0.44x, 0.50x and 0.49x, 0.51x | 0.42x, 0.43x and 0.42x, 0.45x |
| 3 hops | 0.31x, 0.32x and 0.33x, 0.35x | 0.31x, 0.33x and 0.34x, 0.40x |
| 3 hops, directed | 0.39x, 0.50x and 0.42x, 0.55x | 0.34x, 0.50x and 0.37x, 0.47x |
| 2 hops to a label | 0.30x, 0.30x and 0.35x, 0.40x | 0.27x, 0.29x and 0.27x, 0.31x |
| 2 hops, relationship filter | 0.98x, 1.00x and 1.09x, 1.10x | 0.95x, 0.99x and 0.85x, 1.00x |
| var-length 1..3, distinct | 0.67x, 0.67x and 0.60x, 0.64x | 0.59x, 0.60x and 0.65x, 0.62x |
| shortest path | 0.14x, 0.16x and 0.13x, 0.16x | 0.13x, 0.16x and 0.13x, 0.15x |
| shortest path, directed | 1.05x, 0.89x and 1.06x, 0.87x | 0.93x, 0.75x and 0.88x, 0.70x |
| shortest path, none | 0.27x, 0.26x and 0.25x, 0.25x | 0.25x, 0.26x and 0.27x, 0.26x |
| label scan + filter | 1.10x, 0.78x and 1.03x, 0.74x | 1.08x, 0.68x and 1.10x, 0.71x |
| create 1 node | 38.2x, 44.6x and 39.6x, 44.1x | 38.6x, 47.0x and 40.8x, 46.4x |
| create 1,000 nodes | 13.7x, 13.9x and 13.4x, 14.6x | 13.7x, 14.4x and 13.8x, 14.9x |
| create 1 relationship | 64.7x, 79.8x and 62.4x, 74.8x | 73.7x, 80.0x and 70.9x, 87.8x |
| create 1,000 relationships | 9.51x, 9.69x and 9.74x, 8.46x | 9.95x, 9.83x and 9.26x, 9.92x |
| set 1 property by name | 24.6x, 25.1x and 26.4x, 26.9x | 24.6x, 24.4x and 22.5x, 24.5x |
| set 1,000 properties | 14.2x, 14.8x and 12.4x, 13.8x | 13.0x, 13.3x and 13.8x, 13.6x |
| merge existing node | 5.79x, 5.75x and 5.57x, 5.19x | 4.66x, 4.30x and 5.34x, 5.29x |
| merge 1,000 new nodes | 0.91x, 0.93x and 0.92x, 0.94x | 0.90x, 0.90x and 0.92x, 0.91x |
| delete 1 node | 116x, 134x and 121x, 136x | 112x, 134x and 119x, 132x |
| delete 1,000 nodes | 24.1x, 23.5x and 22.6x, 22.5x | 22.4x, 22.7x and 22.6x, 23.3x |

**The same text every run: writes** (`BENCH_ENTRY=bench/writes.ts npm run bench:smaltdb`; one run before, one now):

| Write | Before | Now | smaltcy, smaltdb now (ms) |
|---|---|---|---|
| create 1 node | 50.2x | 50.6x | 0.007, 0.445 |
| create 1,000 nodes | 13.8x | 13.3x | 0.721, 9.667 |
| create 1 relationship | 119x | 117x | 0.015, 2.096 |
| create 1,000 relationships | 11.6x | 11.5x | 1.386, 16.858 |
| set 1 property by name | 7.63x | 6.89x | 0.012, 0.079 |
| set 1,000 properties | 15.0x | 13.5x | 0.616, 7.799 |
| merge existing node | 5.72x | 5.31x | 0.010, 0.058 |
| merge 1,000 new nodes | 0.80x | 0.78x | 15.782, 12.363 |
| delete 1,000 nodes | 28.3x | 28.6x | 0.492, 14.363 |

What it says:

- **The two reads over the bar that take under 0.04 ms are under it** with the same text: the seek by name (1.02x to
  1.09x before, 0.83x in each of the three runs now) and the shortest path with a direction and no path (1.14x and
  1.15x before, 0.88x and 0.89x now).
- **Every read of under 0.1 ms got faster against smaltcy,** by what finding its statement took: 1 hop from 0.77x
  and 0.78x to 0.59x to 0.61x, 1 hop with a direction from 0.83x to 0.85x to 0.63x and 0.64x, the shortest path from
  0.83x to 0.85x to 0.61x to 0.69x. The reads of a millisecond and more did not change: finding a statement was 6 to
  13 µs of them.
- **Statements that differ.** The seek by name with a parameter is under the bar (1.02x before, 0.95x and 0.96x
  now), and so is the directed shortest path with a literal (1.05x and 1.06x before, 0.93x and 0.88x now). The seek
  by name with a literal went from 1.12x and 1.18x to 1.01x and 1.08x: still at the bar or over it.
- **What is left of the seek by name with a literal is code that is not optimized yet when it is timed.** It is
  this benchmark's first case, so its 200 statements are the first the process times. Timed the same way in a
  scratch run (each statement once, the engines taking turns in blocks of ten), smaltdb took 1.03 to 1.07 times
  smaltcy's time over the first 200 statements (five runs), and 0.77 to 0.81 times over the same 200 run again as a
  third pass in the same process. With Node's optimizing compiler off (`node --no-opt`, one run) it took 1.33 to 1.38
  times in every pass. So smaltdb's path runs more code for a statement than smaltcy's engine does, and takes less
  time once that code is optimized. In one of those first passes smaltdb's 49.7 µs were 23.8 compiling the Cypher,
  14.4 in the prepared statement and 7.6 finding it and in the runner around it; in a loop those are 6.17, 2.50 and
  1.77.
- **The label scan with a literal is not this change's** (1.10x and 1.03x before, 1.08x and 1.10x now): finding its
  statement is 2 µs of 4 ms. It is smaltdb's ADR 0041, section 3 (the columns of an output nothing reads).
- **The relationship filter and group by city are over the bar on this pin.** stenhoor/smaltdb#287 (ADR 0041's
  step 5b) is what they need, and they are measured again with the next pin.
- **The writes did not change** beyond what they move between runs. The write runner uses the same walk
  (`valuesOut`), which is a few µs of a write.

## Properties in smaltdb's graph index, and group by city's plan (2026-11-21)

Step 5 of stenhoor/smaltdb#274 (smaltdb's ADR 0041): the pin moves from `166c6cd` to `13c4493`, which adds three
changes of smaltdb's. Its graph index remembers the property map of a node or relationship row once it is read by
its id, and gives it from memory from then on (stenhoor/smaltdb#287, step 5b). Projections one above the other are
one (stenhoor/smaltdb#285). Groups in the order of their first row no longer take a list for every row
(stenhoor/smaltdb#286, step 5c). smaltcy's own code does not change. Two tests do: they assert that an equality on
an indexed property seeks the index, and now ask it of a label of 217 nodes, because smaltdb reads a label of 17
nodes by id from its graph index (its ADR 0041, "As built").

The same method, in the same container. "Before" is the section above's "now" (the pin `166c6cd`), "now" is the pin
`13c4493`: two series run hours apart, not in turns. A ratio is smaltdb's time over smaltcy's.

**The same text every run** (`BENCH_INDEXES=1 npm run bench:smaltdb`; three runs before, three now; the times are
the first run's now):

| Query | Before | Now | smaltcy, smaltdb now (ms) |
|---|---|---|---|
| seek by name | 0.83x, 0.83x, 0.83x | 0.83x, 0.84x, 0.84x | 0.018, 0.014 |
| 1 hop | 0.61x, 0.61x, 0.59x | 0.60x, 0.60x, 0.60x | 0.032, 0.019 |
| 2 hops | 0.34x, 0.34x, 0.33x | 0.32x, 0.31x, 0.31x | 0.359, 0.113 |
| 3 hops | 0.28x, 0.29x, 0.29x | 0.28x, 0.28x, 0.28x | 4.347, 1.214 |
| 1 hop, directed | 0.63x, 0.63x, 0.64x | 0.63x, 0.63x, 0.64x | 0.029, 0.018 |
| 3 hops, directed | 0.27x, 0.27x, 0.26x | 0.26x, 0.26x, 0.25x | 2.264, 0.585 |
| 2 hops to a label | 0.25x, 0.26x, 0.23x | 0.23x, 0.24x, 0.24x | 0.748, 0.178 |
| 2 hops, relationship filter | 1.88x, 1.76x, 1.84x | 0.62x, 0.59x, 0.60x | 0.594, 0.377 |
| var-length 1..3, distinct | 0.59x, 0.58x, 0.58x | 0.53x, 0.54x, 0.53x | 11.510, 6.189 |
| shortest path | 0.66x, 0.61x, 0.69x | 0.65x, 0.66x, 0.57x | 0.045, 0.029 |
| shortest path, 5 hops | 0.17x, 0.17x, 0.17x | 0.17x, 0.18x, 0.18x | 27.346, 5.109 |
| shortest path, none (out) | 0.89x, 0.88x, 0.88x | 0.89x, 0.88x, 0.88x | 0.030, 0.026 |
| shortest path, none (all) | 0.24x, 0.22x, 0.23x | 0.24x, 0.24x, 0.26x | 30.184, 7.484 |
| label scan + filter | 0.56x, 0.58x, 0.56x | 0.53x, 0.56x, 0.56x | 2.227, 1.185 |
| group by city | 1.87x, 1.58x, 1.76x | 0.89x, 0.91x, 0.88x | 17.163, 16.353 |
| all relationships | 0.16x, 0.16x, 0.17x | 0.17x, 0.17x, 0.18x | 15.412, 2.792 |
| triangles (bounded) | 0.83x, 0.75x, 0.74x | 0.48x, 0.52x, 0.51x | 11.956, 6.190 |

**Statements that differ** (`BENCH_ENTRY=bench/vary.ts npm run bench:smaltdb`; a literal, a parameter; two runs
before, two now):

| Statement | Before | Now |
|---|---|---|
| seek by name | 1.01x, 0.95x and 1.08x, 0.96x | 1.00x, 0.96x and 1.01x, 0.98x |
| 1 hop | 0.56x, 0.64x and 0.57x, 0.60x | 0.63x, 0.65x and 0.59x, 0.71x |
| 2 hops | 0.42x, 0.43x and 0.42x, 0.45x | 0.40x, 0.42x and 0.41x, 0.41x |
| 3 hops | 0.31x, 0.33x and 0.34x, 0.40x | 0.30x, 0.35x and 0.30x, 0.33x |
| 3 hops, directed | 0.34x, 0.50x and 0.37x, 0.47x | 0.47x, 0.49x and 0.35x, 0.46x |
| 2 hops to a label | 0.27x, 0.29x and 0.27x, 0.31x | 0.34x, 0.26x and 0.28x, 0.29x |
| 2 hops, relationship filter | 0.95x, 0.99x and 0.85x, 1.00x | 0.68x, 0.79x and 0.77x, 0.75x |
| var-length 1..3, distinct | 0.59x, 0.60x and 0.65x, 0.62x | 0.53x, 0.53x and 0.51x, 0.54x |
| shortest path | 0.13x, 0.16x and 0.13x, 0.15x | 0.15x, 0.15x and 0.13x, 0.16x |
| shortest path, directed | 0.93x, 0.75x and 0.88x, 0.70x | 0.87x, 0.80x and 0.97x, 0.64x |
| shortest path, none | 0.25x, 0.26x and 0.27x, 0.26x | 0.26x, 0.25x and 0.27x, 0.27x |
| label scan + filter | 1.08x, 0.68x and 1.10x, 0.71x | 1.06x, 0.71x and 1.01x, 0.74x |
| create 1 node | 38.6x, 47.0x and 40.8x, 46.4x | 46.4x, 53.7x and 45.8x, 53.1x |
| create 1,000 nodes | 13.7x, 14.4x and 13.8x, 14.9x | 14.5x, 15.2x and 13.3x, 14.9x |
| create 1 relationship | 73.7x, 80.0x and 70.9x, 87.8x | 67.1x, 72.6x and 62.9x, 69.2x |
| create 1,000 relationships | 9.95x, 9.83x and 9.26x, 9.92x | 10.2x, 10.2x and 9.83x, 9.25x |
| set 1 property by name | 24.6x, 24.4x and 22.5x, 24.5x | 23.6x, 25.6x and 25.2x, 27.7x |
| set 1,000 properties | 13.0x, 13.3x and 13.8x, 13.6x | 13.9x, 14.8x and 14.5x, 14.9x |
| merge existing node | 4.66x, 4.30x and 5.34x, 5.29x | 5.70x, 5.54x and 5.50x, 5.00x |
| merge 1,000 new nodes | 0.90x, 0.90x and 0.92x, 0.91x | 0.96x, 0.91x and 0.93x, 0.90x |
| delete 1 node | 112x, 134x and 119x, 132x | 74.2x, 79.6x and 70.6x, 84.2x |
| delete 1,000 nodes | 22.4x, 22.7x and 22.6x, 23.3x | 22.6x, 21.9x and 22.9x, 21.8x |

**The same text every run: writes** (`BENCH_ENTRY=bench/writes.ts npm run bench:smaltdb`; one run before, two now):

| Write | Before | Now | smaltcy, smaltdb now (ms) |
|---|---|---|---|
| create 1 node | 50.6x | 54.4x, 54.3x | 0.007, 0.490 |
| create 1,000 nodes | 13.3x | 14.9x, 14.6x | 0.700, 9.923 |
| create 1 relationship | 117x | 119x, 121x | 0.015, 2.019 |
| create 1,000 relationships | 11.5x | 11.0x, 11.7x | 1.469, 17.435 |
| set 1 property by name | 6.89x | 7.12x, 7.02x | 0.012, 0.083 |
| set 1,000 properties | 13.5x | 11.5x, 13.9x | 0.665, 7.904 |
| merge existing node | 5.31x | 5.33x, 5.40x | 0.010, 0.059 |
| merge 1,000 new nodes | 0.78x | 0.83x, 0.83x | 15.687, 12.820 |
| delete 1,000 nodes | 28.6x | 30.1x, 30.1x | 0.489, 14.810 |

What it says:

- **Every read with the same text is under the bar** in each of the three runs: 0.17x to 0.91x.
- **The two that were over it:** the relationship filter (1.76x to 1.88x before, 0.59x to 0.62x now; smaltdb's
  1.104 ms is 0.377) and group by city (1.58x to 1.87x before, 0.88x to 0.91x now; smaltdb's 35.985 ms is 16.353).
  The relationship filter reads each relationship's property from memory. Group by city has all three changes.
- **The triangles got faster too** (0.74x to 0.83x before, 0.48x to 0.52x now; smaltdb's 10.215 ms is 6.190): their
  nodes are found by id in the graph index.
- **Statements that differ: the relationship filter is under the bar** with a literal and with a parameter (0.85x
  to 1.00x before, 0.68x to 0.79x now).
- **Two reads are at the bar or over it, both with a literal in the text.** The seek by name reads 1.00x and 1.01x
  (0.96x and 0.98x with a parameter): the section above has what it is. The label scan reads 1.06x and 1.01x (0.71x
  and 0.74x with a parameter): none of the three changes touches its plan, and what it needs is smaltdb's ADR 0041,
  section 3 (the columns of an output nothing reads).
- **Deleting 1 node, a statement that differs, got faster for smaltdb** (3.25 to 3.48 ms before, 2.10 to 2.26 now;
  112x to 134x before, 70.6x to 84.2x now). It finds its node by a scan of a label with no index (441 nodes when the
  case begins). Not profiled.
- **The other writes did not change** beyond what they move between runs. Creating 1 node took smaltdb 0.445 to
  0.496 ms in five runs on the pin before, and 0.490 in both runs now.

## Columns nothing reads, and what a statement's run costs (2026-11-21)

Step 5d of stenhoor/smaltdb#274. The pin moves from `13c4493` to `af15795`, smaltdb's `main` after two changes: a
table's row is decoded for the columns that still have a reader (stenhoor/smaltdb#288, its ADR 0041), and what a
compiled statement does on every run besides its plan costs less (stenhoor/smaltdb#289). smaltcy's own code does not
change.

The same method. Before and now were run in turns in one series: smaltcy's `main` bundled with each pin's smaltdb
source. That `main` has stenhoor/smaltcy#33 (a write's new ids are read from the tables' ends), which the section
above was measured without: one create is 54x there and 12x to 14x in this section's "before". A ratio is smaltdb's
time over smaltcy's.

**The same text every run** (`BENCH_INDEXES=1`; three runs before, three now; the times are the first run's now):

| Query | Before | Now | smaltcy, smaltdb now (ms) |
|---|---|---|---|
| seek by name | 0.84x, 0.82x, 0.86x | 0.81x, 0.80x, 0.83x | 0.025, 0.020 |
| 1 hop | 0.56x, 0.58x, 0.59x | 0.59x, 0.58x, 0.54x | 0.046, 0.028 |
| 2 hops | 0.29x, 0.30x, 0.29x | 0.29x, 0.31x, 0.29x | 0.310, 0.093 |
| 3 hops | 0.25x, 0.26x, 0.26x | 0.28x, 0.27x, 0.28x | 4.092, 1.048 |
| 1 hop, directed | 0.60x, 0.60x, 0.61x | 0.59x, 0.58x, 0.58x | 0.036, 0.017 |
| 3 hops, directed | 0.24x, 0.24x, 0.25x | 0.24x, 0.24x, 0.27x | 2.184, 0.534 |
| 2 hops to a label | 0.25x, 0.22x, 0.23x | 0.23x, 0.21x, 0.23x | 0.705, 0.159 |
| 2 hops, relationship filter | 0.61x, 0.61x, 0.61x | 0.61x, 0.60x, 0.60x | 0.544, 0.336 |
| var-length 1..3, distinct | 0.48x, 0.50x, 0.51x | 0.48x, 0.50x, 0.49x | 12.212, 5.792 |
| shortest path | 0.63x, 0.62x, 0.62x | 0.63x, 0.62x, 0.64x | 0.042, 0.026 |
| shortest path, 5 hops | 0.16x, 0.15x, 0.16x | 0.16x, 0.16x, 0.15x | 29.614, 4.845 |
| shortest path, none (out) | 0.87x, 0.88x, 0.87x | 0.86x, 0.90x, 0.85x | 0.028, 0.023 |
| shortest path, none (all) | 0.22x, 0.22x, 0.20x | 0.20x, 0.21x, 0.22x | 32.613, 7.431 |
| label scan + filter | 0.54x, 0.56x, 0.54x | 0.45x, 0.45x, 0.46x | 2.011, 0.897 |
| group by city | 0.72x, 0.70x, 0.75x | 0.65x, 0.69x, 0.65x | 21.930, 16.024 |
| all relationships | 0.16x, 0.16x, 0.15x | 0.13x, 0.14x, 0.14x | 15.693, 2.087 |
| triangles (bounded) | 0.45x, 0.47x, 0.42x | 0.38x, 0.39x, 0.36x | 12.904, 4.874 |

**Statements that differ** (`BENCH_ENTRY=bench/vary.ts`; a literal, a parameter; two runs before, two now):

| Statement | Before | Now |
|---|---|---|
| seek by name | 0.99x, 0.92x and 1.00x, 0.96x | 0.89x, 0.96x and 0.92x, 0.85x |
| 1 hop | 0.59x, 0.67x and 0.54x, 0.59x | 0.55x, 0.61x and 0.60x, 0.66x |
| 2 hops | 0.42x, 0.40x and 0.38x, 0.42x | 0.41x, 0.38x and 0.42x, 0.42x |
| 3 hops | 0.29x, 0.36x and 0.30x, 0.31x | 0.28x, 0.30x and 0.38x, 0.36x |
| 3 hops, directed | 0.34x, 0.43x and 0.39x, 0.41x | 0.32x, 0.46x and 0.40x, 0.40x |
| 2 hops to a label | 0.29x, 0.26x and 0.25x, 0.27x | 0.26x, 0.24x and 0.25x, 0.26x |
| 2 hops, relationship filter | 0.68x, 0.69x and 0.66x, 0.69x | 0.72x, 0.63x and 0.66x, 0.67x |
| var-length 1..3, distinct | 0.48x, 0.58x and 0.50x, 0.49x | 0.47x, 0.52x and 0.50x, 0.49x |
| shortest path | 0.11x, 0.14x and 0.12x, 0.15x | 0.13x, 0.16x and 0.12x, 0.14x |
| shortest path, directed | 0.93x, 0.61x and 0.93x, 0.68x | 0.88x, 0.75x and 0.85x, 0.69x |
| shortest path, none | 0.22x, 0.25x and 0.21x, 0.21x | 0.23x, 0.23x and 0.20x, 0.21x |
| label scan + filter | 1.03x, 0.70x and 1.08x, 0.67x | 0.77x, 0.54x and 0.69x, 0.55x |
| create 1 node | 15.9x, 19.6x and 16.1x, 17.9x | 14.5x, 17.4x and 16.6x, 17.5x |
| create 1,000 nodes | 13.5x, 12.3x and 14.7x, 13.2x | 13.0x, 13.5x and 12.4x, 13.1x |
| create 1 relationship | 18.4x, 23.2x and 20.3x, 21.1x | 19.2x, 24.2x and 16.7x, 19.9x |
| create 1,000 relationships | 7.86x, 7.72x and 8.49x, 8.40x | 8.15x, 8.06x and 8.72x, 8.10x |
| set 1 property by name | 25.4x, 26.5x and 21.9x, 25.5x | 20.3x, 29.4x and 21.9x, 25.8x |
| set 1,000 properties | 15.3x, 15.2x and 13.8x, 13.7x | 15.2x, 15.4x and 15.3x, 16.2x |
| merge existing node | 5.20x, 5.16x and 5.52x, 5.07x | 5.24x, 5.02x and 6.06x, 5.16x |
| merge 1,000 new nodes | 0.91x, 0.91x and 0.93x, 0.83x | 0.94x, 0.93x and 0.92x, 0.93x |
| delete 1 node | 69.3x, 80.6x and 69.7x, 81.7x | 70.4x, 87.3x and 75.5x, 85.4x |
| delete 1,000 nodes | 22.6x, 22.7x and 21.6x, 21.5x | 21.0x, 20.9x and 21.6x, 22.5x |

**The same text every run: writes** (`BENCH_ENTRY=bench/writes.ts`; two runs before, two now):

| Write | Before | Now | smaltcy, smaltdb now (ms) |
|---|---|---|---|
| create 1 node | 12.8x, 13.0x | 12.3x, 13.7x | 0.007, 0.094 |
| create 1,000 nodes | 12.4x, 12.4x | 12.2x, 12.3x | 0.721, 8.362 |
| create 1 relationship | 13.7x, 12.0x | 12.7x, 11.0x | 0.015, 0.189 |
| create 1,000 relationships | 9.56x, 9.43x | 9.01x, 9.88x | 1.416, 14.094 |
| set 1 property by name | 7.18x, 6.84x | 6.49x, 6.24x | 0.011, 0.067 |
| set 1,000 properties | 13.8x, 14.4x | 14.2x, 14.6x | 0.511, 7.220 |
| merge existing node | 5.78x, 5.53x | 5.18x, 5.38x | 0.009, 0.052 |
| merge 1,000 new nodes | 0.79x, 0.78x | 0.82x, 0.70x | 14.476, 11.680 |
| delete 1,000 nodes | 29.3x, 29.1x | 26.7x, 29.1x | 0.475, 13.722 |

What it says:

- **Every read is under the bar in each run of this series:** the 17 with the same text (0.13x to 0.90x), and the 12
  that differ each time, with a literal and with a parameter (0.12x to 0.96x).
- **The label scan with a literal in its text was the read over the bar:** 1.03x and 1.08x before, 0.77x and 0.69x
  now (with a parameter 0.70x and 0.67x before, 0.54x and 0.55x now; with the same text 0.54x to 0.56x before,
  0.45x and 0.46x now). Its scan no longer copies the property map of every row that passes out of the page.
- **The seek by name with a literal was the read at the bar:** 0.99x and 1.00x before, 0.89x and 0.92x now. Two runs
  do not settle it: it is the first case timed, before the code is optimized, and in seven runs of it alone on a
  build of stenhoor/smaltdb#289 it read 0.95x to 1.11x (that pull request has them).
- **Three more reads got faster against smaltcy:** all relationships (0.15x and 0.16x before, 0.13x and 0.14x now),
  the triangles (0.42x to 0.47x before, 0.36x to 0.39x now) and group by city (0.70x to 0.75x before, 0.65x to
  0.69x now).
- **The writes are where they were.** Setting 1 property (6.84x and 7.18x before, 6.24x and 6.49x now) and merging
  an existing node (5.53x and 5.78x before, 5.18x and 5.38x now) read lower in both runs; the others moved within
  their runs' spread.
- **Every write but merging 1,000 new nodes is over the bar:** with the same text from 5.2x (merging an existing
  node) to 29x (deleting 1,000 nodes), and with statements that differ up to 70x to 87x (deleting 1 node).
  stenhoor/smaltdb#274 has what they can reach on the graph's tables as they are, measured by hand, and the decision
  that is open.

## Writes kept by shape (2026-11-21)

stenhoor/smaltdb#274. The runner keeps the smaltdb statements it makes for a write with the write's shape, and the
next write of that shape runs them (ADR 0004, "Statements kept by shape"). Until now each of those statements held the
runner's own values (the id it gave a node, the row it appended, the rowid it wrote) and was planned again every time.
The pin moves from `af15795` to `f383dd4`, smaltdb's `main` with stenhoor/smaltdb#291: a plan's parameter read as a
map takes a JavaScript object, which is how a kept statement is given a row's properties.

The same method. Before and now were run in turns in one series: smaltcy's `main` (`d9204b2`) bundled with its pin's
smaltdb source (`af15795`), and this change bundled with `f383dd4`. A ratio is smaltdb's time over smaltcy's.

**The same text every run: writes** (`BENCH_ENTRY=bench/writes.ts`; three runs before, three now; the times are the
first run's now):

| Write | Before | Now | smaltcy, smaltdb now (ms) |
|---|---|---|---|
| create 1 node | 12.90x, 12.20x, 12.53x | 3.91x, 3.53x, 4.47x | 0.006, 0.023 |
| create 1,000 nodes | 9.91x, 12.50x, 12.09x | 12.67x, 12.82x, 12.54x | 0.619, 8.414 |
| create 1 relationship | 11.06x, 12.56x, 12.38x | 2.94x, 2.86x, 4.06x | 0.014, 0.042 |
| create 1,000 relationships | 10.34x, 10.49x, 10.37x | 9.66x, 10.63x, 9.61x | 1.328, 12.872 |
| set 1 property by name | 6.51x, 6.25x, 7.81x | 2.42x, 2.42x, 2.40x | 0.010, 0.024 |
| set 1,000 properties | 12.83x, 13.56x, 14.28x | 13.99x, 12.77x, 12.76x | 0.515, 6.971 |
| merge existing node | 5.30x, 5.88x, 5.43x | 1.26x, 1.18x, 1.17x | 0.010, 0.012 |
| merge 1,000 new nodes | 0.76x, 0.78x, 0.77x | 0.74x, 0.75x, 0.74x | 13.841, 10.385 |
| delete 1,000 nodes | 29.42x, 27.94x, 27.82x | 29.53x, 26.37x, 28.51x | 0.443, 13.254 |

**Statements that differ** (`BENCH_ENTRY=bench/vary.ts`; a literal, a parameter; two runs before, two now):

| Statement | Before | Now |
|---|---|---|
| seek by name | 0.96x, 0.88x and 0.99x, 0.95x | 1.00x, 0.89x and 0.94x, 0.92x |
| 1 hop | 0.54x, 0.63x and 0.53x, 0.59x | 0.53x, 0.54x and 0.52x, 0.69x |
| 2 hops | 0.42x, 0.42x and 0.40x, 0.40x | 0.40x, 0.40x and 0.39x, 0.37x |
| 3 hops | 0.34x, 0.32x and 0.30x, 0.33x | 0.34x, 0.38x and 0.28x, 0.30x |
| 3 hops, directed | 0.37x, 0.41x and 0.37x, 0.44x | 0.39x, 0.48x and 0.34x, 0.43x |
| 2 hops to a label | 0.28x, 0.26x and 0.27x, 0.28x | 0.29x, 0.27x and 0.28x, 0.28x |
| 2 hops, relationship filter | 0.74x, 0.70x and 0.67x, 0.66x | 0.65x, 0.66x and 0.82x, 0.75x |
| var-length 1..3, distinct | 0.53x, 0.59x and 0.48x, 0.54x | 0.53x, 0.49x and 0.55x, 0.57x |
| shortest path | 0.12x, 0.14x and 0.12x, 0.14x | 0.14x, 0.14x and 0.11x, 0.15x |
| shortest path, directed | 0.89x, 0.65x and 0.92x, 0.60x | 0.86x, 0.76x and 0.90x, 0.59x |
| shortest path, none | 0.25x, 0.25x and 0.25x, 0.25x | 0.24x, 0.24x and 0.23x, 0.26x |
| label scan + filter | 0.78x, 0.57x and 0.77x, 0.57x | 0.76x, 0.58x and 0.78x, 0.56x |
| create 1 node | 15.6x, 16.6x and 13.9x, 16.6x | 3.95x, 4.37x and 4.73x, 5.46x |
| create 1,000 nodes | 12.9x, 12.8x and 13.6x, 13.6x | 13.0x, 12.1x and 12.5x, 12.8x |
| create 1 relationship | 21.6x, 21.4x and 20.5x, 19.0x | 2.56x, 2.66x and 2.41x, 2.57x |
| create 1,000 relationships | 7.97x, 8.29x and 8.42x, 8.15x | 8.25x, 8.26x and 8.21x, 9.03x |
| set 1 property by name | 22.9x, 22.7x and 19.6x, 25.8x | 3.57x, 2.50x and 2.02x, 1.98x |
| set 1,000 properties | 15.6x, 14.7x and 14.2x, 15.1x | 14.0x, 14.5x and 12.5x, 13.0x |
| merge existing node | 6.32x, 5.17x and 6.74x, 5.78x | 1.19x, 1.21x and 1.15x, 1.20x |
| merge 1,000 new nodes | 0.89x, 0.92x and 0.88x, 0.90x | 0.88x, 0.85x and 0.89x, 0.87x |
| delete 1 node | 73.5x, 85.1x and 80.3x, 81.0x | 8.37x, 8.66x and 7.64x, 9.47x |
| delete 1,000 nodes | 20.9x, 22.1x and 21.8x, 21.0x | 21.5x, 21.1x and 21.1x, 21.4x |

**The same text every run: reads** (`BENCH_INDEXES=1`; two runs before, two now; the times are the first run's now):

| Query | Before | Now | smaltcy, smaltdb now (ms) |
|---|---|---|---|
| seek by name | 0.80x, 0.85x | 0.82x, 0.82x | 0.016, 0.014 |
| 1 hop | 0.62x, 0.56x | 0.56x, 0.56x | 0.033, 0.019 |
| 2 hops | 0.29x, 0.28x | 0.28x, 0.30x | 0.326, 0.093 |
| 3 hops | 0.26x, 0.26x | 0.28x, 0.26x | 4.041, 1.045 |
| 1 hop, directed | 0.58x, 0.60x | 0.59x, 0.60x | 0.027, 0.016 |
| 3 hops, directed | 0.24x, 0.25x | 0.23x, 0.23x | 2.175, 0.502 |
| 2 hops to a label | 0.19x, 0.22x | 0.20x, 0.21x | 0.722, 0.148 |
| 2 hops, relationship filter | 0.58x, 0.69x | 0.61x, 0.61x | 0.515, 0.314 |
| var-length 1..3, distinct | 0.50x, 0.50x | 0.49x, 0.50x | 11.602, 5.683 |
| shortest path | 0.61x, 0.60x | 0.62x, 0.61x | 0.043, 0.026 |
| shortest path, 5 hops | 0.15x, 0.15x | 0.17x, 0.17x | 28.868, 4.854 |
| shortest path, none (out) | 0.83x, 0.85x | 0.85x, 0.84x | 0.028, 0.023 |
| shortest path, none (all) | 0.20x, 0.21x | 0.22x, 0.22x | 32.590, 7.034 |
| label scan + filter | 0.45x, 0.47x | 0.46x, 0.47x | 1.881, 0.865 |
| group by city | 0.68x, 0.72x | 0.74x, 0.79x | 18.024, 14.590 |
| all relationships | 0.13x, 0.13x | 0.14x, 0.14x | 15.264, 2.100 |
| triangles (bounded) | 0.36x, 0.39x | 0.38x, 0.41x | 11.937, 4.745 |

What it says:

- **A single write takes a third to a tenth of what it did, against smaltcy.** With the same text: creating 1 node
  12.2x to 12.9x before, 3.5x to 4.5x now; 1 relationship 11.1x to 12.6x before, 2.9x to 4.1x now; setting 1 property
  6.3x to 7.8x before, 2.4x now; merging a node that is there 5.3x to 5.9x before, 1.17x to 1.26x now. With statements
  that differ: creating 1 node 13.9x to 16.6x before, 4.0x to 5.5x now; 1 relationship 19.0x to 21.6x before, 2.4x to
  2.7x now; setting 1 property 19.6x to 25.8x before, 2.0x to 3.6x now; merging 5.2x to 6.7x before, 1.15x to 1.21x
  now; deleting 1 node 73x to 85x before, 7.6x to 9.5x now.
- **No single write is under the bar.** What is left of one is smaltdb running the runner's statements: a create is a
  savepoint, a lookup of the last id, two appends (the node's row and its label entry) and the savepoint's release.
  Profiled on this pin's source (one run; 32 µs a create with the profiler on, 23 to 27 µs without): compiling the
  Cypher 19%, finding the shape 7%, the two appends 44% (25% writing the two rows and their three index entries), the
  savepoint and its release 7%, the commit 5%, the id lookup 4%.
- **Deleting 1 node, differing, is the furthest of them** (7.6x to 9.5x, 0.20 to 0.23 ms). That case deletes one of 401
  nodes of a label, found by a scan of the label (it has no index on the property), and the scan is most of it. In a
  scratch run with 801 nodes of the label, the match alone (`MATCH (n:Bench {i: …}) RETURN n.i`, a value that differs
  each time) took 371 and 377 µs on smaltdb and 70 and 68 µs on smaltcy (two runs). smaltdb reads the label's entries
  from the label index, then each node by its rowid: one seek for each node of the label (EXPLAIN ANALYZE). So this is
  a read's cost, and one the read benchmarks do not have: their label scan is over a label that is nearly the whole
  node table, which smaltdb reads in one loop. The same DELETE of a label's only node took 0.034 ms in a scratch run
  of this change (3.3x to 3.6x, three runs).
- **Writes of 1,000 rows did not move.** smaltdb's own times, the three runs before and now: creating 1,000 nodes 8.0
  to 8.9 ms and 8.0 to 8.4; 1,000 relationships 13.2 to 13.7 and 11.8 to 12.9; setting 1,000 properties 7.0 to 7.5
  and 6.9 to 7.3; deleting 1,000 nodes 13.2 to 13.8 and 13.1 to 13.3. Their rows are written into one statement as
  columns, which smaltdb plans each time, and the time is in writing the rows: profiled (one run), 70% of creating
  1,000 nodes is smaltdb's loop that writes the 2,000 rows and their 3,000 index entries, and 49% of deleting 1,000
  nodes is the graph's rules run for each deleted row (most of it a plan run for each node to delete its label
  entries, with a table writer made for each).
- **Merging 1,000 new nodes stays under the bar** (0.76x to 0.78x before, 0.74x to 0.75x now; differing 0.85x to
  0.92x).
- **The reads did not move** beyond their runs' spread, and none is over the bar: 0.13x to 0.85x with the same text,
  0.11x to 1.00x differing (the seek by name with a literal, the first case timed, read 1.00x in one run and 0.94x in
  the other). Group by city reads 0.74x and 0.79x where it read 0.68x and 0.72x: smaltdb's time is the same (14.8
  and 15.1 ms before, 14.6 and 14.5 now) and smaltcy's is lower (21.3 and 19.5 ms before, 18.0 and 18.2 now).

## Small labels, and nodes deleted (2026-11-22)

stenhoor/smaltdb#274. The pin moves from `f383dd4` to `6b5f100`, smaltdb's `main` with three changes (its ADR 0042's
step 1, and two that came of it):

- stenhoor/smaltdb#293: a label's nodes are read from smaltdb's graph index, and a node is checked on its properties
  before its row is asked for.
- stenhoor/smaltdb#294: the rule that refuses to delete a node that has relationships asks the graph index, and a plan
  smaltdb runs inside a statement gives its table writers back when it ends.
- stenhoor/smaltdb#295: a label's nodes are read only between the label's lowest and highest node.

No case read a small label, so three are new. In the reads: `small label + filter` (`MATCH (c:City {name: 'Lisbon'})
RETURN c.name`, one of the network's 8 cities by a property that has no index) and `small label` (`MATCH (c:City)
RETURN c.name`, the 8 cities). In the statements that differ: `node of a small label` (`MATCH (n:Bench {i: …}) RETURN
n.i`, one of a label's 441 nodes by a property that has no index, which is the read `delete 1 node` starts with).

The same method. Before and now were run in turns in one series: this change (the new cases; smaltcy's source is
`main`'s, `93013cf`) bundled with the old pin's smaltdb source (`f383dd4`), and bundled with the new pin's
(`6b5f100`). A ratio is smaltdb's time over smaltcy's.

**The same text every run: writes** (`BENCH_ENTRY=bench/writes.ts`; two runs before, two now; the times are the first
run's now):

| Write | Before | Now | smaltcy, smaltdb now (ms) |
|---|---|---|---|
| create 1 node | 3.58x, 3.76x | 3.71x, 3.68x | 0.006, 0.022 |
| create 1,000 nodes | 12.65x, 13.20x | 11.86x, 10.87x | 0.603, 7.592 |
| create 1 relationship | 2.94x, 3.05x | 2.97x, 3.02x | 0.013, 0.041 |
| create 1,000 relationships | 9.97x, 9.61x | 8.84x, 8.95x | 1.261, 12.063 |
| set 1 property by name | 2.33x, 2.35x | 2.41x, 2.39x | 0.011, 0.026 |
| set 1,000 properties | 14.98x, 13.82x | 12.46x, 13.30x | 0.577, 7.106 |
| merge existing node | 1.15x, 1.15x | 1.10x, 1.17x | 0.010, 0.012 |
| merge 1,000 new nodes | 0.74x, 0.72x | 0.71x, 0.70x | 13.416, 9.464 |
| delete 1,000 nodes | 29.03x, 28.23x | 19.14x, 19.99x | 0.439, 8.634 |

**Statements that differ** (`BENCH_ENTRY=bench/vary.ts`; a literal, a parameter; two runs before, two now):

| Statement | Before | Now |
|---|---|---|
| seek by name | 0.92x, 0.93x and 0.93x, 0.97x | 1.02x, 0.89x and 0.87x, 0.87x |
| 1 hop | 0.55x, 0.53x and 0.56x, 0.66x | 0.55x, 0.50x and 0.54x, 0.55x |
| 2 hops | 0.39x, 0.39x and 0.40x, 0.39x | 0.36x, 0.40x and 0.37x, 0.40x |
| 3 hops | 0.33x, 0.38x and 0.31x, 0.35x | 0.28x, 0.29x and 0.30x, 0.30x |
| 3 hops, directed | 0.44x, 0.34x and 0.47x, 0.42x | 0.34x, 0.37x and 0.41x, 0.44x |
| 2 hops to a label | 0.29x, 0.27x and 0.27x, 0.26x | 0.28x, 0.29x and 0.26x, 0.28x |
| 2 hops, relationship filter | 0.76x, 0.69x and 0.65x, 0.69x | 0.67x, 0.75x and 0.70x, 0.65x |
| var-length 1..3, distinct | 0.50x, 0.49x and 0.57x, 0.51x | 0.51x, 0.52x and 0.59x, 0.54x |
| shortest path | 0.13x, 0.12x and 0.14x, 0.14x | 0.12x, 0.12x and 0.15x, 0.16x |
| shortest path, directed | 0.83x, 0.91x and 0.66x, 0.68x | 0.89x, 0.94x and 0.71x, 0.74x |
| shortest path, none | 0.23x, 0.24x and 0.23x, 0.22x | 0.25x, 0.24x and 0.24x, 0.26x |
| label scan + filter | 0.74x, 0.76x and 0.55x, 0.56x | 0.78x, 0.73x and 0.54x, 0.53x |
| node of a small label | 5.72x, 5.14x and 6.14x, 6.69x | 0.86x, 0.82x and 0.86x, 0.75x |
| create 1 node | 4.16x, 4.30x and 3.76x, 4.53x | 4.01x, 4.02x and 3.63x, 4.61x |
| create 1,000 nodes | 12.2x, 12.6x and 12.8x, 12.4x | 11.4x, 11.6x and 12.4x, 12.1x |
| create 1 relationship | 2.71x, 2.62x and 2.48x, 2.76x | 2.45x, 2.59x and 3.77x, 2.76x |
| create 1,000 relationships | 7.94x, 7.83x and 7.43x, 7.62x | 7.83x, 7.48x and 7.33x, 7.14x |
| set 1 property by name | 1.91x, 2.13x and 2.56x, 2.40x | 2.19x, 2.40x and 2.51x, 2.14x |
| set 1,000 properties | 13.9x, 14.4x and 14.2x, 15.3x | 14.3x, 13.4x and 13.4x, 12.9x |
| merge existing node | 1.25x, 1.24x and 1.30x, 1.25x | 1.06x, 1.12x and 1.05x, 1.12x |
| merge 1,000 new nodes | 0.86x, 0.89x and 0.88x, 0.88x | 0.83x, 0.80x and 0.83x, 0.76x |
| delete 1 node | 8.82x, 7.50x and 9.75x, 8.29x | 2.66x, 2.28x and 2.31x, 2.23x |
| delete 1,000 nodes | 20.4x, 20.6x and 21.3x, 20.5x | 13.5x, 14.5x and 13.4x, 14.4x |

**The same text every run: reads** (`BENCH_INDEXES=1`; three runs before, three now; the times are the first run's
now):

| Query | Before | Now | smaltcy, smaltdb now (ms) |
|---|---|---|---|
| seek by name | 0.80x, 0.79x, 0.83x | 0.84x, 0.79x, 0.80x | 0.016, 0.013 |
| 1 hop | 0.58x, 0.59x, 0.53x | 0.57x, 0.60x, 0.55x | 0.029, 0.016 |
| 2 hops | 0.32x, 0.30x, 0.30x | 0.31x, 0.30x, 0.30x | 0.312, 0.093 |
| 3 hops | 0.27x, 0.26x, 0.27x | 0.26x, 0.27x, 0.27x | 3.854, 1.028 |
| 1 hop, directed | 0.59x, 0.58x, 0.59x | 0.58x, 0.58x, 0.60x | 0.039, 0.016 |
| 3 hops, directed | 0.25x, 0.24x, 0.24x | 0.24x, 0.24x, 0.24x | 2.073, 0.499 |
| 2 hops to a label | 0.24x, 0.22x, 0.22x | 0.23x, 0.22x, 0.22x | 0.676, 0.152 |
| 2 hops, relationship filter | 0.73x, 0.61x, 0.60x | 0.59x, 0.60x, 0.61x | 0.506, 0.316 |
| var-length 1..3, distinct | 0.53x, 0.49x, 0.51x | 0.54x, 0.51x, 0.49x | 10.495, 5.511 |
| shortest path | 0.62x, 0.64x, 0.63x | 0.59x, 0.61x, 0.62x | 0.040, 0.025 |
| shortest path, 5 hops | 0.16x, 0.15x, 0.16x | 0.17x, 0.15x, 0.16x | 25.873, 4.568 |
| shortest path, none (out) | 0.88x, 0.85x, 0.85x | 0.84x, 0.84x, 0.85x | 0.027, 0.022 |
| shortest path, none (all) | 0.22x, 0.22x, 0.23x | 0.25x, 0.22x, 0.22x | 26.169, 7.079 |
| label scan + filter | 0.47x, 0.46x, 0.46x | 0.48x, 0.46x, 0.47x | 1.823, 0.874 |
| small label + filter | 1.08x, 1.09x, 1.06x | 0.83x, 0.85x, 0.85x | 0.011, 0.010 |
| small label | 1.43x, 1.23x, 1.36x | 1.15x, 1.15x, 1.16x | 0.008, 0.009 |
| group by city | 0.79x, 0.76x, 0.81x | 0.77x, 0.74x, 0.78x | 18.321, 14.308 |
| all relationships | 0.15x, 0.14x, 0.14x | 0.13x, 0.13x, 0.13x | 15.851, 2.106 |
| triangles (bounded) | 0.40x, 0.46x, 0.45x | 0.43x, 0.43x, 0.37x | 10.767, 4.751 |

What it says:

- **A node of a small label, found by a property, is under the bar.** Differing, 5.14x to 6.69x before and 0.75x to
  0.86x now (smaltdb 0.21 to 0.25 ms before, 0.026 to 0.057 ms now). One of the 8 cities by its name, the same text:
  1.06x to 1.09x before, 0.83x to 0.85x now.
- **The 8 cities returned are still over it:** 1.23x to 1.43x before, 1.15x to 1.16x now (smaltdb 0.011 ms before,
  0.009 to 0.010 ms now; smaltcy 0.008 to 0.009 ms). What is left is not the label's scan: smaltdb sorts rows that
  already come in order, and asks for each node's row through the join (stenhoor/smaltdb#295).
- **Deleting 1 node, differing, takes a third to a quarter of what it did:** 7.50x to 9.75x before, 2.23x to 2.66x
  now (smaltdb 0.20 to 0.22 ms before, 0.049 to 0.079 ms now). Its read is the node of a small label above.
- **Deleting 1,000 nodes takes two thirds of what it did, and is still the write furthest from the bar.** The same
  text: 29.03x and 28.23x before, 19.14x and 19.99x now (smaltdb 12.6 and 13.0 ms before, 8.6 and 8.3 ms now).
  Differing: 20.4x to 21.3x before, 13.4x to 14.5x now (13.9 to 14.4 ms before, 9.3 to 9.4 ms now).
- **Merging 1,000 new nodes stays under the bar,** and smaltdb's own time is lower: the same text 10.5 and 10.2 ms
  before, 9.5 and 8.9 ms now (0.74x and 0.72x, 0.71x and 0.70x); differing 12.6 to 13.0 ms before, 11.4 to 12.2 ms now
  (0.86x to 0.89x, 0.76x to 0.83x).
- **Merging a node that is there reads lower differing, and smaltdb's time did not move:** 1.24x to 1.30x before and
  1.05x to 1.12x now, with smaltdb at 0.018 to 0.020 ms before and 0.017 to 0.019 ms now, and smaltcy, whose source is
  the same in both, at 0.014 to 0.016 ms before and 0.016 to 0.018 ms now. With the same text it is 1.15x and 1.15x
  before, 1.10x and 1.17x now.
- **No other single write moved, and none is under the bar:** creating 1 node 3.6x to 4.6x now, 1 relationship 2.5x to
  3.8x, setting 1 property 2.1x to 2.5x. Creating 1 relationship with a parameter read 3.77x in one run now (2.48x and
  2.76x before, 2.76x in the other run now), so it was run alone with 40 blocks, seven runs before and seven now in
  turns: with a literal 3.31x to 3.53x before and 3.31x to 3.61x now, with a parameter 2.40x to 2.88x before and 2.63x
  to 2.86x now; smaltdb's own time, the median of the seven, 0.185 ms before and 0.184 ms now with a literal, 0.139 ms
  and 0.136 ms with a parameter.
- **The other writes of 1,000 rows,** in smaltdb's own times, before and now. The same text (two runs each): creating
  1,000 nodes 7.3 and 7.7 ms, 7.6 and 7.7 ms; 1,000 relationships 11.1 and 11.4 ms, 12.1 and 12.1 ms; setting 1,000
  properties 6.7 and 7.1 ms, 7.1 and 6.8 ms. Differing (two runs each, a literal and a parameter): creating 1,000 nodes
  10.0 to 10.9 ms, 9.5 to 9.6 ms; 1,000 relationships 15.6 to 16.2 ms, 14.7 to 15.6 ms; setting 1,000 properties 8.7 to
  9.2 ms, 8.7 to 9.4 ms. Creating 1,000 relationships with the same text reads higher now and lower differing; the
  old pin's source read 12.5 and 12.3 ms for it in the series taken the evening before (the same case, two runs), so
  11.1 to 12.5 ms is what one source gives.
- **The other reads did not move** beyond their runs' spread, and none of them is over the bar: 0.13x to 0.85x now with
  the same text, 0.12x to 1.02x differing (the seek by name with a literal, the first case timed, read 1.02x in one
  run now and 0.89x in the other; 0.92x and 0.93x before).

## Writes as one plan (2026-11-22)

stenhoor/smaltdb#274; smaltdb's ADR 0042, step 3, this repository's first part. A statement that writes is compiled to
one smaltdb plan (`src/smaltdb/write-plan.ts`), which smaltdb runs (its step 2, stenhoor/smaltdb#297). The runner, which
ran a write from here as several smaltdb statements, is gone (ADR 0004, "Writes"). The pin moves from `6b5f100` to
`38118db`, smaltdb's `main` with stenhoor/smaltdb#296 (a history table has one writer) and stenhoor/smaltdb#297.

The same method. Before and now were run in turns in one series: smaltcy's `main` (`af7a85a`, the runner) bundled
with its pin's smaltdb source (`6b5f100`), and this change bundled with `38118db`. A ratio is smaltdb's time over the
time of smaltcy's in-memory engine on the same Cypher; the bar is 1.00x. The machine's times moved more between runs
that day than in the series before, so each benchmark was run six turns each way, and where a time and a ratio
disagree the ratio is the one to read ("Method").

The step's gate (smaltdb's ADR 0042, section 5): "Every single write faster than with smaltcy#36; the cases still
over the bar listed with their profiles." smaltcy#36 is the runner as `main` had it.

**The same text every run: writes** (`BENCH_ENTRY=bench/writes.ts`; six turns before, six now):

| Write | Before | Now | smaltdb before, now (ms, medians) |
|---|---|---|---|
| create 1 node | 4.35x, 3.79x, 3.71x, 3.82x, 4.09x, 3.82x | 3.76x, 3.29x, 3.21x, 3.28x, 3.21x, 3.57x | 0.025, 0.025 |
| create 1,000 nodes | 11.2x, 10.2x, 11.2x, 10.1x, 12.0x, 10.7x | 10.7x, 11.0x, 10.3x, 9.96x, 10.7x, 11.1x | 8.76, 8.70 |
| create 1 relationship | 3.26x, 3.11x, 3.52x, 3.96x, 2.89x, 3.17x | 2.28x, 2.35x, 2.49x, 2.27x, 2.35x, 2.20x | 0.045, 0.034 |
| create 1,000 relationships | 9.03x, 9.29x, 8.84x, 10.1x, 10.1x, 9.96x | 9.02x, 8.65x, 9.02x, 9.01x, 9.10x, 8.62x | 13.34, 11.79 |
| set 1 property by name | 2.42x, 2.50x, 2.45x, 2.67x, 2.44x, 2.44x | 1.92x, 1.76x, 1.73x, 1.82x, 1.74x, 1.71x | 0.028, 0.020 |
| set 1,000 properties | 12.5x, 12.6x, 14.4x, 15.2x, 14.7x, 14.1x | 11.2x, 11.2x, 9.88x, 11.1x, 12.4x, 11.2x | 7.65, 6.03 |
| merge existing node | 1.18x, 1.18x, 1.24x, 1.20x, 1.15x, 1.24x | 1.08x, 1.05x, 1.11x, 1.01x, 1.08x, 1.08x | 0.013, 0.011 |
| merge 1,000 new nodes | 0.73x, 0.72x, 0.68x, 0.73x, 0.72x, 0.72x | 0.59x, 0.65x, 0.67x, 0.64x, 0.69x, 0.61x | 10.32, 9.26 |
| delete 1,000 nodes | 17.9x, 17.4x, 19.2x, 15.9x, 18.5x, 17.5x | 14.8x, 16.5x, 15.0x, 14.5x, 14.6x, 15.4x | 9.24, 7.68 |

**Statements that differ** (`BENCH_ENTRY=bench/vary.ts`; six turns before, six now; the median of the six turns, with
the lowest and the highest):

| Statement | Before: a literal | Now: a literal | Before: a parameter | Now: a parameter |
|---|---|---|---|---|
| seek by name | 0.99x (0.93 to 1.02) | 0.94x (0.93 to 1.03) | 0.89x (0.83 to 0.91) | 0.93x (0.88 to 0.97) |
| 1 hop | 0.58x (0.54 to 0.61) | 0.57x (0.53 to 0.60) | 0.59x (0.57 to 0.69) | 0.56x (0.48 to 0.75) |
| 2 hops | 0.40x (0.37 to 0.42) | 0.39x (0.36 to 0.42) | 0.41x (0.37 to 0.46) | 0.41x (0.39 to 0.41) |
| 3 hops | 0.32x (0.29 to 0.38) | 0.32x (0.28 to 0.37) | 0.34x (0.31 to 0.41) | 0.33x (0.31 to 0.35) |
| 3 hops, directed | 0.34x (0.33 to 0.42) | 0.34x (0.31 to 0.39) | 0.42x (0.39 to 0.48) | 0.41x (0.37 to 0.46) |
| 2 hops to a label | 0.26x (0.22 to 0.34) | 0.25x (0.23 to 0.27) | 0.28x (0.25 to 0.32) | 0.27x (0.25 to 0.28) |
| 2 hops, relationship filter | 0.70x (0.68 to 0.79) | 0.69x (0.64 to 0.72) | 0.72x (0.69 to 0.77) | 0.68x (0.64 to 0.73) |
| var-length 1..3, distinct | 0.53x (0.50 to 0.58) | 0.53x (0.50 to 0.58) | 0.57x (0.50 to 0.60) | 0.56x (0.51 to 0.63) |
| shortest path | 0.12x (0.11 to 0.13) | 0.12x (0.12 to 0.14) | 0.15x (0.13 to 0.16) | 0.15x (0.14 to 0.16) |
| shortest path, directed | 0.91x (0.84 to 0.91) | 0.90x (0.87 to 0.92) | 0.69x (0.63 to 0.75) | 0.65x (0.61 to 0.73) |
| shortest path, none | 0.23x (0.22 to 0.25) | 0.23x (0.21 to 0.24) | 0.23x (0.21 to 0.26) | 0.23x (0.21 to 0.24) |
| label scan + filter | 0.77x (0.74 to 0.80) | 0.73x (0.70 to 0.88) | 0.56x (0.50 to 0.56) | 0.56x (0.51 to 0.60) |
| node of a small label | 0.86x (0.78 to 0.99) | 0.84x (0.81 to 1.00) | 0.81x (0.79 to 0.83) | 0.92x (0.85 to 1.28) |
| create 1 node | 4.51x (4.30 to 4.58) | 3.91x (3.76 to 5.06) | 4.08x (3.59 to 5.09) | 3.26x (3.08 to 4.31) |
| create 1,000 nodes | 12.1x (11.9 to 12.2) | 10.1x (9.79 to 10.9) | 12.1x (11.7 to 12.8) | 10.5x (9.97 to 11.5) |
| create 1 relationship | 2.92x (2.62 to 3.26) | 2.30x (2.03 to 3.05) | 2.97x (2.67 to 3.34) | 2.29x (2.21 to 2.61) |
| create 1,000 relationships | 8.09x (7.51 to 8.63) | 7.04x (6.19 to 7.27) | 8.13x (7.45 to 8.57) | 7.17x (6.59 to 7.87) |
| set 1 property by name | 2.21x (1.99 to 2.83) | 2.02x (1.96 to 2.56) | 2.33x (2.26 to 2.49) | 1.81x (1.65 to 2.07) |
| set 1,000 properties | 12.9x (12.5 to 15.6) | 9.36x (8.63 to 9.79) | 13.5x (12.1 to 15.2) | 9.02x (8.33 to 10.2) |
| merge existing node | 1.10x (0.93 to 1.28) | 1.00x (0.89 to 1.07) | 1.10x (1.04 to 1.21) | 0.99x (0.96 to 1.04) |
| merge 1,000 new nodes | 0.80x (0.78 to 0.85) | 0.64x (0.58 to 0.67) | 0.81x (0.77 to 0.82) | 0.61x (0.56 to 0.67) |
| delete 1 node | 2.45x (2.06 to 2.61) | 1.58x (1.44 to 1.82) | 2.29x (2.18 to 2.48) | 1.63x (1.51 to 1.73) |
| delete 1,000 nodes | 14.4x (13.7 to 14.8) | 12.1x (11.5 to 12.7) | 14.1x (13.0 to 14.6) | 12.1x (11.3 to 12.6) |

**The same text every run: reads** (`BENCH_INDEXES=1`; six turns before, six now; the times are the medians of the six
turns now):

| Query | Before | Now | smaltcy, smaltdb now (ms) |
|---|---|---|---|
| seek by name | 0.81x, 0.82x, 0.83x, 0.83x, 0.77x, 0.80x | 0.83x, 0.83x, 0.81x, 0.80x, 0.83x, 0.84x | 0.021, 0.018 |
| 1 hop | 0.57x, 0.60x, 0.57x, 0.60x, 0.58x, 0.54x | 0.56x, 0.59x, 0.60x, 0.57x, 0.58x, 0.59x | 0.034, 0.019 |
| 2 hops | 0.35x, 0.30x, 0.30x, 0.30x, 0.30x, 0.30x | 0.28x, 0.30x, 0.29x, 0.32x, 0.31x, 0.30x | 0.342, 0.103 |
| 3 hops | 0.36x, 0.28x, 0.27x, 0.27x, 0.32x, 0.28x | 0.34x, 0.27x, 0.27x, 0.28x, 0.26x, 0.26x | 4.27, 1.16 |
| 1 hop, directed | 0.60x, 0.59x, 0.60x, 0.59x, 0.60x, 0.59x | 0.62x, 0.60x, 0.60x, 0.59x, 0.59x, 0.59x | 0.028, 0.017 |
| 3 hops, directed | 0.28x, 0.26x, 0.26x, 0.24x, 0.24x, 0.24x | 0.35x, 0.26x, 0.33x, 0.24x, 0.24x, 0.26x | 2.24, 0.565 |
| 2 hops to a label | 0.22x, 0.22x, 0.22x, 0.23x, 0.23x, 0.21x | 0.35x, 0.30x, 0.21x, 0.21x, 0.29x, 0.22x | 0.762, 0.171 |
| 2 hops, relationship filter | 0.58x, 0.59x, 0.63x, 0.59x, 0.56x, 0.57x | 0.75x, 0.60x, 0.60x, 0.57x, 0.62x, 0.60x | 0.580, 0.361 |
| var-length 1..3, distinct | 0.51x, 0.57x, 0.53x, 0.53x, 0.51x, 0.48x | 0.57x, 0.51x, 0.52x, 0.52x, 0.51x, 0.50x | 13.12, 6.45 |
| shortest path | 0.62x, 0.67x, 0.68x, 0.66x, 0.63x, 0.62x | 0.69x, 0.65x, 0.65x, 0.60x, 0.64x, 0.62x | 0.045, 0.029 |
| shortest path, 5 hops | 0.15x, 0.15x, 0.16x, 0.16x, 0.16x, 0.14x | 0.15x, 0.15x, 0.15x, 0.15x, 0.15x, 0.14x | 33.51, 5.17 |
| shortest path, none (out) | 0.86x, 0.88x, 0.89x, 0.90x, 0.84x, 0.90x | 0.92x, 0.87x, 0.85x, 0.89x, 0.86x, 0.86x | 0.030, 0.026 |
| shortest path, none (all) | 0.21x, 0.23x, 0.22x, 0.22x, 0.22x, 0.20x | 0.23x, 0.24x, 0.23x, 0.22x, 0.22x, 0.21x | 34.18, 7.61 |
| label scan + filter | 0.45x, 0.47x, 0.48x, 0.48x, 0.43x, 0.48x | 0.48x, 0.47x, 0.47x, 0.48x, 0.46x, 0.48x | 2.07, 0.973 |
| small label + filter | 0.84x, 0.91x, 0.87x, 0.85x, 0.85x, 0.83x | 0.86x, 0.83x, 0.86x, 0.86x, 0.85x, 0.89x | 0.013, 0.011 |
| small label | 1.19x, 1.26x, 1.17x, 1.20x, 1.17x, 1.18x | 1.19x, 1.20x, 1.21x, 1.19x, 1.17x, 1.20x | 0.009, 0.010 |
| group by city | 0.86x, 0.81x, 0.72x, 0.72x, 0.65x, 0.67x | 0.73x, 0.76x, 0.74x, 0.71x, 0.67x, 0.68x | 22.63, 16.12 |
| all relationships | 0.14x, 0.14x, 0.14x, 0.13x, 0.14x, 0.13x | 0.15x, 0.14x, 0.14x, 0.14x, 0.14x, 0.13x | 16.57, 2.28 |
| triangles (bounded) | 0.48x, 0.41x, 0.43x, 0.42x, 0.42x, 0.40x | 0.51x, 0.44x, 0.45x, 0.42x, 0.43x, 0.43x | 12.96, 5.50 |

**Where a single write's time goes now.** Each single write was run 30,000 times on smaltdb as the benchmark runs it
(the Cypher compiled each time, then `runOnSmaltdb`; what puts the graph back between two writes is outside the
write), with smaltcy's engine beside it in the same loop, under V8's sampling profiler (`node --cpu-prof`). A share is
the time in a function and all it calls, of smaltdb's time for the write. `delete 1 node` is the case of the
statements that differ (one of a label's 441 nodes, found by a property that has no index), with one value.

| Write | smaltdb, smaltcy (µs a write, under the profiler) | The Cypher compiled | Its shape found | The smaltdb statement | In it: the plans smaltdb runs inside the statement | In it: the commit |
|---|---|---|---|---|---|---|
| create 1 node | 26.0, 9.1 | 18% | 7% | 73% | 47% | 6% |
| create 1 relationship | 44.5, 22.3 | 20% | 7% | 72% | 51% | 3% |
| set 1 property by name | 29.5, 16.7 | 26% | 10% | 63% | 37% | 7% |
| merge existing node | 15.0, 13.5 | 35% | 14% | 46% | 26% | 2% |
| delete 1 node | 56.7, 41.0 | 11% | 6% | 82% | 60% | 4% |

What the profiles say of each:

- **create 1 node.** smaltdb runs a plan inside the statement for each row it appends: the node's row (17% of the
  write) and its entry in the label index (26%). Writing the two rows and their index entries into B+trees is 23% of
  the write; the rest of those plans, 25%, is what running a plan for one row costs.
- **create 1 relationship.** The same three appends, of the label entry (20%), the node (12%) and the relationship
  (11%), with 23% in the rows written; the read of the node the relationship starts at is 8%.
- **set 1 property.** The update of the node's row is 23%, the read that finds the node 11%, the commit 7%. The
  Cypher's compile is a quarter of the write.
- **merge existing node.** Nothing is written. Half of the write is before smaltdb: the Cypher compiled (35%) and
  the shape found (14%). The statement is the match (22%) and what a statement costs around it.
- **delete 1 node.** The read that finds the node, a scan of its label's 441 nodes, is 41%; the delete of its row
  and its label entry 28%.

What it says:

- **Every single write is faster as one plan than through the runner, and none is under the bar with the same
  text.** The same text, before and now: creating 1 node 3.71x to 4.35x and 3.21x to 3.76x; 1 relationship 2.89x to
  3.96x and 2.20x to 2.49x; setting 1 property 2.42x to 2.67x and 1.71x to 1.92x; merging a node that is there 1.15x
  to 1.24x and 1.01x to 1.11x. Differing, by the medians of the six turns, with a literal and with a parameter:
  creating 1 node 4.51x and 4.08x before, 3.91x and 3.26x now; 1 relationship 2.92x and 2.97x, 2.30x and 2.29x;
  setting 1 property 2.21x and 2.33x, 2.02x and 1.81x; deleting 1 node 2.45x and 2.29x, 1.58x and 1.63x.
- **Creating 1 node with the same text is the closest call.** One turn now (3.76x) reads above one turn before
  (3.71x), and smaltdb's own time has medians of 0.025 ms before and 0.0245 ms now over the six turns (0.023 to 0.041
  before, 0.021 to 0.028 now). The ratios, each taken inside one run, have medians of 3.82x before and 3.29x now.
- **Merging a node that is there is at the bar with statements that differ:** 1.00x with a literal (0.89x to 1.07x)
  and 0.99x with a parameter (0.96x to 1.04x), from 1.10x and 1.10x. With the same text it is 1.01x to 1.11x.
- **The writes of 1,000 rows are faster or level, and still far from the bar** but the merge. The same text, in
  smaltdb's own times (medians, before and now): creating 1,000 nodes 8.76 and 8.70 ms (10.1x to 12.0x, 9.96x to
  11.1x: level); 1,000 relationships 13.34 and 11.79 ms; setting 1,000 properties 7.65 and 6.03 ms; deleting 1,000
  nodes 9.24 and 7.68 ms; merging 1,000 new nodes 10.32 and 9.26 ms (0.68x to 0.73x, 0.59x to 0.69x). Differing, the
  medians of the ratios: creating 1,000 nodes 12.1x to 10.1x and 10.5x, 1,000 relationships 8.1x to 7.0x and 7.2x,
  setting 1,000 properties 12.9x and 13.5x to 9.4x and 9.0x, deleting 1,000 nodes 14.4x and 14.1x to 12.1x. These
  write B+tree pages as the statement runs, which smaltdb's ADR 0042 changes in its step 4.
- **One read moved, and it is smaltdb's:** a node of a small label, with a parameter, 0.81x before (0.79x to 0.83x)
  and 0.92x now (0.85x to 1.28x), over the bar in two turns of six. The read shares no code with this change. Its
  nodes are made anew before the statements with a parameter, and through one plan they get new ids (20,449 to
  20,889) where the runner gave the first ones again. A node with an id past every one read before made smaltdb read
  a list past its end, and V8 dropped the optimized code of the scan for some 90 statements in the run traced (46 to
  55 µs a statement, then 27 to 30). stenhoor/smaltdb#298 looks at the list's length first: with it the case read
  0.76x to 0.87x in eight turns, against 0.82x to 1.28x on the pin in the same turns. Run alone, the case reads the
  same on both sources (0.84x to 0.87x and 0.81x to 0.87x, three turns).
- **The other reads did not move** beyond their runs' spread. With the same text, two read higher in some turns now
  with the same times: 2 hops to a label 0.29x to 0.35x in three turns of six (smaltdb 0.166 to 0.201 ms now, 0.163
  to 0.172 before; smaltcy's own time is the one that differs, 0.694 to 0.893 ms now and 0.712 to 0.745 before), and
  3 hops, directed 0.33x and 0.35x in two (smaltdb 0.545 to 0.627 ms now, 0.534 to 0.605 before). The 8 cities
  returned are where they were, over the bar: 1.17x to 1.26x before, 1.17x to 1.21x now.

## Cypher as a language of smaltdb (2026-11-24)

stenhoor/smaltdb#274; smaltdb's ADR 0042, step 3, this repository's second part, which ends the step. Cypher is
registered with smaltdb as a language, and `runOnSmaltdb` gives smaltdb a statement's text (ADR 0004, "A language of
smaltdb"). smaltdb keeps what the statement bound to, by its text, by its shape and by the kinds of its parameters'
values; what was kept here by shape is gone. The pin moves from `38118db` to `a315b55`: smaltdb's `main` with
stenhoor/smaltdb#298 (the property maps' page list is not read past its end), stenhoor/smaltdb#299 (its entry points
take a language's name, and it keeps a language's statements), stenhoor/smaltdb#300 (in memory, a graph's writes land in
its index and its tables are written behind), stenhoor/smaltdb#306 (the entries of the log of those writes are made by a
constructor) and stenhoor/smaltdb#305 (a text of a kept shape is kept by its text from the second time it comes). The
pin is the merge of the last.

The same method. Before and now were run in turns in one series, both bundled with the new pin's smaltdb source, so the
two differ in this change alone. **Before** is smaltcy's `main` (`86988f9`): the caller compiles the Cypher, statements
are kept by shape here, and smaltdb is given plans. **Now** is this change. Four turns each way for the writes and for
the statements that differ, three for the reads. A ratio is smaltdb's time over the time of smaltcy's in-memory engine
on the same Cypher; the bar is 1.00x. What the pin's move alone does is not in this series: it is the difference between
the "Now" of "Writes as one plan" above and this section's "Before", and smaltdb's ADR 0042 has its measurements ("Step
3: its gate", "Step 4: its gate").

What a run gives each engine is the statement's text. smaltcy's engine compiles it on every run. smaltdb parses a text
it has not kept, and finds one it has. So with the same text every run, and with one text whose parameter differs,
smaltdb does not parse the Cypher again, where before the caller compiled it for every run. With a literal that differs
every text is new, and it is parsed as before.

**The same text every run: writes** (`BENCH_ENTRY=bench/writes.ts`; four turns before, four now):

| Write | Before | Now | smaltdb before, now (ms, medians) |
|---|---|---|---|
| create 1 node | 1.56x, 1.55x, 1.71x, 1.62x | 0.86x, 0.73x, 0.81x, 0.86x | 0.011, 0.007 |
| create 1,000 nodes | 1.14x, 1.19x, 1.27x, 1.32x | 1.16x, 1.11x, 1.19x, 1.26x | 1.51, 1.42 |
| create 1 relationship | 1.35x, 1.31x, 1.32x, 1.37x | 0.63x, 0.65x, 0.69x, 0.65x | 0.019, 0.009 |
| create 1,000 relationships | 0.72x, 0.71x, 0.76x, 0.74x | 0.63x, 0.67x, 0.62x, 0.73x | 1.57, 1.44 |
| set 1 property by name | 1.15x, 1.21x, 1.15x, 1.14x | 0.45x, 0.48x, 0.43x, 0.48x | 0.014, 0.005 |
| set 1,000 properties | 2.02x, 2.33x, 2.06x, 2.38x | 2.22x, 1.86x, 2.00x, 1.81x | 1.71, 1.63 |
| merge existing node | 1.11x, 1.05x, 1.09x, 1.01x | 0.47x, 0.45x, 0.50x, 0.55x | 0.011, 0.005 |
| merge 1,000 new nodes | 0.16x, 0.16x, 0.17x, 0.15x | 0.16x, 0.15x, 0.15x, 0.14x | 2.40, 2.29 |
| delete 1,000 nodes | 1.63x, 1.54x, 1.44x, 1.26x | 1.29x, 1.54x, 1.39x, 1.47x | 1.03, 0.961 |

**Statements that differ** (`BENCH_ENTRY=bench/vary.ts`; four turns before, four now; the median of the four turns, with
the lowest and the highest):

| Statement | Before: a literal | Now: a literal | Before: a parameter | Now: a parameter |
|---|---|---|---|---|
| seek by name | 1.04x (1.03 to 1.08) | 1.12x (1.01 to 1.19) | 0.91x (0.87 to 0.95) | 0.32x (0.31 to 0.34) |
| 1 hop | 0.47x (0.45 to 0.51) | 0.57x (0.53 to 0.59) | 0.55x (0.50 to 0.57) | 0.23x (0.19 to 0.29) |
| 2 hops | 0.30x (0.30 to 0.31) | 0.33x (0.32 to 0.35) | 0.33x (0.32 to 0.33) | 0.20x (0.17 to 0.22) |
| 3 hops | 0.23x (0.22 to 0.24) | 0.24x (0.24 to 0.25) | 0.27x (0.26 to 0.27) | 0.22x (0.21 to 0.24) |
| 3 hops, directed | 0.26x (0.22 to 0.29) | 0.29x (0.27 to 0.32) | 0.33x (0.30 to 0.39) | 0.21x (0.19 to 0.23) |
| 2 hops to a label | 0.17x (0.16 to 0.20) | 0.18x (0.17 to 0.19) | 0.19x (0.18 to 0.19) | 0.12x (0.12 to 0.13) |
| 2 hops, relationship filter | 0.64x (0.63 to 0.66) | 0.70x (0.67 to 0.72) | 0.61x (0.59 to 0.68) | 0.49x (0.48 to 0.51) |
| var-length 1..3, distinct | 0.40x (0.37 to 0.41) | 0.42x (0.39 to 0.43) | 0.42x (0.41 to 0.45) | 0.38x (0.36 to 0.39) |
| shortest path | 0.10x (0.09 to 0.10) | 0.10x (0.09 to 0.11) | 0.11x (0.11 to 0.11) | 0.10x (0.09 to 0.10) |
| shortest path, directed | 0.81x (0.76 to 0.89) | 0.83x (0.79 to 0.85) | 0.60x (0.58 to 0.72) | 0.25x (0.22 to 0.29) |
| shortest path, none | 0.17x (0.17 to 0.17) | 0.17x (0.17 to 0.19) | 0.18x (0.17 to 0.18) | 0.17x (0.16 to 0.19) |
| label scan + filter | 0.47x (0.44 to 0.50) | 0.46x (0.46 to 0.49) | 0.33x (0.32 to 0.36) | 0.33x (0.30 to 0.34) |
| node of a small label | 0.86x (0.81 to 1.00) | 0.86x (0.84 to 0.99) | 0.78x (0.73 to 0.80) | 0.51x (0.47 to 0.53) |
| create 1 node | 2.19x (2.04 to 2.28) | 2.23x (2.15 to 2.61) | 1.90x (1.79 to 2.00) | 1.40x (1.31 to 1.45) |
| create 1,000 nodes | 1.52x (1.41 to 1.61) | 1.60x (1.53 to 1.65) | 1.47x (1.45 to 1.60) | 1.46x (1.44 to 1.51) |
| create 1 relationship | 1.40x (1.31 to 1.44) | 1.46x (1.29 to 1.59) | 1.40x (1.23 to 1.66) | 0.76x (0.70 to 0.81) |
| create 1,000 relationships | 0.88x (0.83 to 0.91) | 0.86x (0.81 to 0.93) | 0.89x (0.85 to 0.91) | 0.78x (0.73 to 0.80) |
| set 1 property by name | 1.38x (1.26 to 1.56) | 1.29x (1.25 to 1.35) | 1.15x (1.04 to 1.59) | 0.63x (0.62 to 0.64) |
| set 1,000 properties | 5.68x (5.49 to 6.14) | 5.75x (5.72 to 5.96) | 5.54x (5.27 to 5.85) | 5.41x (5.04 to 5.68) |
| merge existing node | 1.19x (1.14 to 1.45) | 1.21x (1.16 to 1.28) | 1.21x (1.16 to 1.30) | 0.62x (0.61 to 0.71) |
| merge 1,000 new nodes | 0.17x (0.16 to 0.17) | 0.16x (0.15 to 0.16) | 0.16x (0.16 to 0.16) | 0.15x (0.15 to 0.15) |
| delete 1 node | 1.02x (0.92 to 1.10) | 0.96x (0.90 to 1.08) | 0.98x (0.84 to 1.02) | 0.60x (0.58 to 0.66) |
| delete 1,000 nodes | 1.62x (1.56 to 1.68) | 1.54x (1.50 to 1.58) | 1.58x (1.51 to 1.66) | 1.45x (1.39 to 1.50) |

**The same text every run: reads** (`BENCH_INDEXES=1`; three turns before, three now; the times are the medians of the
three turns now):

| Query | Before | Now | smaltcy, smaltdb now (ms) |
|---|---|---|---|
| seek by name | 0.76x, 0.82x, 0.82x | 0.25x, 0.25x, 0.26x | 0.020, 0.005 |
| 1 hop | 0.57x, 0.57x, 0.52x | 0.21x, 0.20x, 0.23x | 0.034, 0.008 |
| 2 hops | 0.25x, 0.30x, 0.26x | 0.25x, 0.23x, 0.23x | 0.346, 0.081 |
| 3 hops | 0.16x, 0.16x, 0.16x | 0.18x, 0.15x, 0.16x | 6.99, 1.06 |
| 1 hop, directed | 0.56x, 0.55x, 0.57x | 0.21x, 0.22x, 0.22x | 0.029, 0.006 |
| 3 hops, directed | 0.19x, 0.19x, 0.16x | 0.18x, 0.15x, 0.16x | 2.88, 0.529 |
| 2 hops to a label | 0.15x, 0.18x, 0.16x | 0.14x, 0.14x, 0.15x | 0.946, 0.144 |
| 2 hops, relationship filter | 0.54x, 0.53x, 0.53x | 0.41x, 0.43x, 0.46x | 0.627, 0.313 |
| var-length 1..3, distinct | 0.38x, 0.40x, 0.41x | 0.38x, 0.36x, 0.41x | 18.11, 7.01 |
| shortest path | 0.60x, 0.59x, 0.59x | 0.20x, 0.22x, 0.21x | 0.053, 0.010 |
| shortest path, 5 hops | 0.12x, 0.12x, 0.13x | 0.12x, 0.12x, 0.12x | 48.85, 5.98 |
| shortest path, none (out) | 0.85x, 0.84x, 0.88x | 0.27x, 0.27x, 0.26x | 0.032, 0.008 |
| shortest path, none (all) | 0.17x, 0.18x, 0.18x | 0.17x, 0.16x, 0.18x | 48.97, 8.38 |
| label scan + filter | 0.31x, 0.27x, 0.31x | 0.30x, 0.33x, 0.27x | 2.63, 0.917 |
| small label + filter | 0.82x, 0.80x, 0.82x | 0.27x, 0.26x, 0.28x | 0.014, 0.003 |
| small label | 1.12x, 1.03x, 1.16x | 0.56x, 0.50x, 0.50x | 0.009, 0.004 |
| group by city | 0.53x, 0.51x, 0.54x | 0.50x, 0.48x, 0.48x | 29.56, 14.80 |
| all relationships | 0.10x, 0.09x, 0.09x | 0.10x, 0.10x, 0.10x | 21.51, 2.19 |
| triangles (bounded) | 0.29x, 0.30x, 0.30x | 0.28x, 0.29x, 0.31x | 17.62, 5.11 |

What it says:

- **With the same text, 25 of the 28 queries and writes are under the bar** (20 before). The four single writes are
  under it now: creating 1 node 1.55x to 1.71x before and 0.73x to 0.86x now, 1 relationship 1.31x to 1.37x and 0.63x to
  0.69x, setting 1 property 1.14x to 1.21x and 0.43x to 0.48x, merging a node that is there 1.01x to 1.11x and 0.45x to
  0.55x. So is the one read that was over it, a small label's nodes returned: 1.03x to 1.16x and 0.50x to 0.56x. The
  reads that take least gain as much: seek by name 0.76x to 0.82x and 0.25x to 0.26x, 1 hop 0.52x to 0.57x and 0.20x to
  0.23x. These are the runs where smaltcy's engine compiles the Cypher and smaltdb no longer does.
- **Over the bar with the same text: three of the five writes of 1,000 rows.** Creating 1,000 nodes 1.14x to 1.32x
  before and 1.11x to 1.26x now, setting 1,000 properties 2.02x to 2.38x and 1.81x to 2.22x, deleting 1,000 nodes 1.26x
  to 1.63x and 1.29x to 1.54x. This change does not touch the work on the rows. Creating 1,000 relationships (0.62x to
  0.73x) and merging 1,000 new nodes (0.14x to 0.16x) are under it, as they were.
- **With a parameter that differs, 19 of the 23 are under the bar** (15 before, and one at it). The text is the same
  each time, so smaltdb finds it: setting 1 property 1.04x to 1.59x before and 0.62x to 0.64x now, deleting 1 node 0.84x
  to 1.02x and 0.58x to 0.66x, creating 1 relationship 1.23x to 1.66x and 0.70x to 0.81x, merging a node that is there
  1.16x to 1.30x and 0.61x to 0.71x. Creating 1 node is faster and still over it: 1.79x to 2.00x and 1.31x to 1.45x. The
  other three over it are writes of 1,000 rows: creating 1,000 nodes 1.44x to 1.51x, setting 1,000 properties 5.04x to
  5.68x, deleting 1,000 nodes 1.39x to 1.50x.
- **With a literal that differs, nothing is gained, and three reads that take little read higher.** Every text is new,
  so it is parsed either way. Of the 23 lines, 20 have ranges that overlap before and now. The three that do not are
  higher now, and under the bar both ways: 1 hop 0.45x to 0.51x before and 0.53x to 0.59x now, 2 hops 0.30x to 0.31x and
  0.32x to 0.35x, 2 hops with a relationship filter 0.63x to 0.66x and 0.67x to 0.72x. Seek by name is over the bar in
  every turn both ways, and its median is higher now: 1.04x and 1.12x (1.03x to 1.08x, and 1.01x to 1.19x). The writes
  do not move: creating 1 node 2.04x to 2.28x and 2.15x to 2.61x, setting 1 property 1.26x to 1.56x and 1.25x to 1.35x.
  Eight lines are over the bar with a literal, the same eight before and now: seek by name, creating 1 node, 1,000 nodes
  and 1 relationship, setting 1 property and 1,000 properties, merging a node that is there, and deleting 1,000 nodes.
  Deleting 1 node is at it (0.92x to 1.10x and 0.90x to 1.08x).
  - **Looked at further**, before the pin's commit was there: the runs of this paragraph were on smaltdb's branch of
    stenhoor/smaltdb#305 (`6c4c1ee`), which the pin differs from by stenhoor/smaltdb#306 alone (how the entries of the
    log of a graph's writes are made, the same for both ways), and on this change before `main` was merged into it
    (`24a9c66`; the merge brings the lexer's stenhoor/smaltcy#39). The benchmark times a case's first 200 statements,
    after 20 that warm it up, the engines taking turns in blocks of 10. With 3,000 statements timed (`BENCH_BLOCKS=300`,
    six runs each way) seek by name with a literal reads 0.81x to 0.84x before and 0.88x to 0.92x now, so it is not the
    first statements alone. Then the two ways were compared with each other in one process, each on a smaltdb database
    of its own, taking turns in blocks of 100 statements (three runs of 60 pairs of blocks; the median of the pairs'
    ratios, now over before): seek by name 1.00x to 1.03x, 1 hop 1.00x to 1.07x, creating 1 node 0.99x to 1.01x, setting
    1 property 0.97x to 1.00x. So the benchmark, in the series above, has now at 1.07 times before on seek by name and
    1.22 times on 1 hop (the medians of the four turns), and the two ways side by side had it at 1.00 to 1.07 times. The
    two differ in what a statement on smaltdb comes between: statements on smaltcy's engine, every 10, in the benchmark,
    and statements on the other database, every 100, side by side. Which an application is like is not known.
  - **Where the time is.** A profile of the two ways in that process (34,000 seeks by name each way, every text new; on
    smaltdb's `main` before stenhoor/smaltdb#305, where now read 1.04x to 1.17x of before) has the engine's run of the
    statement the same in both (222 and 221 ms) and the Cypher's parse and bind the same (291 and 284 ms). The rest is
    99 ms before and 137 ms now. Making the statement's shape is 58 and 60 ms of it. The other 41 and 77 ms are what
    keeps and finds statements, here before and in smaltdb now: the text is looked up among those kept, a statement is
    made for it, and its shape is looked up. No one function has the difference. Two things changed after that profile,
    and the series has both: stenhoor/smaltdb#305, and the test for a read of the past (`readsThePast`), 14.5 of the 77
    ms, which no longer makes strings (7.9 ms over 44,000 statements in a later profile).
  - **What is left to take** is the parse: the Cypher's parse and bind are 284 of the 643 ms now, for a text whose shape
    smaltdb already has. Finding such a statement from its text without parsing it is not built.
