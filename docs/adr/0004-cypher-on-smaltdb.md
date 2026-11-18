# ADR 0004: Cypher on smaltdb

Date: 2026-11-18. Status: proposed (the step it implements, step 8 of smaltdb's ADR 0033, is accepted).

## Context

smaltdb's [ADR 0033](https://github.com/stenhoor/smaltdb/blob/main/docs/adr/0033-property-graphs-and-history.md)
decides that Cypher will run on smaltdb: smaltcy becomes a language, a parser and a compiler to smaltdb plans, and its
own engine and stores go once that works (its decisions 1 and 2). Step 8 is the compiler, beside smaltcy's engine, with
both engines running the Cypher suites and compared. Where Cypher's meaning and smaltdb's differ, the compiler keeps
Cypher's (its decision 13, section 5.4). smaltdb has property graphs (a catalog record over node and edge tables, with a
label index), a `map<text, any>` type for properties, and typed values under `any`, so booleans and lists keep their
kind ([smaltdb ADR 0039](https://github.com/stenhoor/smaltdb/blob/main/docs/adr/0039-typed-values-under-any.md)).

## Decision

**The mapping.** One smaltdb property graph per smaltcy graph (default name `graph`), made by
`src/smaltdb/schema.ts`:

- **Nodes:** every node is a row of one node table, `<graph>_node` (`id INTEGER PRIMARY KEY`, `props map<text, any>`),
  registered under a reserved label, `smaltcy:node`. `labels(n)` never shows it, and a Cypher write that uses it will
  be an error.
- **Labels:** each Cypher label is a label of the graph (`alterPropertyGraph` `addLabel`), whose own table
  (`<graph>_l<k>`) stays empty, and an entry in the graph's label index, `<graph>_labels`, one row per node and label.
  The index's rowid keeps a node's labels in the order it has them. A node with no labels has no entries. A label is
  found by a semi-join on the index; every label of a pattern is required.
- **Relationships:** one edge table per type (`addType`: `start`, `end`, `props`, indexes on `start` and `end`). A
  relationship's rowid is its smaltcy id when the graph to load gives them (an `id` on each relationship), so `id(r)`
  is the same on both engines; otherwise relationships are numbered in order and `id(r)` is refused. A relationship's
  identity in the compiler is its type and rowid.
- **Properties:** all in the `props` map, read with `map_get`. A boolean, a list or a map keeps its kind there; the
  compiler gives a value a static type back with `any_bool`, `any_list` and `any_map` where Cypher needs one.
- **Ids:** a store's node ids are kept, so `id(n)` is the same on both engines.

**The compiler** (`src/smaltdb/compile.ts`) turns a graph plan into a smaltdb query plan, built as plain data:
`src/smaltdb` imports smaltdb's types only, as smaltdb is not a runtime dependency yet. A node in a row is two columns
(its id and its props); a relationship five (its type's name, its rowid, its start and end as stored, its props); a
variable-length relationship's list one, its hops (`list<struct<edge int, rowid int, from int, to int>>`, smaltdb's
`paths` type, with `edge` the type's position in the graph and the hops read in the pattern's direction); a path two
(its first node and its hops); any other value is one column with a static type, or `any` when only the value knows.

**Patterns.** A new node is a join with the node table (its labels semi-joins on the label index). A relationship is a
join with its edge source, the union of its types' edge tables (no type: all of them), on the end that is bound, then
with the node table on the other end. A relationship with no direction reads each relationship both ways, a self-loop
once, as smaltcy's stores expand it. Within one MATCH, relationships are distinct (Cypher's uniqueness): two
relationships whose types can be the same must differ in type or rowid, and a variable-length relationship's hops must
not hold the others' (a subquery over its hops); two variable-length relationships of types that can be the same in
one MATCH are refused.

- **Variable length** is smaltdb's `paths` in trail mode (no relationship twice), with `minHops` and `maxHops`.
  `paths` reads a self-loop both ways with direction `both`, two paths the same: the rows are numbered first and each
  path kept once. A relationship property map is checked on every hop (none may lack it); its values must not read
  variables.
- **Shortest paths** are `paths` with `anyShortest` (walk) or `allShortest` (acyclic), once both ends are bound, kept
  where they end at the other end. smaltcy's engine checks properties as it searches and gives nothing when the
  shortest path is shorter than the minimum, so a shortest path with properties, with a minimum above 1, or beside
  other relationships in its MATCH is refused.
- **Named paths** are the first node and the hops of their relationships in order; `length`, `nodes` and
  `relationships` read them, and a list comprehension over nodes or relationships reads each one's data in a subquery.
- **OPTIONAL MATCH** numbers its input's rows (a window's `row_number`), matches, and left-joins the input back by
  number, so a row with no match (or none passing the WHERE, which is part of the match) passes once with the new
  slots NULL.
