---
description: 'Every function smaltcy''s Cypher reads, by kind: graph, lists, strings, conversion, math, aggregates and history.'
---

# Functions

Every function smaltcy's Cypher reads, by kind, each with a page of its own. Function names match in any case:
`toUpper`, `TOUPPER` and `toupper` are one function. Unless its page says otherwise, a function given `null` returns
`null`, and an argument of the wrong type fails with `SMALTCY_TYPE`. An unknown function fails with
`SMALTCY_SEMANTIC`, and the wrong number of arguments with `SMALTCY_PLAN`.

## Graph {#graph}

- [`id`](./graph/id): The id of a node or relationship: the store's integer.
- [`elementId`](./graph/elementId): The id of a node or relationship as text: `n` and the id for a node, `r` and the id for a relationship.
- [`labels`](./graph/labels): A node's labels, as a list of strings.
- [`type`](./graph/type): A relationship's type.
- [`properties`](./graph/properties): The properties of a node or relationship, as a map. A map gives itself.
- [`keys`](./graph/keys): The property keys of a node or relationship, or the keys of a map, as a list of strings.
- [`startNode`](./graph/startNode): The node a relationship starts at.
- [`endNode`](./graph/endNode): The node a relationship ends at.
- [`nodes`](./graph/nodes): A path's nodes, in order, as a list.
- [`relationships`](./graph/relationships): A path's relationships, in order, as a list.
- [`length`](./graph/length): The number of relationships in a path. On a string or a list, its size.
- [`degree`](./graph/degree): The number of relationships at a node: `DIRECTION` is `'out'`, `'in'` or `'both'` (the default), and `TYPE` counts only that type.

## Lists {#lists}

- [`size`](./lists/size): The number of elements in a list, characters in a string, keys in a map, or relationships in a path.
- [`head`](./lists/head): A list's first element, or `null` for an empty list.
- [`last`](./lists/last): A list's last element, or `null` for an empty list.
- [`tail`](./lists/tail): A list without its first element.
- [`reverse`](./lists/reverse): A list in reverse order, or a string with its characters reversed.
- [`range`](./lists/range): The integers from `START` to `END`, both included, `STEP` apart (1 by default; negative counts down).
- [`isEmpty`](./lists/isEmpty): True when a list, string or map has nothing in it.

## Strings {#strings}

- [`toUpper`](./strings/toUpper): The text in upper case.
- [`toLower`](./strings/toLower): The text in lower case.
- [`trim`](./strings/trim): The text without white space at either end.
- [`ltrim`](./strings/ltrim): The text without white space at its start.
- [`rtrim`](./strings/rtrim): The text without white space at its end.
- [`substring`](./strings/substring): The part of the text from position `START` (the first is 0), `LENGTH` characters long, or to the end.
- [`left`](./strings/left): The first `N` characters of the text.
- [`right`](./strings/right): The last `N` characters of the text.
- [`replace`](./strings/replace): The text with every occurrence of `FIND` replaced by `WITH`.
- [`split`](./strings/split): The parts of the text between occurrences of `DELIMITER`, as a list.

## Conversion {#conversion}

- [`toString`](./conversion/toString): A number, boolean or string as text. A whole-number float keeps its point: `toString(2.0)` is `'2.0'`.
- [`toInteger`](./conversion/toInteger): A number, text or boolean as an integer, cut towards zero. Text that isn't a number gives `null`.
- [`toFloat`](./conversion/toFloat): A number or text as a float. Text that isn't a number gives `null`.
- [`toBoolean`](./conversion/toBoolean): `'true'` and `'false'` (in any case, around white space) as booleans, a number as `true` unless it's 0, and a boolean as itself. Other text gives `null`.
- [`valueType`](./conversion/valueType): The name of a value's type: `NULL`, `BOOLEAN`, `INTEGER`, `FLOAT`, `STRING`, `LIST`, `MAP`, `NODE`, `RELATIONSHIP` or `PATH`.

## Math {#math}

