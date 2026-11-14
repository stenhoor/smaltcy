---
description: 'The text without white space at its end.'
---

# rtrim

```ebnf
rtrim ::= 'rtrim' '(' STRING ')'
```

The text without white space at its end.

## Examples

```cypher
RETURN '[' + rtrim('  graph  ') + ']' AS trimmed
```

| trimmed |
| --- |
| [  graph] |

## See also

- [`trim`](./trim)
- [`ltrim`](./ltrim)
- [String functions](./)
