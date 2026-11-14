---
description: 'The property keys of a node or relationship, or the keys of a map, as a list of strings.'
---

# keys

```ebnf
keys ::= 'keys' '(' X ')'
```

The property keys of a node or relationship, or the keys of a map, as a list of strings.

- A value of another type fails with `SMALTCY_TYPE`.

## Parameters

- `X`: a node, a relationship or a map

## Returns

A list of strings.

## Examples

```cypher
MATCH (p:Person {name: 'Ada'})
RETURN keys(p) AS node, keys({a: 1, b: 2}) AS map
```

| node | map |
| --- | --- |
| ["name","born"] | ["a","b"] |

## See also

- [`properties`](./properties)
- [Graph functions](./)
