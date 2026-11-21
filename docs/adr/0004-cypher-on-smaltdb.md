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
  (`<graph>_l<k>`, numbered, as smaltdb's table names ignore case) stays empty, and an entry in the graph's label index, `<graph>_labels`, one row per node and label.
  The index's rowid keeps a node's labels in the order it has them. A node with no labels has no entries. A label is
  found by a semi-join on the index; every label of a pattern is required.
- **Case:** labels and relationship types are case-sensitive in a smaltdb property graph (its `caseSensitive`, true by
  default, stenhoor/smaltdb#265), as in Cypher: `Person` and `person` are two labels, each with its own table.
- **Relationships:** one edge table per type (`addType`: `start`, `end`, `props`, indexes on `start` and `end`; the
  table `<graph>_t<k>`). A
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

**Patterns.** A MATCH is one smaltdb join region: a flat join of FROM items, which smaltdb's planner orders by cost
and seeks into (the node table's rowid, the label index, a node's relationships), with all its conditions over their
columns and the row's columns in one projection on top. Its FROM items are the input (when there is one: the first
MATCH has none), a scan of the node table for each new node and of the label index for each of its labels (an inner
join: the index is unique on label and node, so it never repeats a node), and one item for each relationship:
smaltdb's `relationships` (its ADR 0040), the graph's relationships as a relation that is read from either end. It is
given the relationship's types (no type: all of them) and its direction as read from the pattern's end that is bound
(with no direction, both ways, a self-loop once, as smaltcy's stores expand it); its `node` column is that end and
its `other` column the far end. So a hop is one join, whatever its direction and however many types it may be, and
smaltdb reads the relationships at a node for each row before it, from whichever end those rows give, or all of them
once, by cost. Two things are left out of it:

- A relationship of one type read one way, with neither end bound, is a scan of its type's table, which smaltdb reads
  whole faster (a count of 40,025 relationships filtered on a property, prepared: 5.6 ms against 17.6 ms).
- The properties of a relationship nothing reads are NULL, so smaltdb doesn't read its row.

With the order kept, rows are sorted by the region's row, then the reading (forward first), the type and the rowid,
as smaltcy's stores give them. An anonymous node that only a relationship reaches, with no labels or properties, that
nothing else in the query reads (but its identity: `count(n)`, `id(n)`, which read its id), is that relationship's
end, not a scan of the node table: smaltdb's graph keeps every end a node of the graph. A node of which only labels
are asked is that end and an entry of the label index for each label: smaltdb keeps the index's entries nodes of the
graph too. Until 2026-11-20 a relationship of several types, or with no direction, was a union of its types' edge
tables, or from a bound end an `iterate` of one step from each row, and `CompileOptions.maxBranches` could split a
pattern into a region per type and reading; `relationships` replaced the three (docs/research/benchmarks.md, "Hops
as relationships").
Within one MATCH, relationships are distinct (Cypher's uniqueness): two relationships whose types can be the same must
differ in type or rowid, and a variable-length relationship's hops must not hold the others' (a subquery over its
hops); two variable-length relationships of types that can be the same in one MATCH are refused.

- **Conditions.** Property maps and the conjuncts of the MATCH's WHERE that can't raise an error (comparisons, label
  tests, EXISTS: only functions that never raise) are conditions of the region, which the planner evaluates where it
  chooses, at a scan or an index seek. Those that can raise (Cypher's type errors, arithmetic, values refused when met)
  filter the region's rows, so they see only the rows that match, as in smaltcy's engine.
- **Order.** Cypher gives rows no order without ORDER BY, but the compiler keeps the one it gave before wherever it
  shows: in the results, a `collect()` or a pattern comprehension's list, the rows a LIMIT keeps, the ties of an ORDER
  BY, the groups of an aggregate with keys, and the input of any aggregate but `count`. There a region's rows are
  sorted by the input's position (a window's `row_number`), then each scan's rowid and each union's part, the order
  smaltdb's `ordered` joins gave. Elsewhere (a count, EXISTS, what a grouping without keys reads) the plan asks for no
  order, so smaltdb joins and groups as its planner chooses, without the sorts an `ordered` join costs.
- **Variable length**, where the order of its rows doesn't show (a count, EXISTS), is a search from each row: smaltdb's
  `iterate`, its rows the row and the path so far (its last node, length and, where read, hops in `paths`' form), with a
  step per type and reading that seeks the edge table's `start` or `end` index at the path's last node, as a hop from a
  row does, `maxDepth` the maximum. Trail mode: the relationships on the path (their identities as `paths` makes them)
  are kept in a column each for a search of at most 8 hops (shifted along at each hop), else in a list, and none is
  walked twice; with no direction a self-loop is read once. Elsewhere it is smaltdb's `paths` in trail mode (no
  relationship twice), with `minHops` and `maxHops`, run
  for each row in a subquery (the row's node, as a one-row `values`, to `paths`; its paths imploded into a list, then
  exploded back into rows): `paths` runs its input twice, to search and to join its paths back, which here is a row of
  values, not the plan before it. `paths` reads a self-loop both ways with direction `both`, two paths the same: each
  path is kept once. A relationship property map is checked on every hop (none may lack it); its values must not read
  variables.
- **Shortest paths**, once both ends are bound: one shortest path (`shortestPath`) is smaltdb's `paths` to a `target`
  (its ADR 0040), in a correlated subquery: a breadth-first search over the graph's index in memory that stops when it
  reaches the far end. It searches from no hops, so a node's path to itself is the empty one, and a path shorter than
  the minimum is none, as in smaltcy's engine. (Until smaltdb `95189f6` it was an `iterate` written here, with a LIMIT
  of one row at the far end, because `paths` with `anyShortest` searched the whole graph first.) All shortest paths are `paths`
  with `allShortest` (acyclic), for each row as above, kept where they end at the other end. smaltcy's engine checks
  properties as it searches and gives nothing when the shortest path is shorter than the minimum, so a shortest path
  with properties, with a minimum above 1, or beside other relationships in its MATCH is refused.
- **Named paths** are the first node and the hops of their relationships in order; `length`, `nodes` and
  `relationships` read them, and a list comprehension over nodes or relationships reads each one's data in a subquery.
- **OPTIONAL MATCH** numbers its input's rows (a window's `row_number`), matches, and left-joins the input back by
  number, so a row with no match (or none passing the WHERE, which is part of the match) passes once with the new
  slots NULL. The input's plan is in the smaltdb plan twice, and is planned once for each: both are expected to give
  the same rows in the same order, as smaltdb's planner gives the same plan for the same plan and data (an
  assumption: the OPTIONAL MATCH tests pass, smaltdb doesn't document it).
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
  reads it); within a statement they count on. The largest is its table's last row: the runner asks for the table's
  rows by rowid from the last and takes the first, which smaltdb reads from the table's end, one row (a `max` over a
  scan of the table read every row, until 2026-11-21). **New labels and types** are added with `alterPropertyGraph`
  (`addLabel` / `addType`) the first time a write uses them; the reserved label `smaltcy:node` is refused.
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
  or `smalt_log_<table>`, scanned for it: the rowid is a column there, not their order), so an id a readable version
  holds is never given to another node or relationship, as smaltcy's ADR 0002 keeps ids stable across versions. A
  caller can also keep the next ids itself (`RunOptions.ids`, as smaltcy's store keeps them across statements, rolled
  back or not): ids then go on as smaltcy's do.

