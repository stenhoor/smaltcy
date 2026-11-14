---
description: 'The number of rows, with `*`, or of values that aren''t `null`.'
---

# count

```ebnf
count ::= 'count' '(' ('*' | 'DISTINCT'? X) ')'
```

The number of rows, with `*`, or of values that aren't `null`.

## Parameters

- `X`: any value; `*` counts rows

## Returns

An integer.

## Examples

```cypher
MATCH (p:Person)
OPTIONAL MATCH (p)-[:LIKES]->(t:Topic {name: 'Algorithms'})
RETURN count(*) AS people, count(t) AS like_algorithms, count(DISTINCT p.born / 10) AS decades
```

| people | like_algorithms | decades |
| --- | --- | --- |
| 12 | 4 | 7 |

## See also

- [`sum`](./sum)
- [`collect`](./collect)
- [Aggregate functions](./)
