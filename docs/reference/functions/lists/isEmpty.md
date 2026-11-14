---
description: 'True when a list, string or map has nothing in it.'
---

# isEmpty

```ebnf
isEmpty ::= 'isEmpty' '(' X ')'
```

True when a list, string or map has nothing in it.

- A value of another type fails with `SMALTCY_TYPE`.

## Examples

```cypher
RETURN isEmpty([]) AS list, isEmpty('') AS string, isEmpty({}) AS map, isEmpty([0]) AS not_empty
```

| list | string | map | not_empty |
| --- | --- | --- | --- |
| true | true | true | false |

## See also

- [`size`](./size)
- [List functions](./)
