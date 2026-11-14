---
description: 'The first argument that isn''t `null`, or `null` when they all are.'
---

# coalesce

```ebnf
coalesce ::= 'coalesce' '(' X (',' X)* ')'
```

The first argument that isn't `null`, or `null` when they all are.

## Parameters

- `X`: any values, one or more

## Returns

The first value that isn't `null`, or `null`.

## Examples

```cypher
MATCH (p:Person)
WHERE p.name IN ['Ada', 'Alan']
RETURN p.name AS name, coalesce(p.nickname, p.title, 'none') AS called
ORDER BY name
```

| name | called |
| --- | --- |
| Ada | none |
| Alan | none |

## See also

- [Other functions](./)
