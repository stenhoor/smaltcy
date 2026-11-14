---
description: 'The version the query reads.'
---

# version

```ebnf
version ::= 'version' '(' ')'
```

The version the query reads.

## Examples

```cypher dataset=ontology
RETURN version() AS latest
```

| latest |
| --- |
| 26 |

```cypher dataset=ontology
AT VERSION 10
RETURN version() AS read
```

| read |
| --- |
| 10 |

## See also

- [`commits`](./commits)
- [AT](../../cypher/at)
- [History functions](./)
