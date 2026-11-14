---
description: '`''true''` and `''false''` (in any case, around white space) as booleans, a number as `true` unless it''s 0, and a boolean as itself. Other text gives `null`.'
---

# toBoolean

```ebnf
toBoolean ::= 'toBoolean' '(' X ')'
```

`'true'` and `'false'` (in any case, around white space) as booleans, a number as `true` unless it's 0, and a boolean as itself. Other text gives `null`.

- A `null` argument gives `null`. A value of another type fails with `SMALTCY_TYPE`.

## Examples

```cypher
RETURN toBoolean('TRUE') AS a, toBoolean(' false ') AS b, toBoolean(0) AS c, toBoolean('yes') AS d
```

| a | b | c | d |
| --- | --- | --- | --- |
| true | false | false | null |

## See also

- [`toString`](./toString)
- [Conversion functions](./)
