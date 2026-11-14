---
description: 'The time now, in milliseconds since 1970 (UTC).'
---

# timestamp

```ebnf
timestamp ::= 'timestamp' '(' ')'
```

The time now, in milliseconds since 1970 (UTC).

## Examples

```cypher
RETURN timestamp() > 1700000000000 AS after_2023
```

| after_2023 |
| --- |
| true |

## See also

- [`commits`](../history/commits)
- [Other functions](./)
