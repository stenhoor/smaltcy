---
description: 'A relationship''s type.'
---

# type

```ebnf
type ::= 'type' '(' RELATIONSHIP ')'
```

A relationship's type.

- A value of another type fails with `SMALTCY_TYPE`.

## Parameters

- `RELATIONSHIP`: a relationship

## Returns

A string.

## Examples

```cypher
MATCH (:Person {name: 'Edsger'})-[r]->(x)
RETURN type(r) AS type, x.name AS to
ORDER BY type, to
```

| type | to |
| --- | --- |
| KNOWS | Barbara |
| LIKES | Algorithms |
| LIKES | Graphs |
| LIVES_IN | Austin |

## See also

- [`labels`](./labels)
- [Graph functions](./)
