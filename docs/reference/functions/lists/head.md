---
description: 'A list''s first element, or `null` for an empty list.'
---

# head

```ebnf
head ::= 'head' '(' LIST ')'
```

A list's first element, or `null` for an empty list.

- A value of another type fails with `SMALTCY_TYPE`.

## Examples

```cypher
RETURN head([1, 2, 3]) AS first, head([]) AS none
```

| first | none |
| --- | --- |
| 1 | null |

## See also

- [`last`](./last)
- [`tail`](./tail)
- [List functions](./)
