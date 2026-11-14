---
description: 'Every change to a node or relationship up to the version read, oldest first: its commit''s fields, plus `change`, `key`, `old`, `new` and `label`.'
---

# history

```ebnf
history ::= 'history' '(' X ')'
```

Every change to a node or relationship up to the version read, oldest first: its commit's fields, plus `change`, `key`, `old`, `new` and `label`.

- A value of another type fails with `SMALTCY_TYPE`.

## Examples

```cypher dataset=ontology
MATCH (s:Dataset {name: 'orders'})
UNWIND history(s) AS h
RETURN h.version AS version, h.change AS change, h.key AS key, h.new AS new
```

| version | change | key | new |
| --- | --- | --- | --- |
| 4 | created | null | null |
| 14 | set | rows | 1900000 |
| 26 | set | rows | 2600000 |

## See also

- [`commits`](./commits)
- [History functions](./)
