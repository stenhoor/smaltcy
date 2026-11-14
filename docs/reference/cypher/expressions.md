---
description: 'Expressions: literals, parameters, properties, operators, lists, maps, CASE, comprehensions, quantifiers and pattern conditions.'
---

# Expressions

Expressions compute values: in `RETURN` and `WITH`, in `WHERE`, in properties, and as arguments. How tightly the
operators bind is in the [overview](./#how-tightly-operators-bind).

## Syntax

```railroad
expr
atom
binary-operator
literal
function-call
```

## Properties, indexes and slices

`n.key` reads a property of a node, relationship or map; a missing one is `null`. `n['key']` reads one by a computed
name. `list[i]` counts from 0, and from the end when negative; `list[a..b]` is the part from `a` up to, not including,
`b`.

```cypher
WITH {name: 'Ada', langs: ['en', 'fr', 'it']} AS m
RETURN m.name, m['langs'][0] AS first, m.langs[-1] AS last, m.langs[1..] AS rest, m.missing AS missing
```

| m.name | first | last | rest | missing |
| --- | --- | --- | --- | --- |
| Ada | en | it | ["fr","it"] | null |

## Arithmetic, strings and comparison

```cypher
RETURN 7 / 2 AS a, 7.0 / 2 AS b, 7 % 3 AS c, 2 ^ 10 AS d, 'graph' + 's' AS e, [1, 2] + [3] AS f
```

| a | b | c | d | e | f |
| --- | --- | --- | --- | --- | --- |
| 3 | 3.5 | 1 | 1024 | graphs | [1,2,3] |

```cypher
MATCH (p:Person)
WHERE p.name STARTS WITH 'A' OR p.name ENDS WITH 'y' OR p.name CONTAINS 'ad' OR p.name =~ 'K.n'
RETURN p.name
ORDER BY p.name
```

| p.name |
| --- |
| Ada |
| Alan |
| Ken |
| Radia |

Comparisons with `null` are `null`; `IS NULL` and `IS NOT NULL` test for it. `AND`, `OR`, `XOR` and `NOT` use three
values: `null AND false` is `false`, `null OR true` is `true`, and the rest with a `null` are `null`.

```cypher
RETURN null = null AS a, null IS NULL AS b, null AND false AS c, null OR true AS d, 1 IN [1, null] AS e, 2 IN [1, null] AS f
```

| a | b | c | d | e | f |
| --- | --- | --- | --- | --- | --- |
| null | true | false | true | true | null |

## CASE

```cypher
MATCH (p:Person)
RETURN p.name AS name,
       CASE WHEN p.born < 1900 THEN 'early' WHEN p.born < 1940 THEN 'middle' ELSE 'late' END AS era,
       CASE p.name WHEN 'Ada' THEN 'first' ELSE '' END AS note
ORDER BY p.born
LIMIT 4
```

| name | era | note |
| --- | --- | --- |
| Ada | early | first |
| Grace | middle |  |
| Alan | middle |  |
| John | middle |  |

## Lists and maps

```railroad
list-literal
map-literal
list-comprehension
pattern-comprehension
quantifier
```

A list comprehension filters and maps a list; a pattern comprehension makes a list from a pattern's matches. `any`,
`all`, `none` and `single` test the elements of a list.

```cypher
WITH [1, 2, 3, 4, 5, 6] AS xs
RETURN [x IN xs WHERE x % 2 = 0 | x * 10] AS evens, any(x IN xs WHERE x > 5) AS some, all(x IN xs WHERE x > 0) AS every, single(x IN xs WHERE x = 3) AS one
```

| evens | some | every | one |
| --- | --- | --- | --- |
| [20,40,60] | true | true | true |

```cypher
MATCH (p:Person {name: 'Alan'})
RETURN [(p)-[:KNOWS]->(q) | q.name] AS knows, [(p)<-[:KNOWS]-(q) WHERE q.born < 1900 | q.name] AS known_by
```

| knows | known_by |
| --- | --- |
| ["Grace","Edsger"] | ["Ada"] |

## Patterns as conditions

```railroad
pattern-predicate
exists-subquery
case-expr
```

A pattern in `WHERE` is true when it has a match. `EXISTS { … }` takes a pattern with its own `WHERE`. Here, the
people nobody knows who know someone born after 1950:

```cypher
MATCH (p:Person)
WHERE NOT (p)<-[:KNOWS]-() AND EXISTS { MATCH (p)-[:KNOWS]->(q) WHERE q.born > 1950 }
RETURN p.name
ORDER BY p.name
```

| p.name |
| --- |
| Margaret |
| Tim |

## Labels as conditions

`n:Label` is true when the node has the label.

```cypher
MATCH (n)-[:LIKES]->(t)
WHERE t:Topic AND n:Person
RETURN t.name AS topic, count(*) AS fans
ORDER BY fans DESC, topic
LIMIT 3
```

| topic | fans |
| --- | --- |
| Algorithms | 4 |
| Compilers | 3 |
| Languages | 3 |

## Errors

An unknown function fails with `SMALTCY_SEMANTIC`:

<!-- docs:error SMALTCY_SEMANTIC -->
```cypher
RETURN nope(1)
```

An aggregate belongs in `RETURN` or `WITH`, not in `WHERE`:

<!-- docs:error SMALTCY_SEMANTIC -->
```cypher
MATCH (p:Person) WHERE count(p) > 1 RETURN p
```

A missing parameter fails when the query runs, with `SMALTCY_PARAM`:

<!-- docs:error SMALTCY_PARAM -->
```cypher
RETURN $limit AS limit
```

## Working demo

```cypher dataset=empty
CREATE (:Order {id: 1, items: ['tea', 'cake'], total: 7.5, paid: true}),
       (:Order {id: 2, items: ['jam'], total: 5, paid: false}),
       (:Order {id: 3, items: [], total: 0, paid: null});
MATCH (o:Order)
RETURN o.id AS id,
       size(o.items) AS items,
       CASE WHEN o.paid IS NULL THEN 'unknown' WHEN o.paid THEN 'paid' ELSE 'due' END AS status,
       [i IN o.items | toUpper(i)] AS shouting,
       o.total * 1.2 AS with_tax
ORDER BY id
```

| id | items | status | shouting | with_tax |
| --- | --- | --- | --- | --- |
| 1 | 2 | paid | ["TEA","CAKE"] | 9 |
| 2 | 1 | due | ["JAM"] | 6 |
| 3 | 0 | unknown | [] | 0 |

## See also

- [Functions](../functions): every function, by kind.
- [Patterns](./patterns): the patterns a comprehension or a condition takes.