**Indexes.** smaltcy's `CREATE INDEX FOR (n:L) ON (n.k)` and `DROP INDEX ON :L(k)` (`IndexPlan`) run as smaltdb schema
statements: an expression index on the node table, on `map_get(props, k)`, named `<graph>_ix_<label>_<key>` with the
label and key in hex (smaltdb's names ignore case, Cypher's labels don't). The node table holds every node, so the
index holds the key's values of nodes of every label: an index can't be filtered by label, since labels live in the
label index, and a match by label stays a semi-join on it. Creating an index that exists and dropping one that doesn't
do nothing, as in smaltcy's stores. Indexes don't change results; on a graph that keeps history they don't change its
versions.

**Statements kept by shape** (`src/smaltdb/shape.ts`; smaltdb's issue 274, step 1). An application's queries differ
from each other in their values, and a plan with a value written into it is planned by smaltdb from nothing: 0.74 ms
for a seek that takes 0.06 ms when its text repeats (docs/research/benchmarks.md). So a query that only reads is
compiled with its strings and numbers taken out, a parameter in each one's place. What is left is its shape. The
statement smaltdb prepares for a shape (`Database.preparePlan`) is kept, 256 shapes a database, and run with each
query's values.

- **A parameter is compared as a literal of its kind is** (`paramKind`): a string, a whole number JavaScript holds
  exactly, or a float that isn't whole or NaN compiles to the plain comparison, which smaltdb seeks with an index and
  checks on a row's stored bytes before it decodes the row (for a parameter since smaltdb `1c2fce8`). The plan is then
  for values of those kinds, so a shape holds the kind of every value taken out and of every parameter given: a value
  of another kind is another statement.
- **What stays in a shape:** NULL, booleans and every other literal; the values inside a list or a map the query
  builds (`[1, 2]`, `{a: 1}`: smaltdb makes one once when all of it is written out, so an `IN` over it is a lookup, and
  types its elements by what is written; a pattern's property map is conditions, and its values are taken out); SKIP
  and LIMIT with their values, which the compiler checks as it compiles; the graph's labels and types with their
  tables.
- **Not kept:** a query that reads the past (its version is found before it is compiled), and one with more than 64
  values. Where the compiler needs a value written out (the direction and type of `degree()`), it refuses the query
  with its values taken out, and that shape is compiled as written from then on, as every query was before.
- **How a kept statement is found** (2026-11-21). The walk that takes a query's values out writes its shape as a list
  of tokens: the plan's names, strings and numbers in the order it meets them, a mark where a list or an object opens
  and closes, and a mark of its kind where a value was taken out. It hashes the tokens as it writes them. The query's
  statement is the one kept under that hash whose tokens are the same, so two shapes with one hash stay two
  statements. Until then the shape was a text, built for every query and looked up in a map: building it and hashing
  it took most of the time of finding a kept statement (6.5 µs for the benchmark's seek by name, 1.7 µs as tokens;
  docs/research/benchmarks.md, "A kept statement found by its tokens").
- **Writes** run with their statement's values as parameters too (`valuesOut`), so the queries the runner makes for
  one statement and for the next of its shape are the same to smaltdb, which keeps them by their text. The rows the
  runner itself holds (the ids it found, the values it computed, the rows it appends) are still written into its
  statements: each of those is planned again. That is the write path's own cost and step 4 of the issue's plan. The
  scans that found the largest ids were part of it until 2026-11-21. With the largest ids read from the tables' ends,
  creating 1 node went from 44x to 53x of smaltcy's time to 13x to 14x, and creating 1 relationship from 114x to 120x
  to 12x to 13x (three runs each way, in turns, on smaltdb `166c6cd`); with statements that differ each time, from 31x
  to 35x to 12x to 13x and from 47x to 59x to 14x to 16x.
- **A kept statement keeps its plan** until smaltdb plans it again (a schema change, or a table four times larger or
  smaller). A statement planned anew each time follows the data more closely: one case measures slower for it
  (docs/research/benchmarks.md, "Statements kept by shape").

It keeps Cypher's meaning:

- **Comparisons by kind:** `=` is NULL with a NULL and false across kinds (`true = 1` is false), `<` is NULL across
  kinds and for NaN; where a type is `any`, the kind is found when the query runs (`any_type`). A value of any kind
  (a property) compared with a string or number literal (an integer JavaScript holds exactly, or a float that isn't
  whole or NaN) is smaltdb's own comparison: `cmp_eq` has Cypher's `=` there (NULL with a NULL, false for a value of
  another kind, booleans, lists and maps included, NaN equal to nothing, `1 = 1.0`), and `<` and the others are
  smaltdb's comparisons within one kind (`cmp_lt_kind` and the others, since smaltdb `166c6cd`): the comparison where
  the value is of the literal's kind (a number that isn't NaN, or a string), else NULL. So a property map or a WHERE
  such as `{name: 'Ada'}` or `p.age > 30` reads the property once a row; smaltdb estimates an `=` and seeks it with
  an index on the property, and where it scans a table it decides either on the row's stored bytes (tested against
  smaltcy's engine on values of every kind, with and without an index). Until 2026-11-20 `<` and the others were a
  CASE over `any_type` around smaltdb's `cmp_lt`, which read the property three times for every row that passed
  (docs/research/benchmarks.md, "Comparisons within one kind").
- **Lists and maps** are compared element by element, as smaltcy's `equals` and `compare` do, where smaltdb compares
  their bytes: `=` of two lists is false for different lengths or a false element, else NULL for a NULL element
  (`[1, null] = [1, null]` is NULL), else true; of two maps, false for different keys, else their values in key order
  as a list's. `<` of two lists goes to the first pair of elements that differ (NULL where they don't compare: NULL,
  NaN, other kinds, maps), else the shorter is less; `<` of maps is NULL. The compiler goes through the elements with
  smaltdb's `each` (`list_len`, `list_get`, `list_slice`, `map_keys`, `map_values`; `any_list` and `any_map` for values
  under `any`), each element's kind found as a value's is. Its `each` expressions bind their elements as variables,
  given smaltdb's depths (`element`, `eachAgg`) once the expression is built, so they nest inside a list
  comprehension's; a value used more than once is computed once (an `each` over a list of it). **Nesting is bounded:**
  each level is its own part of the plan, so lists and maps are compared, and lists ordered, four levels deep
  (`NESTING`: a list of lists of lists of lists); a value nested deeper raises `Unsupported` when a row reaches it.
