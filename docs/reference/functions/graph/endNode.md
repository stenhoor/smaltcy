---
description: 'The node a relationship ends at.'
---

# endNode

```ebnf
endNode ::= 'endNode' '(' RELATIONSHIP ')'
```

The node a relationship ends at.

- A value of another type fails with `SMALTCY_TYPE`.

## Examples

```cypher
MATCH (:Person {name: 'Ada'})-[k:KNOWS]->()
RETURN endNode(k).name AS knows
```

| knows |
| --- |
| Alan |

## See also

- [`startNode`](./startNode)
- [Graph functions](./)
