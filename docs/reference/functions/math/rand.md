---
description: 'A random float from 0 up to, not including, 1: a new one each call.'
---

# rand

```ebnf
rand ::= 'rand' '(' ')'
```

A random float from 0 up to, not including, 1: a new one each call.

## Examples

```cypher
UNWIND range(1, 1000) AS i
WITH rand() AS r
RETURN min(r) >= 0 AS from_zero, max(r) < 1 AS below_one
```

| from_zero | below_one |
| --- | --- |
| true | true |

## See also

- [Math functions](./)
