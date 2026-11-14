---
description: 'True when a property is there (isn''t `null`). `exists(n.key)` is `n.key IS NOT NULL`.'
---

# exists

```ebnf
exists ::= 'exists' '(' PROPERTY ')'
```

True when a property is there (isn't `null`). `exists(n.key)` is `n.key IS NOT NULL`.

- To test for a pattern, write the pattern as a condition, or `EXISTS { … }` ([expressions](../../cypher/expressions#patterns-as-conditions)). Another argument fails with `SMALTCY_SEMANTIC`.

## Examples

```cypher
MATCH (p:Person)-[k:KNOWS]->(q)
WHERE p.name = 'Ada'
RETURN exists(k.since) AS has_since, exists(k.until) AS has_until
```

| has_since | has_until |
| --- | --- |
| true | false |

## See also

- [Other functions](./)
