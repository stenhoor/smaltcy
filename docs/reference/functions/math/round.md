---
description: '`X` rounded to the nearest whole number, or to `DIGITS` decimal places. Halves round away from zero.'
---

# round

```ebnf
round ::= 'round' '(' X (',' DIGITS)? ')'
```

`X` rounded to the nearest whole number, or to `DIGITS` decimal places. Halves round away from zero.

## Parameters

- `X`: a number
- `DIGITS`: optional: an integer, how many decimal places; negative rounds to tens, hundreds …

## Returns

A number.

## Examples

```cypher
RETURN round(2.5) AS a, round(-2.5) AS b, round(3.14159, 2) AS c, round(1234, -2) AS d
```

| a | b | c | d |
| --- | --- | --- | --- |
| 3 | -3 | 3.14 | 1200 |

## See also

- [`ceil`](./ceil)
- [`floor`](./floor)
- [Math functions](./)
