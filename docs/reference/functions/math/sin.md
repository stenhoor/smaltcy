---
description: 'The sine of an angle in radians.'
---

# sin

```ebnf
sin ::= 'sin' '(' X ')'
```

The sine of an angle in radians.

## Examples

```cypher
RETURN sin(0) AS a, sin(pi() / 2) AS b
```

| a | b |
| --- | --- |
| 0 | 1 |

## See also

- [`cos`](./cos)
- [`tan`](./tan)
- [`asin`](./asin)
- [Math functions](./)
