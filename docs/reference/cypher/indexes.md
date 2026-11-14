---
description: 'CREATE INDEX and DROP INDEX: indexes on a label and a property, for finding nodes by value.'
---

# CREATE INDEX and DROP INDEX

An index on a label and a property finds the nodes with a value without reading every node of the label. The match
planner uses one when a pattern or a `WHERE` asks for that label and an equal value. Results are the same with or
without it.

## Syntax

```railroad
create-index
drop-index
```

`CREATE INDEX FOR (n:Label) ON (n.key)` may have a name, which is only read, and `IF NOT EXISTS`. The older forms
`CREATE INDEX ON :Label(key)` and `DROP INDEX ON :Label(key)` work too. Creating an index that exists does nothing.

```cypher
CREATE INDEX city_name IF NOT EXISTS FOR (c:City) ON (c.name)
```

With the index, `EXPLAIN` shows the plan start with a `NodeIndexSeek`:

```cypher
EXPLAIN MATCH (c:City {name: 'London'})<-[:LIVES_IN]-(p) RETURN p.name
```

```cypher
DROP INDEX ON :City(name)
```

## Working demo

```cypher dataset=empty
UNWIND range(1, 500) AS i
CREATE (:Sensor {id: i, room: 'room ' + toString(i % 20)});
CREATE INDEX FOR (s:Sensor) ON (s.id);
MATCH (s:Sensor {id: 42})
RETURN s.id AS id, s.room AS room
```

| id | room |
| --- | --- |
| 42 | room 2 |

## See also

- [EXPLAIN](./explain): the plan a query gets.
- [Stores](../stores): how the stores keep indexes.
