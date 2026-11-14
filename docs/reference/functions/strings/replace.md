---
description: 'The text with every occurrence of `FIND` replaced by `WITH`.'
---

# replace

```ebnf
replace ::= 'replace' '(' STRING ',' FIND ',' WITH ')'
```

The text with every occurrence of `FIND` replaced by `WITH`.

## Examples

```cypher
RETURN replace('a-b-c', '-', ' / ') AS replaced
```

| replaced |
| --- |
| a / b / c |

## See also

- [`split`](./split)
- [String functions](./)