- **EXISTS and pattern predicates** (a pattern in `WHERE`) are smaltdb `exists` subqueries, and **pattern
  comprehensions** scalar subqueries of an `implode` (NULLs kept, `[]` for none; nodes as a list of their ids, as
  `collect()` gives them). The nested plan is compiled as a match of its own (its uniqueness, its WHERE), from one row:
  the enclosing row's columns read one subquery out (`col` with `depth` 1), so it is correlated with that row's nodes,
  relationships and values. smaltdb's nested plans don't read an `each`'s elements, so EXISTS and pattern
  comprehensions inside a list comprehension or a quantifier are refused, as are pattern comprehensions giving
  relationships or paths.
- **In results**, nodes, relationships, paths and lists of them are maps of their data, as smaltcy's engine gives them
  (`kind`, `id`, `labels` or `type`, `start` and `end`, `properties`; a path's `nodes` and `relationships`).
  `collect()` of nodes is a list of their ids.

**Writes** (`src/smaltdb/write.ts`, `runOnSmaltdb`) run as smaltcy's engine runs them, row by row, on a smaltdb
`Database` given by type only (its synchronous `queryPlan`). A statement that only reads is one query; one that writes is
several smaltdb statements, in a savepoint (inside the caller's transaction when there is one), so an error rolls back
all it wrote, the labels and types it added included:

- **Rows stream.** Each row goes through the writes and the operations between them (`project`, `filter`, `unwind`,
  `match`) before the next row starts, so a write sees what earlier rows wrote (`UNWIND … MERGE` finds what it created
  for an earlier row; `SET c.n = c.n + 1` counts up), and a LIMIT stops what feeds it, as in smaltcy's engine. The
  runner holds the rows as the compiler's columns; an operation on a row is a smaltdb query over that row (a `values`
  plan, with `any` columns as one-element `list<any>` columns, so booleans, lists and maps keep their kind), and EAGER,
  ORDER BY and aggregates one query over all their rows. What reads before any write, or doesn't read the graph, is one
  query.
- **Entities are read live.** A row holds a node's id and a relationship's type and rowid; every query over it reads
  their properties from their tables again. Values computed before a write keep what they were. Nodes, relationships and
  paths in the results are read once the statement is done, as smaltcy's engine reads them (a deleted node with no
  labels or properties, a deleted relationship with no type or ends).
- **CREATE** appends each new node (`id`, `props`) and its label-index entries, then each relationship to its type's
  edge table, with the property maps evaluated against the row as it is (a map literal's entries one by one, so each
  keeps its kind). The ids are chosen by the runner, not by smaltdb: a node's is one more than the largest node id, a
  relationship's rowid one more than the largest rowid of any edge table (so it stays unique across types, and `id(r)`
  reads it); within a statement they count on. **New labels and types** are added with `alterPropertyGraph` (`addLabel`
  / `addType`) the first time a write uses them; the reserved label `smaltcy:node`, and labels or types that differ from
  the graph's only in case, are refused.
- **SET and REMOVE** are `update`s of the `props` map in smaltdb (`map_merge`, `map_remove`), so the properties a write
  doesn't touch keep their stored kind: `n.k = v` sets one key (NULL removes it), `n = map` replaces the map, `n += map`
  merges it (its NULLs remove keys). A label is an entry in the label index, added or deleted. A NULL target is a no-op
  (its value not computed), a deleted one too; a value that isn't a node or relationship is smaltcy's type error, and a
  map or a list of lists as a property its storable-value error.
