---
description: '*e* to the power `X`.'
---

# exp

```ebnf
exp ::= 'exp' '(' X ')'
```

*e* to the power `X`.

## Examples

```cypher
RETURN exp(0) AS a, exp(1) AS b
```

| a | b |
| --- | --- |
| 1 | 2.718281828459 |

## See also

- [`log`](./log)
- [`e`](./e)
- [Math functions](./)
