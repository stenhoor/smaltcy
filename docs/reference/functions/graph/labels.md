---
description: 'A node''s labels, as a list of strings.'
---

# labels

```ebnf
labels ::= 'labels' '(' NODE ')'
```

A node's labels, as a list of strings.

- A value of another type fails with `SMALTCY_TYPE`.

## Parameters

- `NODE`: a node

## Returns

A list of strings.

## Examples

```cypher dataset=family
MATCH (n)
WHERE n.name IN ['smaltdb', 'smaltql', 'OPFS']
RETURN n.name AS name, labels(n) AS labels
ORDER BY name
```

| name | labels |
| --- | --- |
| OPFS | ["Platform"] |
| smaltdb | ["Product","Engine"] |
| smaltql | ["Product","Language"] |

## See also

- [`type`](./type)
- [`keys`](./keys)
- [Graph functions](./)
