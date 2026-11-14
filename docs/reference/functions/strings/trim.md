---
description: 'The text without white space at either end.'
---

# trim

```ebnf
trim ::= 'trim' '(' STRING ')'
```

The text without white space at either end.

## Parameters

- `STRING`: text

## Returns

A string.

## Examples

```cypher
RETURN '[' + trim('  graph  ') + ']' AS trimmed
```

| trimmed |
| --- |
| [graph] |

## See also

- [`ltrim`](./ltrim)
- [`rtrim`](./rtrim)
- [String functions](./)
