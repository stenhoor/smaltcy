---
description: 'The last `N` characters of the text.'
---

# right

```ebnf
right ::= 'right' '(' STRING ',' N ')'
```

The last `N` characters of the text.

## Parameters

- `STRING`: text
- `N`: an integer: how many characters

## Returns

A string.

## Examples

```cypher
RETURN right('smaltcy', 2) AS ending, right('smaltcy', 0) AS none
```

| ending | none |
| --- | --- |
| cy |  |

## See also

- [`left`](./left)
- [`substring`](./substring)
- [String functions](./)
