---
description: 'The number of relationships at a node: `DIRECTION` is `''out''`, `''in''` or `''both''` (the default), and `TYPE` counts only that type.'
---

# degree

```ebnf
degree ::= 'degree' '(' NODE (',' DIRECTION (',' TYPE)?)? ')'
```

The number of relationships at a node: `DIRECTION` is `'out'`, `'in'` or `'both'` (the default), and `TYPE` counts only that type.

- smaltcy's own: not openCypher. It reads the count from the store, without matching each relationship.
- Another direction fails with `SMALTCY_TYPE`.

## Parameters

- `NODE`: a node
- `DIRECTION`: optional: `'out'`, `'in'` or `'both'` (the default)
- `TYPE`: optional: a relationship type, as text

## Returns

An integer.

## Examples

```cypher
MATCH (p:Person)
RETURN p.name AS name, degree(p) AS all, degree(p, 'out', 'KNOWS') AS knows, degree(p, 'in', 'KNOWS') AS known_by
ORDER BY all DESC, name
LIMIT 4
```

| name | all | knows | known_by |
| --- | --- | --- | --- |
| Edsger | 7 | 1 | 3 |
| Alan | 5 | 2 | 1 |
| Barbara | 5 | 1 | 2 |
| Donald | 5 | 1 | 2 |

## See also

- [Graph functions](./)
