---
description: 'The smallest value, in Cypher''s order; `null` when there are none.'
---

# min

```ebnf
min ::= 'min' '(' 'DISTINCT'? X ')'
```

The smallest value, in Cypher's order; `null` when there are none.

## Examples

```cypher
MATCH (p:Person)
RETURN min(p.born) AS earliest, min(p.name) AS first_name
```

| earliest | first_name |
| --- | --- |
| 1815 | Ada |

## See also

- [`max`](./max)
- [Aggregate functions](./)
