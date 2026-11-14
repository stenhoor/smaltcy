---
description: 'The arctangent, in radians.'
---

# atan

```ebnf
atan ::= 'atan' '(' X ')'
```

The arctangent, in radians.

## Examples

```cypher
RETURN atan(0) AS a, atan(1) AS b
```

| a | b |
| --- | --- |
| 0 | 0.785398163397 |

## See also

- [`atan2`](./atan2)
- [`tan`](./tan)
- [Math functions](./)
