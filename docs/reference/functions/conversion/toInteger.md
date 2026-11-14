---
description: 'A number, text or boolean as an integer, cut towards zero. Text that isn''t a number gives `null`.'
---

# toInteger

```ebnf
toInteger ::= 'toInteger' '(' X ')'
```

A number, text or boolean as an integer, cut towards zero. Text that isn't a number gives `null`.

- A `null` argument gives `null`. A value of another type fails with `SMALTCY_TYPE`.

## Parameters

- `X`: a number, string or boolean

## Returns

An integer, or `null` for text that isn't a number.

## Examples

```cypher
RETURN toInteger('42') AS a, toInteger(' 7.9 ') AS b, toInteger(-2.5) AS c, toInteger(true) AS d, toInteger('x') AS e
```

| a | b | c | d | e |
| --- | --- | --- | --- | --- |
| 42 | 7 | -2 | 1 | null |

## See also

- [`toFloat`](./toFloat)
- [`toString`](./toString)
- [Conversion functions](./)
