---
description: 'The node a relationship starts at.'
---

# startNode

```ebnf
startNode ::= 'startNode' '(' RELATIONSHIP ')'
```

The node a relationship starts at.

- A value of another type fails with `SMALTCY_TYPE`.

## Parameters

- `RELATIONSHIP`: a relationship

## Returns

A node.

## Examples

```cypher
MATCH (:Person {name: 'Alan'})-[k:KNOWS]-()
RETURN startNode(k).name AS from, endNode(k).name AS to
ORDER BY from, to
```

| from | to |
| --- | --- |
| Ada | Alan |
| Alan | Edsger |
| Alan | Grace |

## See also

- [`endNode`](./endNode)
- [Graph functions](./)
