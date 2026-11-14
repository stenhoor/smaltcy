---
description: 'A path''s relationships, in order, as a list.'
---

# relationships

```ebnf
relationships ::= 'relationships' '(' PATH ')'
```

A path's relationships, in order, as a list.

- A value of another type fails with `SMALTCY_TYPE`.

## Parameters

- `PATH`: a path

## Returns

A list of relationships.

## Examples

```cypher
MATCH p = (:Person {name: 'Ada'})-[:KNOWS*2]->()
RETURN [r IN relationships(p) | r.since] AS since
ORDER BY since
```

| since |
| --- |
| [1833,1936] |
| [1833,1940] |

## See also

- [`nodes`](./nodes)
- [`length`](./length)
- [Graph functions](./)
