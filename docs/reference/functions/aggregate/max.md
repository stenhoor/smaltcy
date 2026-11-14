---
description: 'The largest value, in Cypher''s order; `null` when there are none.'
---

# max

```ebnf
max ::= 'max' '(' 'DISTINCT'? X ')'
```

The largest value, in Cypher's order; `null` when there are none.

## Parameters

- `X`: any value, from each row

## Returns

A value of the kind given, or `null`.

## Examples

```cypher
MATCH (p:Person)-[:LIVES_IN]->(c:City)
RETURN c.name AS city, max(p.born) AS latest
ORDER BY city
```

| city | latest |
| --- | --- |
| Austin | 1930 |
| Boston | 1951 |
| London | 1955 |
| New York | 1939 |
| Palo Alto | 1943 |

## See also

- [`min`](./min)
- [Aggregate functions](./)
