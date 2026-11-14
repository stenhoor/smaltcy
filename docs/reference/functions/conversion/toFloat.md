---
description: 'A number or text as a float. Text that isn''t a number gives `null`.'
---

# toFloat

```ebnf
toFloat ::= 'toFloat' '(' X ')'
```

A number or text as a float. Text that isn't a number gives `null`.

- A `null` argument gives `null`. A value of another type fails with `SMALTCY_TYPE`.
- Dividing by `toFloat(x)` divides as floats: `toFloat(7) / 2` is `3.5`.

## Parameters

- `X`: a number or string

## Returns

A float, or `null` for text that isn't a number.

## Examples

```cypher
RETURN toFloat('2.5') AS a, toFloat(7) / 2 AS b, toFloat('1e3') AS c, toFloat('x') AS d
```

| a | b | c | d |
| --- | --- | --- | --- |
| 2.5 | 3.5 | 1000 | null |

## See also

- [`toInteger`](./toInteger)
- [Conversion functions](./)
