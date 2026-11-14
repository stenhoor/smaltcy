---
description: 'The square root; `NaN` for a negative number.'
---

# sqrt

```ebnf
sqrt ::= 'sqrt' '(' X ')'
```

The square root; `NaN` for a negative number.

## Parameters

- `X`: a number

## Returns

A number.

## Examples

```cypher
RETURN sqrt(16) AS a, sqrt(2) AS b
```

| a | b |
| --- | --- |
| 4 | 1.414213562373 |

## See also

- [`exp`](./exp)
- [Math functions](./)
