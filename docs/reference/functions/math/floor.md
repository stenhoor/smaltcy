---
description: 'The largest whole number not more than `X`.'
---

# floor

```ebnf
floor ::= 'floor' '(' X ')'
```

The largest whole number not more than `X`.

## Parameters

- `X`: a number

## Returns

A whole number.

## Examples

```cypher
RETURN floor(2.9) AS a, floor(-2.1) AS b
```

| a | b |
| --- | --- |
| 2 | -3 |

## See also

- [`ceil`](./ceil)
- [`round`](./round)
- [Math functions](./)
