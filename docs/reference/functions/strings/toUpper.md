---
description: 'The text in upper case.'
---

# toUpper

```ebnf
toUpper ::= 'toUpper' '(' STRING ')'
```

The text in upper case.

## Parameters

- `STRING`: text

## Returns

A string.

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
