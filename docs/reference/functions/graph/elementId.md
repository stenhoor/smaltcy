---
description: 'The id of a node or relationship as text: `n` and the id for a node, `r` and the id for a relationship.'
---

# elementId

```ebnf
elementId ::= 'elementId' '(' X ')'
```

The id of a node or relationship as text: `n` and the id for a node, `r` and the id for a relationship.

- A value of another type fails with `SMALTCY_TYPE`.

## Examples

```cypher
MATCH (p:Person {name: 'Ada'})-[k:KNOWS]->()
RETURN elementId(p) AS node, elementId(k) AS relationship
```

| node | relationship |
| --- | --- |
| n0 | r12 |

## See also

- [`id`](./id)
- [Graph functions](./)
