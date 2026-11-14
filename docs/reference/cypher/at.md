---
description: 'AT VERSION and AT TIME read a graph as it was, for a graph that keeps its history. smaltcy''s own.'
---

# AT VERSION and AT TIME

`AT VERSION n` or `AT TIME t` before a query reads the graph as it was at that version, or at that time. They work on a
graph that keeps its history (`open({ history: true })`, [time travel](/guide/time-travel)); they aren't openCypher.

## Syntax

```railroad
at-clause
```

`n` is a version number, `t` ISO 8601 text or milliseconds since 1970; either may be a parameter. It applies to the
whole query, every part of a `UNION` included. The examples here
run on the `ontology` sample graph, which has its history: 26 versions.

```cypher dataset=ontology
AT VERSION 3
MATCH (n)
RETURN count(n) AS nodes
```

| nodes |
| --- |
| 7 |

```cypher dataset=ontology
AT TIME '2026-06-01'
MATCH (n)
RETURN count(n) AS nodes, version() AS version
```

| nodes | version |
| --- | --- |
| 24 | 13 |

The history functions say what changed: `version()`, `commits()`, `commit(v)` and `history(x)`.

```cypher dataset=ontology
UNWIND commits() AS c
RETURN c.version AS version, c.author AS author, c.message AS message
ORDER BY version DESC
LIMIT 3
```

| version | author | message |
| --- | --- | --- |
| 26 | chen | Update row counts |
| 25 | bo | Retire the funnel dashboard |
| 24 | bo | Sessions and the funnel hourly |

## Errors

A query that reads the past can't write:

<!-- docs:error SMALTCY_SEMANTIC -->
```cypher dataset=ontology
AT VERSION 3 MATCH (n) SET n.x = 1
```

`AT VERSION` takes a value or a parameter, not an expression:

<!-- docs:error SMALTCY_SEMANTIC -->
```cypher dataset=ontology
AT VERSION v.number MATCH (n) RETURN n
```

## Working demo

The ontology graph at version 5, by label. `AT VERSION` applies to the whole query, every part of a `UNION` too.

```cypher dataset=ontology
AT VERSION 5
MATCH (n)
RETURN labels(n)[0] AS label, count(*) AS nodes
ORDER BY label
```

| label | nodes |
| --- | --- |
| Dataset | 3 |
| System | 4 |
| Team | 3 |

## See also

- [Time travel](/guide/time-travel): keeping history, diffs and the timeline.
- [Functions](../functions): the history functions.