- **Booleans:** a predicate must be a boolean or NULL; anything else is Cypher's type error. Comparisons and logic are
  declared `bool`, so results give `true` and `false`.
- **Arithmetic:** 64-bit integers with checked operations (`add_checked` …); integer division truncates and division by
  zero is an error; `+` joins two strings. `+` of a string and a number or a boolean writes them as smaltcy's `add`
  does, with JavaScript's `String()`: `true`, `1` for `1.0`, `NaN`, `Infinity`, `1e+21`, the shortest digits that read
  back as the number. smaltdb's JSON of a list writes a number below 2^53 that way; for whole numbers from 2^53 the
  compiler picks those digits itself, as ECMAScript's Number::toString does (the fewest of the number's digits, or those
  digits plus one in the last place, that read back as it, `cast_real_strict`), in plain notation below 10^21, else in
  exponent notation. `+` of two lists joins them (`list_concat`), of a list and a value appends or prepends the value
  (NULL too: `[1] + null` is `[1, null]`), booleans and nested lists keeping their kind in a `list<any>`. `%` of two
  integers is smaltdb's 64-bit remainder; of anything else JavaScript's, as smaltcy's numbers are: `mod_floor` of the
  dividend and the divisor given the dividend's sign (`-0`'s too), which is JavaScript's `%` when both have the same
  sign; by zero NaN, or for two whole numbers smaltcy's error.