- **DELETE** deletes a relationship's row, or a node's after checking it has none (smaltcy's error and message
  otherwise; smaltdb's own rule backs it); DETACH deletes the node's relationships first. Paths delete their
  relationships, then their nodes; lists of nodes and of relationships each element. The label index's entries go with
  the node (smaltdb's rules on a graph's tables).
- **MERGE** matches the whole pattern for each row (the compiler's match, with its uniqueness); every match goes through
  ON MATCH, or, with none, the pattern is created (its unbound nodes and its relationships, in the pattern's direction)
  and goes through ON CREATE.
- **Counts** are smaltcy's (`nodesCreated` … `labelsRemoved`), counted as its engine counts them (a property set to
  NULL counts, a label already there doesn't).
- **A commit's author and message** (`RunOptions.author`, `message`, as smaltcy's `run(…, { author, message })`): the
  statement then runs in a transaction of its own (`begin` with them, `commit`), not a savepoint, so smaltdb records
  them in `smalt_commits` with the commit. Inside the caller's transaction they are refused: its `begin` or `commit`
  takes them (smaltdb has no way to give them to a savepoint).

**History** (smaltcy's [ADR 0002](0002-graph-history.md); smaltdb ADR 0033, decisions 14 to 17):

- **A graph that keeps history** (`GraphTables.history`, smaltcy's `open({ history })`) is a property graph made with
  smaltdb's `history` (`versions`, smaltdb's default method; `log` is passed through): its node table is created with
  it, and smaltdb creates the label index and every label's and type's table with it, those added by writes included.
- **Versions are smaltdb commit ids** (smaltdb's decision 17), with no table to map them: smaltcy's version 1, 2, 3 …
  is the commit each write made, and a version between two of the graph's (a commit that wrote other tables, or the
  schema statements that made the graph) reads the graph as of the one before. Version 0 is still the empty graph
  before the first commit. This is the simplest mapping that reads the same graph at every version; numbering 1, 2, 3
  would need a table the runner writes in each commit, and smaltdb gives no plan the commit's id while it is open.
- **A write is a commit.** A Cypher statement (or the caller's transaction around several) is one smaltdb transaction,
  so one commit, one version. A write that changes nothing makes none on either engine: smaltdb makes no commit for a
  transaction that writes nothing, and the runner writes nothing for a SET whose properties stay what they are (it
  compares them first, as smaltcy's history compares values), a label already there, or a target that's gone.
- **`AT VERSION v`** reads every scan of the graph's tables (in subqueries too) with `asOf: { commit: v }`, and
  **`AT TIME t`** (milliseconds, ISO 8601 text or a `Date`, as smaltcy takes it) with `asOf: { time: t }`. The runner
  finds the version first, as smaltcy's engine does: `AT VERSION` must be between the oldest version kept and the
  latest (smaltdb would read the present for a later commit, and a query that scans nothing would not see a forgotten
  one), and `AT TIME` reads the last commit at or before then, or the oldest kept when that is later; it then reads
  that commit. The latest is the last commit in `smalt_commits` (smaltdb records every commit that writes a table
  with history), the oldest kept the node table's horizon in `smalt_history`. A plan with `AT VERSION` that writes is
  smaltcy's error.
- **`version()`** is the version read: `AT VERSION`'s, else the last commit in `smalt_commits` (at or before `AT
  TIME`'s moment), 0 before the first; NULL on a graph without history, as smaltcy gives it.
- **`forget(v)`** is `forgetOnSmaltdb`: smaltdb's `forget` maintenance statement with `before: { commit: v }`, for each
  of the graph's tables, in one savepoint; a version after the latest is smaltcy's error.
- **New ids with history** also count the largest id in the graph's past versions (smaltdb's `smalt_versions_<table>`,
  or `smalt_log_<table>`), so an id a readable version holds is never given to another node or relationship, as
  smaltcy's ADR 0002 keeps ids stable across versions. A caller can also keep the next ids itself (`RunOptions.ids`,
  as smaltcy's store keeps them across statements, rolled back or not): ids then go on as smaltcy's do.

**Indexes.** smaltcy's `CREATE INDEX FOR (n:L) ON (n.k)` and `DROP INDEX ON :L(k)` (`IndexPlan`) run as smaltdb schema
statements: an expression index on the node table, on `map_get(props, k)`, named `<graph>_ix_<label>_<key>` with the
label and key in hex (smaltdb's names ignore case, Cypher's labels don't). The node table holds every node, so the
index holds the key's values of nodes of every label: an index can't be filtered by label, since labels live in the
label index, and a match by label stays a semi-join on it. Creating an index that exists and dropping one that doesn't
do nothing, as in smaltcy's stores. Indexes don't change results; on a graph that keeps history they don't change its
versions.

It keeps Cypher's meaning:

- **Comparisons by kind:** `=` is NULL with a NULL and false across kinds (`true = 1` is false), `<` is NULL across
  kinds and for NaN; where a type is `any`, the kind is found when the query runs (`any_type`).
- **Booleans:** a predicate must be a boolean or NULL; anything else is Cypher's type error. Comparisons and logic are
  declared `bool`, so results give `true` and `false`.
- **Arithmetic:** 64-bit integers with checked operations (`add_checked` …); integer division truncates and division by
  zero is an error; `+` joins two strings.
- **ORDER BY:** Cypher's order of kinds (strings, booleans, numbers, NaN), NULLs last ascending and first descending.
- **Aggregates:** `sum` of nothing is 0, `collect` leaves NULLs out, `min` and `max` across kinds follow Cypher's
  order, groups come in the order of their first row.
- **Quantifiers and list comprehensions** with Cypher's NULLs, over smaltdb's `each`.

What it can't compile yet it refuses with `Unsupported`, which names the feature. What it can compile but whose meaning
only the values show it can't keep (comparing two lists, ordering a list, adding a boolean) raises an error when a row
reaches it, never a different answer: smaltdb has no function that raises a message, so this is a strict conversion of
the message to an integer, an error whose text starts with `smaltcy:`.

**The tests.** `test/smaltdb-differential.test.ts` runs every read case of the Cypher suite on smaltdb, from the same
graph, and lists those the compiler refuses; the list can only shrink. `test/smaltdb-writes.test.ts` runs every write
case of the Cypher suite (`test/helpers/write-cases.ts`, which `test/cypher-write.test.ts` runs on smaltcy's engine) and
more sequences of writes on both engines, comparing after each statement the rows, the counts and the whole graph (ids,
labels in order, properties, relationships), statements that fail on both (smaltdb rolled back, new labels and types
included), and the writes it refuses. Two more sets run queries on both engines and
compare their rows: over properties of every kind, and over relationships on a graph with self-loops, parallel
relationships of two types and a node with none (uniqueness, both directions, OPTIONAL MATCH with WHERE, type
alternatives, variable length, paths). A third runs EXISTS, pattern predicates and pattern comprehensions on that
graph: correlated on nodes and relationships, negated, nested, in OPTIONAL MATCH, with WHERE, in ORDER BY and
aggregates. `test/smaltdb-history.test.ts` writes the histories of `test/history.test.ts` (random writes from a seed,
some in transactions of two statements, some failing; the social graph changing over four versions;
`test/helpers/history-cases.ts`) on both engines, checks that smaltdb commits exactly when smaltcy makes a version,
with its author and message, then reads every version with `AT VERSION` (nodes, relationships, a pattern) and each
commit's moment with `AT TIME` on both, before and after `forget`. The index test runs the same queries before and
after an index exists and checks smaltdb's catalog.

## Consequences

- Reads compile now (58 of the 59 read cases); `keys()` (below) is refused. Writes run (all 14 write cases, and the
  sequences in `test/smaltdb-writes.test.ts`). `range()` compiles to smaltdb's `range` table function. History runs:
  `AT VERSION`, `AT TIME`, `version()` and `forget`, compared on the histories of smaltcy's own history tests, and
  so do `CREATE INDEX` and `DROP INDEX`.
- **History refused** (`Unsupported`): `commits()`, `commit(v)` and `history(x)`, whose maps hold a commit's counts and
  the graph's size, and each change to a node or relationship, which smaltdb doesn't record (`smalt_commits` holds a
  commit's id, time, author and message); variable-length relationships and shortest paths with `AT VERSION` or `AT
  TIME`, as smaltdb's `paths` reads its edge tables as they are now; an author or message for one statement inside a
  transaction.
- **Indexes aren't used yet.** smaltdb's planner doesn't seek with them for the compiled queries (EXPLAIN shows a scan
  of the node table): a property match compiles to Cypher's comparison by kind, not to the plain `map_get(props, k) =
  v` an expression index matches. A seekable form of that comparison is left for later.
- A write is many smaltdb statements: queries and writes for each row, as the runner streams rows the way smaltcy's
  engine does. That is slow on large inputs; set-based plans for writes that can't see each other (no reads between
  them) would be faster, and are left for later. The runner takes a synchronous `queryPlan` (smaltdb's `Database` in a
  worker), not the client's asynchronous one yet.
- **Writes refused** (`Unsupported`): the reserved label and labels or types differing from the graph's only in case;
  DISTINCT with writes before and after it in one pipeline (smaltcy's passes rows on as they come); UNION with writes;
  MERGE with a parameter as a property map (the compiler's pattern maps); after a DELETE, `labels()`, `properties()`,
  `type()`, `startNode()`, `endNode()`, `nodes()` and `relationships()` (smaltcy's engine fails on a deleted node or
  relationship, smaltdb would give a value), and paths and lists of nodes or relationships in its results (smaltcy's
  engine gives a deleted one as an empty one, smaltdb's lists would drop it).
- An OPTIONAL MATCH puts its input's plan in the smaltdb plan twice, so a query's plan doubles with each one; smaltdb
  runs that input twice. Every operation the compiler makes keeps an order, so both give the same rows in the same
  order.
- `allShortestPaths` enumerates acyclic paths before ranking them, which can grow fast on a dense graph.
- **Known differences, recorded rather than hidden:**
  - smaltdb finds a graph's labels and types ignoring case when they are added; Cypher's are case-sensitive. A graph
    with two labels (or types) that differ only in case is refused when it is loaded.
  - A smaltdb map keeps its keys sorted, so `keys(n)` can't give them in the order they were set: it is refused.
  - smaltdb compares text by its UTF-8 bytes, smaltcy by UTF-16 code units: the order of characters above U+FFFF
    against U+E000 to U+FFFF differs. Not guarded.
  - Integers are 64-bit on smaltdb: an overflow is an error, where smaltcy's numbers become inexact floats.
  - Errors have smaltdb's codes and the `smaltcy:` messages above, not smaltcy's. The runner's own checks (deleting a
    node with relationships, a relationship to NULL, values that can't be properties) raise smaltcy's errors.
  - New ids are one more than the largest: smaltcy's stores count on from the largest id they ever gave, so after the
    node (or relationship) with the largest id is deleted, or a statement that created some fails, smaltdb gives that
    id again where smaltcy gives the next one. With history, ids in past versions count (so only an id no version
    holds, or one from before a `forget`, comes again); with `RunOptions.ids`, the numbering is smaltcy's.
  - smaltcy's versions count 1, 2, 3 …; on smaltdb they are commit ids, which skip the commits that didn't write the
    graph (the schema statements that made it, other tables' writes). A commit's time is smaltdb's clock
    (`Date.now()`, never earlier than the commit before), so several commits can have the same millisecond, and `AT
    TIME` then reads the last of them; smaltcy's history takes a clock of its own.
  - A graph's default author (smaltcy's `open({ history: { author } })`) is the caller's to give with each statement.
  - smaltdb's `smalt_commits` is the database's: a commit with an author or message that writes other tables is there
    too, and `version()` and `AT VERSION` count it.
  - Where a `shortestPath` has several shortest paths, Cypher returns any one: smaltdb's may be another than
    smaltcy's.
  - A node's or relationship's `properties` in a result come back with their keys sorted (a smaltdb map), where
    smaltcy's keep the order they were set; the values are the same.
  - smaltcy's own engine doesn't count a variable-length relationship's hops as used, so a hop it expands after one in
    the same MATCH can bind one of them again; the compiler keeps Cypher's uniqueness (tested).
  - A pattern comprehension's list is in the order its pattern matches, which Cypher leaves open, as it does a
    MATCH's: smaltdb's goes by relationship type, then by relationship, smaltcy's store by relationship id. The
    elements are the same; the tests compare them in any order where the two can differ.
  - smaltdb's planner decides the order conditions are evaluated in; where a condition raises (a non-boolean in
    `WHERE`), a query could raise on smaltdb where smaltcy stops early. The cases tried agree; nothing guarantees it.
- Two workarounds for smaltdb's planner (a sort key that is an expression over a project or filter, and `values` with
  no rows) went once smaltdb fixed both (stenhoor/smaltdb#262): the compiler gives sort keys as expressions and an
  empty edge source as `values` with `rows: []`.
- A third workaround went once smaltdb fixed it (stenhoor/smaltdb#263): an `update` whose input joins the target with a
  `values` plan (`UPDATE … FROM`) failed with `SMALT_INTERNAL` ("the physical planner declined a write") when the
  join had `ordered: true`; the runner's SET joins with `ordered: true` again.
