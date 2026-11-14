---
description: 'The parts of the text between occurrences of `DELIMITER`, as a list.'
---

# split

```ebnf
split ::= 'split' '(' STRING ',' DELIMITER ')'
```

The parts of the text between occurrences of `DELIMITER`, as a list.

## Parameters

- `STRING`: text
- `DELIMITER`: the text between the parts

## Returns

A list of strings.

## Examples

```cypher
RETURN split('London,New York,Austin', ',') AS cities
```

| cities |
| --- |
| ["London","New York","Austin"] |

## See also

- [`replace`](./replace)
- [String functions](./)
