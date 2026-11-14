---
description: 'History functions: Functions that read a graph''s history ([time travel](/guide/time-travel)): on a graph opened with `{ history: true }`, they describe the version the query reads, the latest unless `AT VERSION` or `AT TIME` names another.'
---

# History functions

Functions that read a graph's history ([time travel](/guide/time-travel)): on a graph opened with
`{ history: true }`, they describe the version the query reads, the latest unless `AT VERSION` or `AT TIME` names
another. On a graph without history they give `null`. They are smaltcy's own, not openCypher. The examples run on the
`ontology` sample graph, which has 26 versions.

## Functions {#functions}

- [`version`](./version): The version the query reads.
- [`commits`](./commits): Every commit up to the version read, oldest first, as maps: `version`, `time` (milliseconds), `at` (ISO 8601), `author`, `message`, `changes`, `nodes` and `relationships` (the totals after it), and its counts.
- [`commit`](./commit): One commit, as `commits()` gives it, or `null` when there's no such version.
- [`history`](./history): Every change to a node or relationship up to the version read, oldest first: its commit's fields, plus `change`, `key`, `old`, `new` and `label`.
