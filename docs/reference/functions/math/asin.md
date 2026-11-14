---
description: 'The arcsine, in radians.'
---

# asin

```ebnf
asin ::= 'asin' '(' X ')'
```

The arcsine, in radians.

## Parameters

- `X`: a number

## Returns

A number.

## Examples

```cypher
RETURN asin(0) AS a, asin(1) AS b
```

| a | b |
| --- | --- |
| 0 | 1.570796326795 |

## See also

- [`sin`](./sin)
- [Math functions](./)
