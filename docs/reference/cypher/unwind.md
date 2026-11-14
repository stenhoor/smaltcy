---
description: 'UNWIND makes one row for each element of a list.'
---

# UNWIND

`UNWIND list AS x` gives one row for each element of the list, with `x` bound to it. An empty list, or `null`, gives
no rows. A value that isn't a list gives one row.

## Syntax

```railroad
unwind-clause
```

```cypher
UNWIND [1, 2, 3] AS n
RETURN n, n * n AS square
```

| n | square |
| --- | --- |
| 1 | 1 |
| 2 | 4 |
| 3 | 9 |

A list made earlier in the query, turned back into rows:

```cypher
MATCH (p:Person)-[:LIVES_IN]->(c:City {name: 'London'})
WITH collect(p.name) AS names
UNWIND names AS name
RETURN name
ORDER BY name
```

| name |
| --- |
| Ada |
| Alan |
| Tim |

With a parameter, `UNWIND $rows AS row CREATE (:Item {name: row.name})` creates a node for each map in a list: one
statement for a whole batch.

## Errors

The name after `AS` must be new:

<!-- docs:error SMALTCY_SEMANTIC -->
```cypher
MATCH (p:Person) UNWIND [1, 2] AS p RETURN p
```

## Working demo

```cypher dataset=empty
UNWIND [{name: 'tea', price: 3}, {name: 'cake', price: 4}, {name: 'jam', price: 5}] AS row
CREATE (:Item {name: row.name, price: row.price});
MATCH (i:Item)
UNWIND range(1, 2) AS quantity
RETURN i.name AS item, quantity, i.price * quantity AS total
ORDER BY item, quantity
```

| item | quantity | total |
| --- | --- | --- |
| cake | 1 | 4 |
| cake | 2 | 8 |
| jam | 1 | 5 |
| jam | 2 | 10 |
| tea | 1 | 3 |
| tea | 2 | 6 |

## See also

- [Functions](../functions): `range()`, `collect()` and the list functions.
- [CREATE](./create): writing a batch of rows.
