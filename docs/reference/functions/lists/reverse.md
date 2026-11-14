---
description: 'A list in reverse order, or a string with its characters reversed.'
---

# reverse

```ebnf
reverse ::= 'reverse' '(' X ')'
```

A list in reverse order, or a string with its characters reversed.

- A value of another type fails with `SMALTCY_TYPE`.

## Parameters

- `X`: a list or a string

## Returns

A list or a string, as given.

## Examples

```cypher
RETURN reverse([1, 2, 3]) AS list, reverse('graph') AS string
```

| list | string |
| --- | --- |
| [3,2,1] | hparg |

## See also

- [List functions](./)
