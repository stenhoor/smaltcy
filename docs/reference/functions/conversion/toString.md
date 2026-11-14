---
description: 'A number, boolean or string as text. A whole-number float keeps its point: `toString(2.0)` is `''2.0''`.'
---

# toString

```ebnf
toString ::= 'toString' '(' X ')'
```

A number, boolean or string as text. A whole-number float keeps its point: `toString(2.0)` is `'2.0'`.

- A `null` argument gives `null`. A value of another type fails with `SMALTCY_TYPE`.

## Parameters

- `X`: a number, boolean or string

## Returns

A string.

## Examples

```cypher
RETURN toString(42) AS a, toString(2.5) AS b, toString(true) AS c, toString(7.0 / 2) AS d, toString(2.0) AS e
```

| a | b | c | d | e |
| --- | --- | --- | --- | --- |
| 42 | 2.5 | true | 3.5 | 2.0 |

## See also

- [`toInteger`](./toInteger)
- [`toFloat`](./toFloat)
- [Conversion functions](./)