- **ORDER BY:** Cypher's order of kinds (maps, lists, strings, booleans, numbers, NaN), NULLs last ascending and first
  descending. A list is ordered by a key smaltdb orders as Cypher orders lists: a list of one struct per element, its
  kind's place, then its number or boolean, its string, or its own nested list's key (smaltdb compares lists element by
  element, the shorter first, and structs field by field). Maps, which smaltcy orders by a text of their entries
  (`groupKey`), raise `Unsupported` when a row reaches them, in a list too.
- **Aggregates:** `sum` of nothing is 0, `collect` leaves NULLs out, `min` and `max` across kinds follow Cypher's
  order, groups come in the order of their first row.
- **Quantifiers and list comprehensions** with Cypher's NULLs, over smaltdb's `each`.

What it can't compile yet it refuses with `Unsupported`, which names the feature. What it can compile but whose meaning
only the values show it can't keep (lists and maps nested more than four deep where they are compared or ordered, maps
in ORDER BY, `min` and `max`) raises an error when a row reaches it, never a different answer: smaltdb's `raise_error(message, code)`
(stenhoor/smaltdb#264), which raises only where a row reaches it, with `Unsupported`'s code (`SMALTCY_UNSUPPORTED`) and
message. Cypher's own errors that only the values show raise the same way with smaltcy's code and message, as its
engine words them: a predicate that isn't a boolean (`WHERE must be a boolean, not INTEGER`), arithmetic of other kinds
(`Can't add BOOLEAN and INTEGER`), a function given a value of the wrong kind (`sum() can't take a STRING`, `size()`,
`abs()`, `toUpper()`, `toLower()`, negation), iterating over a value that isn't a list, and division by zero
(`SMALTCY_TYPE`). The value's type in the message (`typeName`) is found from the value when the query runs.

**The tests.** `test/smaltdb-differential.test.ts` runs every read case of the Cypher suite on smaltdb, from the same
graph, and lists those the compiler refuses; the list can only shrink. `test/smaltdb-writes.test.ts` runs every write
case of the Cypher suite (`test/helpers/write-cases.ts`, which `test/cypher-write.test.ts` runs on smaltcy's engine) and
more sequences of writes on both engines, comparing after each statement the rows, the counts and the whole graph (ids,
labels in order, properties, relationships), statements that fail on both (smaltdb rolled back, new labels and types
included; the same error code and message as smaltcy's), and the writes it refuses. Two more sets run queries on both engines and
compare their rows: over properties of every kind (and the errors values of the wrong kind raise: the same code and
message on both), over labels and types spelled two ways (`Person` and `person`, `KNOWS` and `knows`, read and
written), and over relationships on a graph with self-loops, parallel
relationships of two types and a node with none (uniqueness, both directions, OPTIONAL MATCH with WHERE, type
alternatives, variable length, paths). A third runs EXISTS, pattern predicates and pattern comprehensions on that
graph: correlated on nodes and relationships, negated, nested, in OPTIONAL MATCH, with WHERE, in ORDER BY and
aggregates. A fourth compares lists and maps (`=`, `<>`, `<`, IN, CASE, in list comprehensions, ORDER BY, `min` and
`max`, nested, empty, with NULLs and mixed kinds, maps with other keys), `+` of lists, strings, numbers and booleans
(and `String()` of 300 numbers from 1e-300 to 1e300) and `%` of floats (negative operands, zero, NaN and infinities),
and the values it refuses when met. `test/smaltdb-history.test.ts` writes the histories of `test/history.test.ts` (random writes from a seed,
some in transactions of two statements, some failing; the social graph changing over four versions;
`test/helpers/history-cases.ts`) on both engines, checks that smaltdb commits exactly when smaltcy makes a version,
with its author and message, then reads every version with `AT VERSION` (nodes, relationships, a pattern) and each
commit's moment with `AT TIME` on both, before and after `forget`. The index test runs the same queries before and
after an index exists and checks smaltdb's catalog. Two more sets compare rows on both engines: properties of every kind
compared with string and number literals (with and without an index on the property, which EXPLAIN shows smaltdb seeks
with), and a generated network (`network(300)`), on which the compiled patterns (unions of edge tables, hops from a row,
anonymous ends, paths from each row, shortest paths by a search) give smaltcy's rows in any order. The relationship
cases include hops from either end, to a bound node, after a label, before a hop of one type, in `collect()` and under
a LIMIT, in the order smaltcy gives.

## The bar for switching (smaltdb ADR 0033, step 9)

The owner decided (2026-11-19): smaltcy moves onto smaltdb only when smaltdb is at least as fast as smaltcy's engine on
every query and write of its benchmarks (`npm run bench:smaltdb`, `BENCH_ENTRY=bench/writes.ts npm run
bench:smaltdb`), at 20,000 people. Where smaltdb stays slower, the case comes to the owner with the profile that says
why, and the significant benefit other than speed that pays for it; the owner accepts or refuses each such case.

The owner added (2026-11-20, stenhoor/smaltdb#274): statements that differ each time count too
(`BENCH_ENTRY=bench/vary.ts npm run bench:smaltdb`: every query and write that has a value to differ in, with the
value as a literal and as a parameter). The first two benchmarks run one text again and again, which smaltdb answers
from the statement it kept; an application's statements differ, and there smaltdb was furthest behind. smaltcy's
engine on its `MemoryStore` stays the bar; its `CsrStore`'s times are reported beside it. How a time and a ratio are
taken, and the baseline before that work: docs/research/benchmarks.md, "Method" and "Statements that differ".

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
- **Indexes are used for equality with a literal or a parameter.** A property map or a WHERE comparing a property
  with a string or a number, written in the query or given as a parameter, is the plain `map_get(props, k) = v` an
  index's expression matches, and smaltdb seeks with it (tests check EXPLAIN). A range (`<`) is still a CASE on the
  value's kind, which smaltdb doesn't seek with.
- **Performance** (docs/research/benchmarks.md, "smaltdb": `npm run bench:smaltdb`, 20,000 people): the join regions,
  the order asked for only where it shows, the comparisons with literals, the paths searched from each row and the
  shortest path's search that stops at its end made the benchmark's queries 1.3 to 16 times faster (shortest path
  459 to 57 ms, all relationships 96 to 6 ms, 3 hops 314 to 154 ms). Hops from a row then made the hops read both
  ways seek for each row: with the index on `:Person(name)` that smaltcy's store has, 1 hop 15.3 to 1.3 ms, 2 hops
  66.7 to 4.9 ms, 3 hops 121 to 36 ms, and 1 hop takes about as long at 2,000 people (0.9 ms) as at 20,000. A search
  from each row for variable length where the order doesn't show, nodes only counted left unread and hop rows without
  their constant columns took variable length 1..3 from 166 to 21 ms and 3 hops from 37 to 21 ms, and with smaltdb's
  edge indexes covering the other end (`(start, end)`, `(end, start)`) to 13 ms each. Most of what is left is
  smaltdb's:
  - Its planner estimated a comparison of an expression (`map_get(props, 'name') = 'Bo 1'`) at a third of the
    table's rows, with or without an index on it, so the rest of the pattern was joined with hashes over whole scans of
    the edge tables. smaltdb estimates it from the index now (stenhoor/smaltdb#266), and a pattern's edge tables of
    one type and direction are sought from the node found. It still knows nothing of the rows of a plan read as a FROM
    item (a list exploded: 1,000; a correlated subquery's list per row decoded and its fields read back cost more than
    the seeks, which is why a hop from a row is an `iterate` and not a subquery), and estimates an index seek by the
    rows per value (`indexedBy` above).
  - It assumes 1,000 rows for a FROM item that is a plan (a union of edge tables of 80,050 rows): two unions joined
    directly were joined with a nested loop (3 hops took 3.2 s), hence the node table between them.
  - `map_get` decodes the whole map on each call: a scan filtering 20,000 nodes on one property takes about 25 ms,
    against 5 ms for a scan of 40,000 relationships filtered on a column. Every query that starts from a property
    pays it, unless an index finds the node.
  - `paths` with `anyShortest` searches from the start until every node is reached, with no way to give it the end;
    `paths` runs its input twice. The compiler works around both (above).
- A write is many smaltdb statements: queries and writes for each row, as the runner streams rows the way smaltcy's
  engine does. That is slow on large inputs; set-based plans for writes that can't see each other (no reads between
  them) would be faster, and are left for later. The runner takes a synchronous `queryPlan` (smaltdb's `Database` in a
  worker), not the client's asynchronous one yet.
- **Writes refused** (`Unsupported`): the reserved label;
  DISTINCT with writes before and after it in one pipeline (smaltcy's passes rows on as they come); UNION with writes;
  MERGE with a parameter as a property map (the compiler's pattern maps); after a DELETE, `labels()`, `properties()`,
  `type()`, `startNode()`, `endNode()`, `nodes()` and `relationships()` (smaltcy's engine fails on a deleted node or
  relationship, smaltdb would give a value), and paths and lists of nodes or relationships in its results (smaltcy's
  engine gives a deleted one as an empty one, smaltdb's lists would drop it).
- An OPTIONAL MATCH puts its input's plan in the smaltdb plan twice, so a query's plan doubles with each one; smaltdb
  runs that input twice (above: both runs must give the same rows in the same order).
- `allShortestPaths` enumerates acyclic paths before ranking them, which can grow fast on a dense graph.
- Comparing and ordering values whose kind only the value shows (`any`, as properties are) compiles every kind they
  may be, lists and maps four levels down included, so those plans are larger: about 64 KB of plan JSON for `MATCH
  (n:T) RETURN n.v = n.v`, 17 KB before lists were compared (ORDER BY `n.v`: 29 KB, 9 KB before). Grouping, DISTINCT
  and `collect()` of values a static type says are lists or maps are still refused (`Unsupported`): smaltdb groups
  them by their bytes.
- **Known differences, recorded rather than hidden:**
  - A smaltdb map keeps its keys sorted, so `keys(n)` can't give them in the order they were set: it is refused.
  - smaltdb compares text by its UTF-8 bytes, smaltcy by UTF-16 code units: the order of characters above U+FFFF
    against U+E000 to U+FFFF differs. Not guarded.
  - Integers are 64-bit on smaltdb: an overflow is an error, where smaltcy's numbers become inexact floats.
  - `%` of two integers whose remainder is 0 with a negative dividend (`-4 % 2`) is `-0` in smaltcy (JavaScript's
    `%`) and `0` on smaltdb, whose integers have no `-0`; Cypher has no `-0`. Floats give `-0` on both.
  - A `-0.0` a write stores (`SET n.v = -0.0`, `CREATE (:T {v: $x})` with -0) is read back as `0` on smaltdb and as
    `-0` on smaltcy (found 2026-11-20; a query that only reads gives `-0` on both). Not guarded.
  - Strings in lists and maps compare as strings do: by UTF-8 bytes on smaltdb (above).
  - The errors above have smaltcy's codes and messages, and so do the runner's own checks (deleting a node with
    relationships, a relationship to NULL, values that can't be properties); the tests compare them. Errors smaltdb
    raises itself (an integer overflow, a limit) have smaltdb's codes and messages. Where several rows would fail, the
    one reported is the first the engine reaches, which can differ (the planner's order, below).
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
  - smaltcy's own engine didn't count a variable-length relationship's hops as used, so a hop it expanded after one in
    the same MATCH could bind one of them again. Fixed in its engine (`varExpand`); both engines now keep Cypher's
    uniqueness there (tested).
  - A pattern comprehension's list is in the order its pattern matches, which Cypher leaves open, as it does a
    MATCH's: smaltdb's goes by relationship type, then by relationship, smaltcy's store by relationship id. The
    elements are the same; the tests compare them in any order where the two can differ.
  - smaltdb's planner decides the order conditions are evaluated in. Conditions that can raise (a non-boolean in
    `WHERE`) see only the rows that match the pattern, but among several such conditions, or rows, the one that raises
    first can differ from smaltcy's. The cases tried agree; nothing guarantees it.
- Two workarounds for smaltdb's planner (a sort key that is an expression over a project or filter, and `values` with
  no rows) went once smaltdb fixed both (stenhoor/smaltdb#262): the compiler gives sort keys as expressions and an
  empty edge source as `values` with `rows: []`.
- A third workaround went once smaltdb fixed it (stenhoor/smaltdb#263): an `update` whose input joins the target with a
  `values` plan (`UPDATE … FROM`) failed with `SMALT_INTERNAL` ("the physical planner declined a write") when the
  join had `ordered: true`; the runner's SET joins with `ordered: true` again.
- A fourth workaround and a refusal went once smaltdb added what they lacked: errors were raised as a strict
  conversion of a `smaltcy:` message to an integer (`cast_integer_strict`, an `SMALT_MISMATCH` error; now
  `raise_error`, stenhoor/smaltdb#264), and graphs with labels or types that differ only in case were refused, when
  loaded or written, while smaltdb found them ignoring case (stenhoor/smaltdb#265 made them case-sensitive).
