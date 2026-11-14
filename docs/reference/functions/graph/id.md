---
description: 'The id of a node or relationship: the store''s integer.'
---

# id

```ebnf
id ::= 'id' '(' X ')'
```

The id of a node or relationship: the store's integer.

- Ids are the store's own. A node's id can change when the graph is loaded again, or when `CsrStore` is built: keep your own key in a property.
- A value of another type fails with `SMALTCY_TYPE`.

## Parameters

- `X`: a node or relationship

## Returns

An integer.

## Examples

```cypher
MATCH (p:Person {name: 'Ada'})-[k:KNOWS]->(q)
RETURN id(p) AS person, id(k) AS relationship
```

| person | relationship |
| --- | --- |
| 0 | 12 |

## See also

- [`elementId`](./elementId)
- [Graph functions](./)
