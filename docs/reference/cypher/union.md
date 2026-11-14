---
description: 'UNION joins the rows of several queries, without repeats; UNION ALL keeps them.'
---

# UNION

`UNION` joins the rows of several queries that return the same columns, and drops repeated rows. `UNION ALL` keeps
them.

## Syntax

```railroad
query
```

```cypher
MATCH (p:Person) WHERE p.born < 1910 RETURN p.name AS name
UNION
MATCH (p:Person)-[:LIVES_IN]->(:City {name: 'Austin'}) RETURN p.name AS name
```

| name |
| --- |
| Ada |
| Grace |
| Edsger |

```cypher
MATCH (c:City) RETURN 'city' AS kind, count(*) AS n
UNION ALL
MATCH (t:Topic) RETURN 'topic' AS kind, count(*) AS n
```

| kind | n |
| --- | --- |
| city | 5 |
| topic | 5 |

## Errors

Every part returns the same columns, in the same order:

<!-- docs:error SMALTCY_SEMANTIC -->
```cypher
MATCH (p:Person) RETURN p.name AS name
UNION
MATCH (c:City) RETURN c.name AS city
```

`UNION` and `UNION ALL` can't be mixed in one query:

<!-- docs:error SMALTCY_SEMANTIC -->
```cypher
RETURN 1 AS x UNION RETURN 2 AS x UNION ALL RETURN 3 AS x
```

## Working demo

```cypher dataset=empty
CREATE (:Cat {name: 'Tom'}), (:Dog {name: 'Rex'}), (:Dog {name: 'Tom'});
MATCH (c:Cat) RETURN c.name AS name
UNION
MATCH (d:Dog) RETURN d.name AS name
```

| name |
| --- |
| Tom |
| Rex |

## See also

- [RETURN](./return): `DISTINCT` and ordering within one query.
