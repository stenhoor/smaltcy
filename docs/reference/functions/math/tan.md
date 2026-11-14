---
description: 'The tangent of an angle in radians.'
---

# tan

```ebnf
tan ::= 'tan' '(' X ')'
```

The tangent of an angle in radians.

## Parameters

- `X`: a number

## Returns

A number.

## Examples

```cypher
RETURN tan(0) AS a, round(tan(pi() / 4), 6) AS b
```

| a | b |
| --- | --- |
| 0 | 1 |

## See also

- [`sin`](./sin)
- [`cos`](./cos)
- [`atan`](./atan)
- [Math functions](./)
