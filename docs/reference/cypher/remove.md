---
description: 'REMOVE takes properties and labels away from nodes and relationships.'
---

# REMOVE

`REMOVE` takes a property, or labels, away. Removing one that isn't there does nothing.

## Syntax

```railroad
remove-clause
remove-item
```

```cypher
MATCH (p:Person {name: 'Grace'})
REMOVE p.born
RETURN p.name, p.born
```

| p.name | p.born |
| --- | --- |
| Grace | null |

```cypher
MATCH (p:Person {name: 'Grace'})
SET p:Admiral:Pioneer
REMOVE p:Pioneer
RETURN labels(p) AS labels
```

| labels |
| --- |
| ["Person","Admiral"] |

`SET n.key = null` removes a property too.

## Errors

`REMOVE` takes a property or a label, not a whole node; `DELETE` deletes one:

<!-- docs:error SMALTCY_SYNTAX -->
```cypher
MATCH (p:Person {name: 'Grace'}) REMOVE p
```

## Working demo

```cypher dataset=empty
CREATE (:Task:Open {title: 'Write docs', draft: true}), (:Task:Open {title: 'Ship', draft: true});
MATCH (t:Task {title: 'Write docs'})
REMOVE t.draft, t:Open
RETURN t.title AS title, t.draft AS draft, labels(t) AS labels
```

| title | draft | labels |
| --- | --- | --- |
| Write docs | null | ["Task"] |

## See also

- [SET](./set) and [DELETE](./delete).
