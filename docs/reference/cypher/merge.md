---
description: 'MERGE matches a whole pattern, or creates it when it is not there, with ON CREATE SET and ON MATCH SET.'
---

# MERGE

`MERGE` matches its pattern, as `MATCH` would, and creates the whole pattern when there's no match. `ON CREATE SET`
runs when it created, `ON MATCH SET` when it matched. Running it twice gives the same graph as running it once.

## Syntax

```railroad
merge-clause
set-item
```

## Get or create

```cypher
MERGE (t:Topic {name: 'Databases'})
ON CREATE SET t.created = true
RETURN t.name, t.created
```

| t.name | t.created |
| --- | --- |
| Databases | true |

Again, it matches the node it made: `ON MATCH SET` runs, not `ON CREATE SET`.

```cypher
MERGE (t:Topic {name: 'Databases'})
ON CREATE SET t.created = true
ON MATCH SET t.seen = true
RETURN t.name, t.created, t.seen
```

| t.name | t.created | t.seen |
| --- | --- | --- |
| Databases | true | true |

## Relationships between nodes you have

Match the ends first, then merge the relationship: only the relationship is created when it's missing.

```cypher
MATCH (a:Person {name: 'Ada'}), (t:Topic {name: 'Databases'})
MERGE (a)-[l:LIKES]->(t)
RETURN a.name, type(l) AS type, t.name
```

| a.name | type | t.name |
| --- | --- | --- |
| Ada | LIKES | Databases |

`MERGE (a:Person {name: 'Ada'})-[:LIKES]->(t:Topic {name: 'Databases'})` with no `MATCH` would look for the whole
path and, not finding it, create two new nodes as well.

## Errors

A relationship in `MERGE` needs exactly one type, and no variable length:

<!-- docs:error SMALTCY_SEMANTIC -->
```cypher
MERGE (:A)-[:R*]->(:B)
```

## Working demo

```cypher dataset=empty
UNWIND ['tea', 'cake', 'tea', 'jam', 'tea'] AS name
MERGE (i:Item {name: name})
ON CREATE SET i.orders = 1
ON MATCH SET i.orders = i.orders + 1;
MATCH (i:Item)
RETURN i.name AS item, i.orders AS orders
ORDER BY orders DESC, item
```

| item | orders |
| --- | --- |
| tea | 3 |
| cake | 1 |
| jam | 1 |

## See also

- [MATCH](./match) and [CREATE](./create), which `MERGE` combines.
- [SET](./set): the items `ON CREATE SET` and `ON MATCH SET` take.
