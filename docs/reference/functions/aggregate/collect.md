---
description: 'The values as a list, in the order of the rows, without `null`s.'
---

# collect

```ebnf
collect ::= 'collect' '(' 'DISTINCT'? X ')'
```

The values as a list, in the order of the rows, without `null`s.

## Parameters

- `X`: any value, from each row

## Returns

A list.

## Examples

```cypher
MATCH (p:Person)-[:LIKES]->(t:Topic)
RETURN t.name AS topic, collect(p.name) AS people
ORDER BY topic
```

| topic | people |
| --- | --- |
| Algorithms | ["Ada","Alan","Donald","Edsger"] |
| Compilers | ["Grace","Frances","Margaret"] |
| Graphs | ["Edsger"] |
| Languages | ["Barbara","John","Ken"] |
| Networks | ["Radia","Tim"] |

## See also

- [UNWIND](../../cypher/unwind)
- [Aggregate functions](./)
