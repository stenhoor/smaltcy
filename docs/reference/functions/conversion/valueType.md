---
description: 'The name of a value''s type: `NULL`, `BOOLEAN`, `INTEGER`, `FLOAT`, `STRING`, `LIST`, `MAP`, `NODE`, `RELATIONSHIP` or `PATH`.'
---

# valueType

```ebnf
valueType ::= 'valueType' '(' X ')'
```

The name of a value's type: `NULL`, `BOOLEAN`, `INTEGER`, `FLOAT`, `STRING`, `LIST`, `MAP`, `NODE`, `RELATIONSHIP` or `PATH`.

- A number is named by its value: a whole number is `INTEGER`, even when it was written `7.0`.

## Parameters

- `X`: any value

## Returns

A string.

## Examples

```cypher
MATCH p = (n:Person {name: 'Ada'})-[k:KNOWS]->()
RETURN valueType(n) AS node, valueType(k) AS relationship, valueType(p) AS path, valueType(n.born) AS born, valueType(1.5) AS float
```

| node | relationship | path | born | float |
| --- | --- | --- | --- | --- |
| NODE | RELATIONSHIP | PATH | INTEGER | FLOAT |

## See also

- [Conversion functions](./)
