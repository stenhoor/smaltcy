---
description: 'MATCH finds a pattern in the graph; OPTIONAL MATCH keeps rows that have no match; WHERE filters.'
---

# MATCH

`MATCH` finds every place in the graph where a pattern fits, and gives one row for each, with the pattern's variables
bound. `OPTIONAL MATCH` keeps a row that has no match, with the new variables `null`.

## Syntax

```railroad
match-clause
pattern
```

The [patterns](./patterns) page has the parts of a pattern: nodes, relationships, variable lengths, named and
shortest paths.

## Finding nodes and relationships

```cypher
MATCH (p:Person {name: 'Ada'})
RETURN p.name, p.born
```

| p.name | p.born |
| --- | --- |
| Ada | 1815 |

A pattern with several parts, separated by commas, matches all of them at once. A variable used twice is the same node
both times:

```cypher
MATCH (a:Person)-[:LIVES_IN]->(c:City), (b:Person)-[:LIVES_IN]->(c)
WHERE a.name = 'Ada' AND b <> a
RETURN b.name AS neighbour, c.name AS city
```

| neighbour | city |
| --- | --- |
| Alan | London |
| Tim | London |

Within one `MATCH`, a relationship is used at most once in a row, so a path never goes back over the same
relationship. Several `MATCH` clauses each start again: the second may use the relationships the first used.

## WHERE {#where}

`WHERE` after a `MATCH` keeps the rows its condition is true for. A condition that is `null` drops the row, as
`false` does.

```cypher
MATCH (p:Person)-[k:KNOWS]->(q:Person)
WHERE k.since < 1950 AND q.born > 1900
RETURN p.name, q.name, k.since
ORDER BY k.since
```

| p.name | q.name | k.since |
| --- | --- | --- |
| Ada | Alan | 1833 |
| Alan | Grace | 1936 |
| Alan | Edsger | 1940 |

A pattern can be a condition: `(p)-[:LIKES]->(:Topic {name: 'Graphs'})` is true when such a relationship exists.
`EXISTS { MATCH … WHERE … }` takes a whole pattern with its own `WHERE`.

```cypher
MATCH (p:Person)
WHERE (p)-[:LIKES]->(:Topic {name: 'Algorithms'}) AND NOT EXISTS { MATCH (p)-[:KNOWS]->(q) WHERE q.born < 1900 }
RETURN p.name
ORDER BY p.name
```

| p.name |
| --- |
| Ada |
| Alan |
| Donald |
| Edsger |

## OPTIONAL MATCH

A row with no match keeps going, with the new variables `null`. Without `OPTIONAL`, it would be dropped.

```cypher
MATCH (p:Person)
WHERE p.born > 1945
OPTIONAL MATCH (p)-[:KNOWS]->(q:Person)
RETURN p.name, q.name
ORDER BY p.name
```

| p.name | q.name |
| --- | --- |
| Radia | Barbara |
| Tim | Radia |

`WHERE` after `OPTIONAL MATCH` belongs to it: a row where the condition fails still keeps going, with `null`.

```cypher
MATCH (p:Person)
WHERE p.name IN ['Ada', 'Alan']
OPTIONAL MATCH (p)-[k:KNOWS]->(q)
WHERE k.since > 1935
RETURN p.name, q.name
ORDER BY p.name, q.name
```

| p.name | q.name |
| --- | --- |
| Ada | null |
| Alan | Edsger |
| Alan | Grace |

## Errors

A variable must be bound before it's used: `SMALTCY_SEMANTIC`.

<!-- docs:error SMALTCY_SEMANTIC -->
```cypher
MATCH (p:Person) WHERE q.born > 1900 RETURN p
```

A query can't end with `MATCH`: add `RETURN`.

<!-- docs:error SMALTCY_SEMANTIC -->
```cypher
MATCH (p:Person)
```

## Working demo

```cypher dataset=empty
CREATE (:Person {name: 'Ann'})-[:WORKS_ON]->(:Project {name: 'Atlas'}),
       (:Person {name: 'Ben'})-[:WORKS_ON]->(:Project {name: 'Beacon'}),
       (:Person {name: 'Cat'});
MATCH (p:Person)
OPTIONAL MATCH (p)-[:WORKS_ON]->(pr:Project)
RETURN p.name AS person, pr.name AS project
ORDER BY person
```

| person | project |
| --- | --- |
| Ann | Atlas |
| Ben | Beacon |
| Cat | null |

## See also

- [Patterns](./patterns): what a pattern can say.
- [WITH](./with): filtering on what a query has counted, with `WITH … WHERE`.
- [Indexes](./indexes): finding nodes by a property without reading every node of a label.
