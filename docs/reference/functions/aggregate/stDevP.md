---
description: 'The standard deviation of a whole population: divided by *n*. 0 for no values.'
---

# stDevP

```ebnf
stDevP ::= 'stDevP' '(' 'DISTINCT'? X ')'
```

The standard deviation of a whole population: divided by *n*. 0 for no values.

- A value that isn't a number fails with `SMALTCY_TYPE`.

## Parameters

- `X`: a number, from each row

## Returns

A float.

## Examples

```cypher
MATCH (p:Person)
RETURN round(stDevP(p.born), 2) AS spread
```

| spread |
| --- |
| 35.44 |

## See also

- [`stDev`](./stDev)
- [Aggregate functions](./)
