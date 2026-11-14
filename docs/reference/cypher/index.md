---
description: 'The Cypher smaltcy reads: statements, clauses, patterns, expressions, tokens and how tightly operators bind.'
---

# Cypher

smaltcy reads a subset of openCypher: the clauses and expressions most queries use. Anything outside it fails with
`SMALTCY_SYNTAX` or `SMALTCY_SEMANTIC`, never with a wrong answer. [Where it differs](../divergences) lists the known
differences, and the [functions](../functions) have their own reference.

## Statements

```railroad
statement
query
single-query
clause
```

A statement is one query, or an index command. A query is a list of clauses that runs top to bottom: each clause takes
the rows the one before it gives and gives rows to the next. A reading query ends with `RETURN`; a query that writes
may end with its last write. `UNION` joins the rows of several queries. `EXPLAIN` before a statement shows its plan
and doesn't run it. `AT VERSION` and `AT TIME` read a graph's past ([AT VERSION and AT TIME](./at)).

| Clause | What it does |
| --- | --- |
| [`MATCH`, `OPTIONAL MATCH`](./match) | Finds a pattern in the graph |
| [`WHERE`](./match#where) | Keeps the rows a condition holds for, after `MATCH`, `OPTIONAL MATCH` or `WITH` |
| [`RETURN`](./return) | The query's result: `DISTINCT`, `ORDER BY`, `SKIP`, `LIMIT` |
| [`WITH`](./with) | Passes rows on to the next part of the query, grouped, sorted or filtered |
| [`UNWIND`](./unwind) | One row per element of a list |
| [`CREATE`](./create) | Creates nodes and relationships |
| [`MERGE`](./merge) | Matches a pattern, or creates it when it isn't there |
| [`SET`](./set) | Sets properties and labels |
| [`REMOVE`](./remove) | Removes properties and labels |
| [`DELETE`, `DETACH DELETE`](./delete) | Deletes nodes, relationships and paths |
| [`UNION`](./union) | Joins the rows of several queries |
| [`CREATE INDEX`, `DROP INDEX`](./indexes) | Indexes on a label and a property |
| [`EXPLAIN`](./explain) | The plan of a statement, not its rows |
| [`AT VERSION`, `AT TIME`](./at) | Reads the graph as it was |

[Patterns](./patterns) and [expressions](./expressions) have pages of their own.

## Tokens

- **Names** (variables, labels, relationship types, property keys) are letters, digits and `_`, not starting with a
  digit: `p`, `Person`, `born_in`. In backquotes, any text: `` `full name` ``; two backquotes are one.
- **Keywords** and **function names** match in any case: `match`, `MATCH` and `Match` are the same. Names don't: `:Person`
  and `:person` are two labels.
- **Strings** are in single or double quotes, with backslash escapes: `\n`, `\t`, `\\`, `\'`, `\"`, `\uXXXX`.
- **Numbers**: `42`, `-7`, `2.5`, `1e3`, `0x1F`. A number with a point or an exponent is a float.
- **Parameters**: `$name`, or `` $`a name` ``: values passed with the query, never built into its text.
- **Comments**: `// to the end of the line` and `/* between these */`.

## How tightly operators bind

From loosest to tightest. Operators on the same line bind equally and group from the left.

| Operators | Kind |
| --- | --- |
| `OR` | Logic |
| `XOR` | Logic |
| `AND` | Logic |
| `NOT` | Logic |
| `=`, `<>`, `!=`, `<`, `<=`, `>`, `>=` | Comparison, which chains: `1 < x < 5` is `1 < x AND x < 5` |
| `STARTS WITH`, `ENDS WITH`, `CONTAINS`, `IN`, `=~`, `IS NULL`, `IS NOT NULL` | Strings, lists and nulls |
| `+`, `-` | Addition; `+` also joins strings and lists |
| `*`, `/`, `%` | Multiplication |
| `^` | Power |
| `-x`, `+x` | Sign |
| `x.key`, `x[i]`, `x[a..b]`, `x:Label` | Property, index, slice, label test |

```cypher
RETURN 1 + 2 * 3 AS a, (1 + 2) * 3 AS b, 2 ^ 3 ^ 2 AS c, 1 < 2 < 3 AS d, NOT false AND false AS e
```

| a | b | c | d | e |
| --- | --- | --- | --- | --- |
| 7 | 9 | 64 | true | false |

A parenthesized expression followed by `-[` starts a relationship, as in a pattern: `(x) - [1]` reads as
`(x)-[1]`. Write `(x) - ([1])` to subtract a list.

## Values

| Type | Examples | `valueType()` |
| --- | --- | --- |
| Null | `null` | `NULL` |
| Boolean | `true`, `false` | `BOOLEAN` |
| Integer | `42`, `0x1F` | `INTEGER` |
| Float | `2.5`, `1.5e-3` | `FLOAT` |
| String | `'Ada'` | `STRING` |
| List | `[1, 'two', null]` | `LIST` |
| Map | `{name: 'Ada', born: 1815}` | `MAP` |
| Node, relationship, path | from a pattern | `NODE`, `RELATIONSHIP`, `PATH` |

Numbers are JavaScript doubles: [Where it differs](../divergences#numbers) says how integers and floats behave.
`valueType()` names a number by its value, so a whole number written as a float, such as `7.0` or `1e3`, is
`INTEGER`.

```cypher
RETURN valueType(42) AS a, valueType(2.5) AS b, valueType('x') AS c, valueType([1]) AS d, valueType({k: 1}) AS e, valueType(null) AS f
```

| a | b | c | d | e | f |
| --- | --- | --- | --- | --- | --- |
| INTEGER | FLOAT | STRING | LIST | MAP | NULL |

## Working demo

A small graph and a query on it, from nothing: run it, then change the data or the question.

```cypher dataset=empty
CREATE (ada:Person {name: 'Ada', born: 1815}),
       (alan:Person {name: 'Alan', born: 1912}),
       (grace:Person {name: 'Grace', born: 1906}),
       (ada)-[:KNOWS {since: 1833}]->(alan),
       (alan)-[:KNOWS {since: 1936}]->(grace);
MATCH (a:Person)-[k:KNOWS]->(b:Person)
RETURN a.name AS from, b.name AS to, k.since AS since, b.born - a.born AS years_apart
ORDER BY since
```

| from | to | since | years_apart |
| --- | --- | --- | --- |
| Ada | Alan | 1833 | 97 |
| Alan | Grace | 1936 | -6 |

## See also

- [Patterns](./patterns) and [expressions](./expressions).
- [Functions](../functions): every function, by kind.
- [Where it differs](../divergences) from openCypher.
- The [playground](/playground): any query on any sample graph.
