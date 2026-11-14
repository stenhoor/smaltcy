---
description: 'π.'
---

# pi

```ebnf
pi ::= 'pi' '(' ')'
```

π.

## Parameters

None.

## Returns

A float.

## Examples

```cypher
RETURN pi() AS pi, round(2 * pi() * 3, 2) AS circumference
```

| pi | circumference |
| --- | --- |
| 3.14159265359 | 18.85 |

## See also

- [`e`](./e)
- [Math functions](./)
