---
description: 'The part of the text from position `START` (the first is 0), `LENGTH` characters long, or to the end.'
---

# substring

```ebnf
substring ::= 'substring' '(' STRING ',' START (',' LENGTH)? ')'
```

The part of the text from position `START` (the first is 0), `LENGTH` characters long, or to the end.

- A negative `START` fails with `SMALTCY_TYPE`; a `LENGTH` past the end stops at the end.

## Examples

```cypher
RETURN substring('smaltcy', 5) AS a, substring('smaltcy', 2, 3) AS b, substring('smaltcy', 5, 10) AS c
```

| a | b | c |
| --- | --- | --- |
| cy | alt | cy |

## See also

- [`left`](./left)
- [`right`](./right)
- [String functions](./)
