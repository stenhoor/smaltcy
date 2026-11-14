---
description: 'The number of elements in a list, characters in a string, keys in a map, or relationships in a path.'
---

# size

```ebnf
size ::= 'size' '(' X ')'
```

The number of elements in a list, characters in a string, keys in a map, or relationships in a path.

- A value of another type fails with `SMALTCY_TYPE`.

## Examples

```cypher
RETURN size([1, 2, 3]) AS list, size('graph') AS string, size({a: 1}) AS map, size([]) AS empty
```

| list | string | map | empty |
| --- | --- | --- | --- |
| 3 | 5 | 1 | 0 |

## See also

- [`isEmpty`](./isEmpty)
- [`length`](../graph/length)
- [List functions](./)
