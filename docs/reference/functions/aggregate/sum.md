---
description: 'The sum of the values; 0 when there are none.'
---

# sum

```ebnf
sum ::= 'sum' '(' 'DISTINCT'? X ')'
```

The sum of the values; 0 when there are none.

- A value that isn't a number fails with `SMALTCY_TYPE`.

## Examples

```cypher
MATCH (:Person)-[k:KNOWS]->(:Person)
RETURN sum(k.since) AS total, sum(DISTINCT k.since) AS distinct_total
```

| total | distinct_total |
| --- | --- |
| 27349 | 21454 |

## See also

- [`avg`](./avg)
- [`count`](./count)
- [Aggregate functions](./)
