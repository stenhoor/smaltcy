---
description: 'The natural logarithm.'
---

# log

```ebnf
log ::= 'log' '(' X ')'
```

The natural logarithm.

## Parameters

- `X`: a number

## Returns

A number.

## Examples

```cypher
RETURN log(1) AS a, log(e()) AS b
```

| a | b |
| --- | --- |
| 0 | 1 |

## See also

- [`log10`](./log10)
- [`exp`](./exp)
- [Math functions](./)
