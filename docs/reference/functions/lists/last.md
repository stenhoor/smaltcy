---
description: 'A list''s last element, or `null` for an empty list.'
---

# last

```ebnf
last ::= 'last' '(' LIST ')'
```

A list's last element, or `null` for an empty list.

- A value of another type fails with `SMALTCY_TYPE`.

## Parameters

- `LIST`: a list

## Returns

The last element, or `null`.

## Examples

```cypher
RETURN last([1, 2, 3]) AS last, last([]) AS none
```

| last | none |
| --- | --- |
| 3 | null |

## See also

- [`head`](./head)
- [List functions](./)
