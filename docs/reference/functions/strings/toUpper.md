---
description: 'The text in upper case.'
---

# toUpper

```ebnf
toUpper ::= 'toUpper' '(' STRING ')'
```

The text in upper case.

## Examples

```cypher
RETURN toUpper('Ada') AS name
```

| name |
| --- |
| ADA |

## See also

- [`toLower`](./toLower)
- [String functions](./)
