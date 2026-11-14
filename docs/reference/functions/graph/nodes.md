---
description: 'A path''s nodes, in order, as a list.'
---

# nodes

```ebnf
nodes ::= 'nodes' '(' PATH ')'
```

A path's nodes, in order, as a list.

- A value of another type fails with `SMALTCY_TYPE`.

## Parameters

- `PATH`: a path

## Returns

A list of nodes.

## Examples

```cypher
MATCH p = (:Person {name: 'Ada'})-[:KNOWS*2]->()
RETURN [n IN nodes(p) | n.name] AS names
ORDER BY names
```

| names |
| --- |
| ["Ada","Alan","Edsger"] |
| ["Ada","Alan","Grace"] |

## See also

- [`relationships`](./relationships)
- [`length`](./length)
- [Graph functions](./)
