---
description: 'The absolute value.'
---

# abs

```ebnf
abs ::= 'abs' '(' X ')'
```

The absolute value.

## Examples

```cypher
RETURN abs(-3) AS a, abs(2.5) AS b
```

| a | b |
| --- | --- |
| 3 | 2.5 |

## See also

- [`sign`](./sign)
- [Math functions](./)
