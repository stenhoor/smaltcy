---
description: 'Every commit up to the version read, oldest first, as maps: `version`, `time` (milliseconds), `at` (ISO 8601), `author`, `message`, `changes`, `nodes` and `relationships` (the totals after it), and its counts.'
---

# commits

```ebnf
commits ::= 'commits' '(' ')'
```

Every commit up to the version read, oldest first, as maps: `version`, `time` (milliseconds), `at` (ISO 8601), `author`, `message`, `changes`, `nodes` and `relationships` (the totals after it), and its counts.

## Examples

```cypher dataset=ontology
UNWIND commits() AS c
WITH c WHERE c.version <= 3
RETURN c.version AS version, c.at AS at, c.author AS author, c.message AS message
```

| version | at | author | message |
| --- | --- | --- | --- |
| 1 | 2026-05-04T09:00:00.000Z | ana | Add the source systems |
| 2 | 2026-05-05T09:00:00.000Z | ana | Add the warehouse and the raw file store |
| 3 | 2026-05-07T09:00:00.000Z | ana | Add the teams |

## See also

- [`commit`](./commit)
- [`history`](./history)
- [History functions](./)
