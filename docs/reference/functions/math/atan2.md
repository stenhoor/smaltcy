---
description: 'The angle, in radians, of the point (`X`, `Y`) from the x-axis.'
---

# atan2

```ebnf
atan2 ::= 'atan2' '(' Y ',' X ')'
```

The angle, in radians, of the point (`X`, `Y`) from the x-axis.

## Examples

```cypher
RETURN atan2(1, 1) AS a, atan2(1, -1) AS b
```

| a | b |
| --- | --- |
| 0.785398163397 | 2.356194490192 |

## See also

- [`atan`](./atan)
- [Math functions](./)
