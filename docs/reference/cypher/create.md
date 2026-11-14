---
description: 'CREATE makes nodes and relationships, with labels, a type and properties.'
---

# CREATE

`CREATE` makes the nodes and relationships of a pattern, once for each row it gets. A node in the pattern whose
variable is already bound isn't created again: the new relationships join it.

## Syntax

```railroad
create-clause
pattern
```

## Nodes

```cypher
CREATE (p:Person:Engineer {name: 'Linus', born: 1969})
RETURN p.name, labels(p) AS labels
```

| p.name | labels |
| --- | --- |
| Linus | ["Person","Engineer"] |

A property set to `null` isn't stored.

## Relationships

A relationship in `CREATE` needs exactly one type and a direction:

```cypher
MATCH (a:Person {name: 'Linus'}), (c:City {name: 'Boston'})
CREATE (a)-[r:LIVES_IN {since: 2004}]->(c)
RETURN a.name, type(r) AS type, r.since, c.name
```

| a.name | type | r.since | c.name |
| --- | --- | --- | --- |
| Linus | LIVES_IN | 2004 | Boston |

A whole path at once, new nodes and all:

```cypher
CREATE p = (:Topic {name: 'Kernels'})<-[:LIKES]-(:Person {name: 'Andrew', born: 1944})-[:KNOWS {since: 1991}]->(:Person {name: 'Bjarne', born: 1950})
RETURN length(p) AS relationships, [n IN nodes(p) | n.name] AS names
```

| relationships | names |
| --- | --- |
| 2 | ["Kernels","Andrew","Bjarne"] |

## One row each

`CREATE` runs for every row: after a `MATCH` that gives three rows, it creates three times.

```cypher
MATCH (p:Person)-[:LIVES_IN]->(:City {name: 'Austin'})
CREATE (p)-[:VISITED]->(:City {name: 'Zurich'})
RETURN p.name
```

| p.name |
| --- |
| Edsger |

## Errors

A relationship in `CREATE` needs a direction, and one type:

<!-- docs:error SMALTCY_SEMANTIC -->
```cypher
CREATE (:A)-[:R]-(:B)
```

<!-- docs:error SMALTCY_SEMANTIC -->
```cypher
CREATE (:A)-[:R|S]->(:B)
```

A variable-length relationship can't be created:

<!-- docs:error SMALTCY_SEMANTIC -->
```cypher
CREATE (:A)-[:R*2]->(:B)
```

## Working demo

```cypher dataset=empty
CREATE (london:City {name: 'London'}), (paris:City {name: 'Paris'}), (rome:City {name: 'Rome'}),
       (london)-[:TRAIN {hours: 2.5}]->(paris),
       (paris)-[:TRAIN {hours: 11}]->(rome);
MATCH p = (:City {name: 'London'})-[:TRAIN*]->(:City {name: 'Rome'})
RETURN [c IN nodes(p) | c.name] AS route, [t IN relationships(p) | t.hours] AS hours, length(p) AS legs
```

| route | hours | legs |
| --- | --- | --- |
| ["London","Paris","Rome"] | [2.5,11] | 2 |

## See also

- [MERGE](./merge): create only what isn't there.
- [Patterns](./patterns): what a pattern can say.
- [UNWIND](./unwind): creating from a list, one row each.
