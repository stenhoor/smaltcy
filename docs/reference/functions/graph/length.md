---
description: 'The number of relationships in a path. On a string or a list, its size.'
---

# length

```ebnf
length ::= 'length' '(' PATH ')'
```

The number of relationships in a path. On a string or a list, its size.

## Examples

```cypher
MATCH p = shortestPath((:Person {name: 'Ada'})-[:KNOWS*]-(:Person {name: 'Radia'}))
RETURN length(p) AS hops
```

| hops |
| --- |
| 4 |

## See also

- [`nodes`](./nodes)
- [`size`](../lists/size)
- [Graph functions](./)
