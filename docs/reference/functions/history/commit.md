---
description: 'One commit, as `commits()` gives it, or `null` when there''s no such version.'
---

# commit

```ebnf
commit ::= 'commit' '(' VERSION ')'
```

One commit, as `commits()` gives it, or `null` when there's no such version.

- A version that isn't a number fails with `SMALTCY_TYPE`.

## Parameters

- `VERSION`: an integer: a version number

## Returns

A map, or `null`.

## Examples

```cypher dataset=ontology
RETURN commit(2).message AS message, commit(2).author AS author, commit(99) AS none
```

| message | author | none |
| --- | --- | --- |
| Add the warehouse and the raw file store | ana | null |

## See also

- [`commits`](./commits)
- [History functions](./)
