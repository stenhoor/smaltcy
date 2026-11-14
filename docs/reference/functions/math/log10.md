---
description: 'The base-10 logarithm.'
---

# log10

```ebnf
log10 ::= 'log10' '(' X ')'
```

The base-10 logarithm.

## Parameters

- `X`: a number

## Returns

A number.

## Examples

```cypher
RETURN log10(1000) AS a, log10(1) AS b
```

| a | b |
| --- | --- |
| 3 | 0 |

## See also

- [`log`](./log)
- [Math functions](./)
