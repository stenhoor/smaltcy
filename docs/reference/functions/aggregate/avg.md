---
description: 'The mean of the values; `null` when there are none.'
---

# avg

```ebnf
avg ::= 'avg' '(' 'DISTINCT'? X ')'
```

The mean of the values; `null` when there are none.

- A value that isn't a number fails with `SMALTCY_TYPE`.

## Parameters

- `X`: a number, from each row

## Returns

A float, or `null`.

## Examples

```cypher
MATCH (p:Person)-[:LIVES_IN]->(c:City)
RETURN c.name AS city, avg(p.born) AS mean_born
ORDER BY mean_born
```

| city | mean_born |
| --- | --- |
| London | 1894 |
| New York | 1925.666666666667 |
| Austin | 1930 |
| Palo Alto | 1936 |
| Boston | 1943.5 |

## See also

- [`sum`](./sum)
- [`stDev`](./stDev)
- [Aggregate functions](./)
