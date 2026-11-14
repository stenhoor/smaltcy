---
description: 'The smallest whole number not less than `X`.'
---

# ceil

```ebnf
ceil ::= 'ceil' '(' X ')'
```

The smallest whole number not less than `X`.

## Parameters

- `X`: a number

## Returns

A whole number.

## Examples

```cypher
RETURN ceil(2.1) AS a, ceil(-2.1) AS b
```

| a | b |
| --- | --- |
| 3 | -2 |

## See also

- [`floor`](./floor)
- [`round`](./round)
- [Math functions](./)
