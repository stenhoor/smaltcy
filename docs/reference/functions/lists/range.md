---
description: 'The integers from `START` to `END`, both included, `STEP` apart (1 by default; negative counts down).'
---

# range

```ebnf
range ::= 'range' '(' START ',' END (',' STEP)? ')'
```

The integers from `START` to `END`, both included, `STEP` apart (1 by default; negative counts down).

- Arguments that aren't integers, and a step of 0, fail with `SMALTCY_TYPE`. A range of more than ten million fails with `SMALTCY_UNSUPPORTED`.

## Parameters

- `START`: an integer: the first value
- `END`: an integer: the last value, included
- `STEP`: optional: a non-zero integer, 1 by default

## Returns

A list of integers.

## Examples

```cypher
RETURN range(1, 5) AS a, range(0, 10, 5) AS b, range(3, 1, -1) AS c, range(5, 1) AS d
```

| a | b | c | d |
| --- | --- | --- | --- |
| [1,2,3,4,5] | [0,5,10] | [3,2,1] | [] |

## See also

- [UNWIND](../../cypher/unwind)
- [List functions](./)
