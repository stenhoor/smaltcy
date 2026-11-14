---
description: 'The text without white space at its start.'
---

# ltrim

```ebnf
ltrim ::= 'ltrim' '(' STRING ')'
```

The text without white space at its start.

## Examples

```cypher
RETURN '[' + ltrim('  graph  ') + ']' AS trimmed
```

| trimmed |
| --- |
| [graph  ] |

## See also

- [`trim`](./trim)
- [`rtrim`](./rtrim)
- [String functions](./)
