---
description: 'The text with every occurrence of `FIND` replaced by `WITH`.'
---

# replace

```ebnf
replace ::= 'replace' '(' STRING ',' FIND ',' WITH ')'
```

The text with every occurrence of `FIND` replaced by `WITH`.

## Parameters

- `STRING`: text
- `FIND`: the text to find
- `WITH`: the text to put in its place

## Returns

A string.

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