- [`abs`](./math/abs): The absolute value.
- [`ceil`](./math/ceil): The smallest whole number not less than `X`.
- [`floor`](./math/floor): The largest whole number not more than `X`.
- [`round`](./math/round): `X` rounded to the nearest whole number, or to `DIGITS` decimal places. Halves round away from zero.
- [`sqrt`](./math/sqrt): The square root; `NaN` for a negative number.
- [`sign`](./math/sign): -1, 0 or 1, as `X` is negative, zero or positive.
- [`exp`](./math/exp): *e* to the power `X`.
- [`log`](./math/log): The natural logarithm.
- [`log10`](./math/log10): The base-10 logarithm.
- [`sin`](./math/sin): The sine of an angle in radians.
- [`cos`](./math/cos): The cosine of an angle in radians.
- [`tan`](./math/tan): The tangent of an angle in radians.
- [`asin`](./math/asin): The arcsine, in radians.
- [`acos`](./math/acos): The arccosine, in radians.
- [`atan`](./math/atan): The arctangent, in radians.
- [`atan2`](./math/atan2): The angle, in radians, of the point (`X`, `Y`) from the x-axis.
- [`pi`](./math/pi): π.
- [`e`](./math/e): *e*, the base of natural logarithms.
- [`rand`](./math/rand): A random float from 0 up to, not including, 1: a new one each call.

## Aggregate {#aggregate}

- [`count`](./aggregate/count): The number of rows, with `*`, or of values that aren't `null`.
- [`sum`](./aggregate/sum): The sum of the values; 0 when there are none.
- [`avg`](./aggregate/avg): The mean of the values; `null` when there are none.
- [`min`](./aggregate/min): The smallest value, in Cypher's order; `null` when there are none.
- [`max`](./aggregate/max): The largest value, in Cypher's order; `null` when there are none.
- [`collect`](./aggregate/collect): The values as a list, in the order of the rows, without `null`s.
- [`stDev`](./aggregate/stDev): The standard deviation of a sample: divided by *n* - 1. 0 for fewer than two values.
- [`stDevP`](./aggregate/stDevP): The standard deviation of a whole population: divided by *n*. 0 for no values.

## History {#history}

- [`version`](./history/version): The version the query reads.
- [`commits`](./history/commits): Every commit up to the version read, oldest first, as maps: `version`, `time` (milliseconds), `at` (ISO 8601), `author`, `message`, `changes`, `nodes` and `relationships` (the totals after it), and its counts.
- [`commit`](./history/commit): One commit, as `commits()` gives it, or `null` when there's no such version.
- [`history`](./history/history): Every change to a node or relationship up to the version read, oldest first: its commit's fields, plus `change`, `key`, `old`, `new` and `label`.

## Other {#other}

- [`coalesce`](./other/coalesce): The first argument that isn't `null`, or `null` when they all are.
- [`exists`](./other/exists): True when a property is there (isn't `null`). `exists(n.key)` is `n.key IS NOT NULL`.
- [`timestamp`](./other/timestamp): The time now, in milliseconds since 1970 (UTC).

## Working demo

Functions of every kind in one query, on data it makes:

```cypher dataset=empty
CREATE (:City {name: '  london ', founded: 47}), (:City {name: 'paris', founded: -250}), (:City {name: 'rome', founded: -753});
MATCH (c:City)
WITH toUpper(left(trim(c.name), 1)) + substring(trim(c.name), 1) AS city, c.founded AS founded
RETURN city, abs(founded) AS years, CASE sign(founded) WHEN -1 THEN 'BC' ELSE 'AD' END AS era,
       size(city) AS letters, toString(round(2026 - founded, -2)) AS age_roughly
ORDER BY founded
```

| city | years | era | letters | age_roughly |
| --- | --- | --- | --- | --- |
| Rome | 753 | BC | 4 | 2800 |
| Paris | 250 | BC | 5 | 2300 |
| London | 47 | AD | 6 | 2000 |

## See also

- [Expressions](../cypher/expressions): operators, comprehensions and `CASE`.
- [Using the pieces](/guide/modules): `registerFunction` and `registerAggregate` add functions of your own.
