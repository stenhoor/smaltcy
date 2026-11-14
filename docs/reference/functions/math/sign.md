---
description: '-1, 0 or 1, as `X` is negative, zero or positive.'
---

# sign

```ebnf
sign ::= 'sign' '(' X ')'
```

-1, 0 or 1, as `X` is negative, zero or positive.

## Parameters

- `X`: a number

## Returns

-1, 0 or 1.

## Examples

```cypher
RETURN sign(-7) AS a, sign(0) AS b, sign(2.5) AS c
```

| a | b | c |
| --- | --- | --- |
| -1 | 0 | 1 |

## See also

- [`abs`](./abs)
- [Math functions](./)
