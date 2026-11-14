---
description: 'The first `N` characters of the text.'
---

# left

```ebnf
left ::= 'left' '(' STRING ',' N ')'
```

The first `N` characters of the text.

## Examples

```cypher
RETURN left('smaltcy', 5) AS start
```

| start |
| --- |
| smalt |

## See also

- [`right`](./right)
- [`substring`](./substring)
- [String functions](./)
