---
description: 'The cosine of an angle in radians.'
---

# cos

```ebnf
cos ::= 'cos' '(' X ')'
```

The cosine of an angle in radians.

## Parameters

- `X`: a number

## Returns

A number.

## Examples

```cypher
RETURN cos(0) AS a, cos(pi()) AS b
```

| a | b |
| --- | --- |
| 1 | -1 |

## See also

- [`sin`](./sin)
- [`tan`](./tan)
- [`acos`](./acos)
- [Math functions](./)
