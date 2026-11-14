---
description: 'DELETE removes relationships, nodes with none, and paths; DETACH DELETE removes a node with its relationships.'
---

# DELETE

`DELETE` removes relationships, and nodes that have no relationships left. `DETACH DELETE` removes a node with its
relationships. Both take nodes, relationships, paths, and lists of them; deleting `null` does nothing.

## Syntax

```railroad
delete-clause
```

## Relationships

```cypher
MATCH (:Person {name: 'Ada'})-[k:KNOWS]->(:Person {name: 'Alan'})
DELETE k
RETURN count(*) AS deleted
```

| deleted |
| --- |
| 1 |

## Nodes

A node with relationships needs `DETACH DELETE`:

```cypher
MATCH (p:Person {name: 'Tim'})
DETACH DELETE p
```

```cypher
MATCH (p:Person)
RETURN count(p) AS people
```

| people |
| --- |
| 11 |

## Errors

Deleting a node that still has relationships fails with `SMALTCY_CONSTRAINT`, and nothing the statement did stays:

<!-- docs:error SMALTCY_CONSTRAINT -->
```cypher
MATCH (p:Person {name: 'Alan'}) DELETE p
```

## Working demo

```cypher dataset=empty
CREATE (a:Doc {name: 'draft'})-[:LINKS]->(b:Doc {name: 'notes'}), (b)-[:LINKS]->(:Doc {name: 'final'});
MATCH (d:Doc {name: 'draft'})
DETACH DELETE d;
MATCH (d:Doc)
OPTIONAL MATCH (d)-[l:LINKS]->()
RETURN d.name AS doc, count(l) AS links
ORDER BY doc
```

| doc | links |
| --- | --- |
| final | 0 |
| notes | 1 |

## See also

- [REMOVE](./remove): properties and labels, not nodes.
- [Installation](/guide/getting-started#transactions): statements are atomic, and `transaction` groups several.
