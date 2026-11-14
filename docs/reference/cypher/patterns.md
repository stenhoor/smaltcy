---
description: 'Patterns: nodes, relationships, variable lengths, named paths and shortest paths, as MATCH, CREATE and MERGE read them.'
---

# Patterns

A pattern draws part of a graph in text: nodes in parentheses, relationships in brackets between dashes. `MATCH`
finds it, `CREATE` makes it and `MERGE` does either. A pattern can also be a condition in `WHERE`, or make a list
(`[(a)-->(b) | b.name]`, in [expressions](./expressions)).

## Syntax

```railroad
pattern
pattern-part
pattern-element
node-pattern
relationship-pattern
relationship-detail
hops
shortest-path
properties
```

## Nodes

`(p:Person {name: 'Ada'})`: a variable, labels and properties, each optional. `()` is any node. Several labels mean
all of them. The properties may be a map or a parameter: `(p:Person $props)`.

```cypher
MATCH (p:Person {born: 1912})
RETURN p.name
```

| p.name |
| --- |
| Alan |

## Relationships

`-[k:KNOWS {since: 1833}]->` points right, `<-[…]-` left, and `-[…]-` either way. `-->`, `<--` and `--` are the
short forms with no detail. `[:KNOWS|LIKES]` is either type.

```cypher
MATCH (:Person {name: 'Edsger'})-[r:KNOWS|LIKES]-(x)
RETURN type(r) AS type, x.name AS other
ORDER BY type, other
```

| type | other |
| --- | --- |
| KNOWS | Alan |
| KNOWS | Barbara |
| KNOWS | Donald |
| KNOWS | Grace |
| LIKES | Algorithms |
| LIKES | Graphs |

## Variable length

`*` after the type follows a chain of relationships: `*` is one or more, `*2` exactly two, `*1..3` one to three,
`*..3` up to three and `*2..` two or more. The variable holds the list of relationships.

```cypher
MATCH (:Person {name: 'Ada'})-[ks:KNOWS*2]->(q)
RETURN q.name, [k IN ks | k.since] AS since
ORDER BY q.name
```

| q.name | since |
| --- | --- |
| Edsger | [1833,1940] |
| Grace | [1833,1936] |

## Named paths

`p = (…)` names the whole path: `nodes(p)`, `relationships(p)` and `length(p)` take it apart.

```cypher
MATCH p = (:Person {name: 'Ada'})-[:KNOWS*1..3]->(q:Person {name: 'Barbara'})
RETURN [n IN nodes(p) | n.name] AS names, length(p) AS hops
```

| names | hops |
| --- | --- |
| ["Ada","Alan","Edsger","Barbara"] | 3 |

## Shortest paths

`shortestPath(…)` finds one shortest path between two nodes, `allShortestPaths(…)` all of them. The pattern inside
has one relationship, usually variable length, and its ends are bound or found by the rest of the pattern.

```cypher
MATCH (a:Person {name: 'Ada'}), (b:Person {name: 'Radia'})
MATCH p = allShortestPaths((a)-[:KNOWS*]-(b))
RETURN [n IN nodes(p) | n.name] AS chain
```

| chain |
| --- |
| ["Ada","Alan","Edsger","Barbara","Radia"] |

A `WHERE` on the path is checked after the shortest paths are found, not during the search
([where it differs](../divergences)).

## Errors

A relationship variable can appear only once in a pattern:

<!-- docs:error SMALTCY_SEMANTIC -->
```cypher
MATCH (a)-[r]->(b)-[r]->(c) RETURN a
```

A relationship has one direction:

<!-- docs:error SMALTCY_SYNTAX -->
```cypher
MATCH (a)<-[:KNOWS]->(b) RETURN a
```

## Working demo

```cypher dataset=empty
CREATE (a:Stop {name: 'A'}), (b:Stop {name: 'B'}), (c:Stop {name: 'C'}), (d:Stop {name: 'D'}),
       (a)-[:ROAD]->(b), (b)-[:ROAD]->(d), (a)-[:ROAD]->(c), (c)-[:ROAD]->(d), (b)-[:ROAD]->(c);
MATCH p = (:Stop {name: 'A'})-[:ROAD*]->(:Stop {name: 'D'})
RETURN [s IN nodes(p) | s.name] AS route, length(p) AS roads
ORDER BY roads, route
```

| route | roads |
| --- | --- |
| ["A","B","D"] | 2 |
| ["A","C","D"] | 2 |
| ["A","B","C","D"] | 3 |

## See also

- [MATCH](./match), [CREATE](./create) and [MERGE](./merge), which read patterns.
- [Functions](../functions): `nodes`, `relationships`, `length`, `startNode`, `endNode`.
