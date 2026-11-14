---
description: 'A list without its first element.'
---

# tail

```ebnf
tail ::= 'tail' '(' LIST ')'
```

A list without its first element.

- A value of another type fails with `SMALTCY_TYPE`.

## Parameters

- `LIST`: a list

## Returns

A list.

## Examples

```cypher
RETURN tail([1, 2, 3]) AS rest, tail([]) AS none
```

| rest | none |
| --- | --- |
| [2,3] | [] |

## See also

- [`head`](./head)
- [List functions](./)
