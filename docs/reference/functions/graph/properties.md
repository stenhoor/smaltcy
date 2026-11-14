---
description: 'The properties of a node or relationship, as a map. A map gives itself.'
---

# properties

```ebnf
properties ::= 'properties' '(' X ')'
```

The properties of a node or relationship, as a map. A map gives itself.

- A value of another type fails with `SMALTCY_TYPE`.

## Examples

```cypher
MATCH (p:Person {name: 'Ada'})-[k:KNOWS]->()
RETURN properties(p) AS person, properties(k) AS knows
```

| person | knows |
| --- | --- |
| {"name":"Ada","born":1815} | {"since":1833} |

## See also

- [`keys`](./keys)
- [Graph functions](./)
