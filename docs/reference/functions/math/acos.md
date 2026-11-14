---
description: 'The arccosine, in radians.'
---

# acos

```ebnf
acos ::= 'acos' '(' X ')'
```

The arccosine, in radians.

## Examples

```cypher
RETURN acos(1) AS a, acos(0) AS b
```

| a | b |
| --- | --- |
| 0 | 1.570796326795 |

## See also

- [`cos`](./cos)
- [Math functions](./)
