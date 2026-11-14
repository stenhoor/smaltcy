---
description: 'The standard deviation of a sample: divided by *n* - 1. 0 for fewer than two values.'
---

# stDev

```ebnf
stDev ::= 'stDev' '(' 'DISTINCT'? X ')'
```

The standard deviation of a sample: divided by *n* - 1. 0 for fewer than two values.

- A value that isn't a number fails with `SMALTCY_TYPE`.

## Parameters

- `X`: a number, from each row

## Returns

A float.

## Examples

```cypher
UNWIND [2, 4, 4, 4, 5, 5, 7, 9] AS x
RETURN stDev(x) AS sample, stDevP(x) AS population
```

| sample | population |
| --- | --- |
| 2.138089935299 | 2 |

## See also

- [`stDevP`](./stDevP)
- [`avg`](./avg)
- [Aggregate functions](./)
