---
description: 'SET sets properties, replaces or adds to a node''s properties, and adds labels.'
---

# SET

`SET` changes the nodes and relationships the query has bound: a property, all the properties, or labels.

## Syntax

```railroad
set-clause
set-item
```

| Form | What it does |
| --- | --- |
| `SET n.key = value` | Sets one property; `null` removes it |
| `SET n = {map}` | Replaces every property with the map's |
| `SET n += {map}` | Sets the map's properties and keeps the others |
| `SET n:Label` | Adds a label |

## Properties

```cypher
MATCH (p:Person {name: 'Ada'})
SET p.field = 'mathematics', p.born = 1815
RETURN p.name, p.field
```

| p.name | p.field |
| --- | --- |
| Ada | mathematics |

Setting a property to `null` removes it:

```cypher
MATCH (p:Person {name: 'Ada'})
SET p.field = null
RETURN keys(p) AS keys
```

| keys |
| --- |
| ["name","born"] |

## Many at once

`+=` adds a map's properties; `=` replaces them all.

```cypher
MATCH (p:Person {name: 'Alan'})
SET p += {field: 'computing', country: 'UK'}
RETURN p.name, p.born, p.field, p.country
```

| p.name | p.born | p.field | p.country |
| --- | --- | --- | --- |
| Alan | 1912 | computing | UK |

```cypher
MATCH (c:City {name: 'Austin'})
SET c = {name: 'Austin', state: 'Texas'}
RETURN properties(c) AS properties
```

| properties |
| --- |
| {"name":"Austin","state":"Texas"} |

## Labels

```cypher
MATCH (p:Person)
WHERE p.born < 1910
SET p:Pioneer
RETURN p.name, labels(p) AS labels
ORDER BY p.name
```

| p.name | labels |
| --- | --- |
| Ada | ["Person","Pioneer"] |
| Grace | ["Person","Pioneer"] |

## Errors

`SET` takes a variable the query has bound:

<!-- docs:error SMALTCY_SEMANTIC -->
```cypher
MATCH (p:Person) SET q.x = 1
```

## Working demo

```cypher dataset=empty
CREATE (:Account {id: 1, balance: 100}), (:Account {id: 2, balance: 20});
MATCH (from:Account {id: 1}), (to:Account {id: 2})
SET from.balance = from.balance - 30, to.balance = to.balance + 30, to:Funded
RETURN from.balance AS from_balance, to.balance AS to_balance, labels(to) AS labels
```

| from_balance | to_balance | labels |
| --- | --- | --- |
| 70 | 50 | ["Account","Funded"] |

## See also

- [REMOVE](./remove): taking properties and labels away.
- [MERGE](./merge): `ON CREATE SET` and `ON MATCH SET`.
