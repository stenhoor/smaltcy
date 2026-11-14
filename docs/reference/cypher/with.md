---
description: 'WITH passes rows on to the next part of a query: projected, grouped, sorted, limited and filtered.'
---

# WITH

`WITH` ends one part of a query and starts the next. It is a `RETURN` in the middle: it projects, groups, sorts and
limits the rows, and only the names it passes on stay in scope. A `WHERE` after it filters what it gives.

## Syntax

```railroad
with-clause
projection
```

## Filtering on an aggregate

```cypher
MATCH (p:Person)-[:KNOWS]-(q:Person)
WITH p, count(q) AS friends
WHERE friends >= 3
RETURN p.name AS name, friends
ORDER BY friends DESC, name
```

| name | friends |
| --- | --- |
| Edsger | 4 |
| Alan | 3 |
| Barbara | 3 |
| Donald | 3 |
| Grace | 3 |
| Radia | 3 |

## Passing on what you need

Every expression in `WITH` needs an alias; a variable passes on as itself. Names it doesn't pass on are gone.

```cypher
MATCH (p:Person)-[:LIVES_IN]->(c:City)
WITH c.name AS city, collect(p.name) AS people
WITH city, people, size(people) AS n
WHERE n > 2
RETURN city, people
ORDER BY city
```

| city | people |
| --- | --- |
| London | ["Ada","Alan","Tim"] |
| New York | ["Grace","Barbara","Frances"] |
| Palo Alto | ["Donald","John","Ken"] |

## Top results, then more matching

`ORDER BY` and `LIMIT` in `WITH` pick rows before the query goes on:

```cypher
MATCH (p:Person)
WITH p ORDER BY p.born LIMIT 2
MATCH (p)-[:LIKES]->(t:Topic)
RETURN p.name AS name, t.name AS topic
```

| name | topic |
| --- | --- |
| Ada | Algorithms |
| Grace | Compilers |

## Errors

An expression in `WITH` needs `AS`:

<!-- docs:error SMALTCY_SEMANTIC -->
```cypher
MATCH (p:Person) WITH p.name RETURN 1
```

A query can't end with `WITH`:

<!-- docs:error SMALTCY_SEMANTIC -->
```cypher
MATCH (p:Person) WITH p
```

## Working demo

```cypher dataset=empty
CREATE (a:Author {name: 'Ann'}), (b:Author {name: 'Ben'}),
       (a)-[:WROTE]->(:Book {title: 'Graphs', year: 2019}),
       (a)-[:WROTE]->(:Book {title: 'Paths', year: 2022}),
       (b)-[:WROTE]->(:Book {title: 'Nodes', year: 2021});
MATCH (a:Author)-[:WROTE]->(b:Book)
WITH a, count(b) AS books, max(b.year) AS latest
WHERE books > 1
RETURN a.name AS author, books, latest
```

| author | books | latest |
| --- | --- | --- |
| Ann | 2 | 2022 |

## See also

- [RETURN](./return): the same projection, at the end of a query.
- [UNWIND](./unwind): one row per element of a list.
