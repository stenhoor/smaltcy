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
- **In results**, nodes, relationships, paths and lists of them are maps of their data, as smaltcy's engine gives them
  (`kind`, `id`, `labels` or `type`, `start` and `end`, `properties`; a path's `nodes` and `relationships`).
  `collect()` of nodes is a list of their ids.

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
graph, and lists those the compiler refuses; the list can only shrink. Two more sets run queries on both engines and
compare their rows: over properties of every kind, and over relationships on a graph with self-loops, parallel
relationships of two types and a node with none (uniqueness, both directions, OPTIONAL MATCH with WHERE, type
alternatives, variable length, paths).

## Consequences

- Reads compile now (55 of the 59 read cases). EXISTS and pattern predicates, pattern comprehensions, `keys()` (below)
  and writes are later slices.
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
  - Errors have smaltdb's codes and the `smaltcy:` messages above, not smaltcy's.
  - Where a `shortestPath` has several shortest paths, Cypher returns any one: smaltdb's may be another than
    smaltcy's.
  - A node's or relationship's `properties` in a result come back with their keys sorted (a smaltdb map), where
    smaltcy's keep the order they were set; the values are the same.
  - smaltcy's own engine doesn't count a variable-length relationship's hops as used, so a hop it expands after one in
    the same MATCH can bind one of them again; the compiler keeps Cypher's uniqueness (tested).
  - smaltdb's planner decides the order conditions are evaluated in; where a condition raises (a non-boolean in
    `WHERE`), a query could raise on smaltdb where smaltcy stops early. The cases tried agree; nothing guarantees it.
- smaltdb at the pinned commit fails on a sort key that is an expression over a project or filter (its planner's
  `rebind`), so the compiler projects sort keys into columns first; and on `values` with no rows unless they are given
  as `columns`, which the compiler does.
