---
description: 'EXPLAIN shows the plan of a statement without running it.'
---

# EXPLAIN

`EXPLAIN` before a statement gives its plan, and doesn't run it: one line for each step, the step that reads first at
the bottom. The steps are smaltcy's own ([plans](../plans)).

## Syntax

```railroad
statement
```

```cypher
EXPLAIN MATCH (p:Person)-[:KNOWS]->(q:Person) WHERE p.born < 1900 RETURN q.name
```

A statement that writes isn't run either:

```cypher
EXPLAIN MATCH (p:Person {name: 'Ada'}) SET p.field = 'mathematics'
```

From code, `db.explain(cypher)` gives the same text, and `db.run` returns the plan it ran as `plan`.

## Working demo

```cypher dataset=empty
CREATE (:Station {name: 'North'})-[:LINE {minutes: 4}]->(:Station {name: 'Centre'})-[:LINE {minutes: 3}]->(:Station {name: 'South'});
EXPLAIN MATCH p = shortestPath((a:Station {name: 'North'})-[:LINE*]->(b:Station {name: 'South'})) RETURN p
```

## See also

- [Plans](../plans): the plan format and its steps.
- [CREATE INDEX](./indexes): a plan that seeks rather than scans.
