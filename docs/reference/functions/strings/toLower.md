---
description: 'The text in lower case.'
---

# toLower

```ebnf
toLower ::= 'toLower' '(' STRING ')'
```

The text in lower case.

## Examples

```cypher
MATCH (p:Person)
WHERE toLower(p.name) STARTS WITH 'a'
RETURN toLower(p.name) AS name
ORDER BY name
```

| name |
| --- |
| ada |
| alan |

## See also

- [`toUpper`](./toUpper)
- [String functions](./)
